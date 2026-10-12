import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { PassThrough } from 'stream';
import { ulid } from 'ulidx';
import { ERROR_CATALOG } from '@hub/common';
import { ProviderEnum } from '@prisma/client';
import { DEMO_PROJECTS, disconnectSeedClient, SEED_DEFAULT_SOURCE_KEYS } from '@hub/database/seed';

/**
 * EG1 (SPEC-chong-qua-tai §3, ADR-175/176): nginx là con thứ ba của docker/hub-all.js, cấu hình từ MỘT template.
 *
 * [EG:T9] chạy với nginx THẬT khi có EDGE_NGINX_BIN (trong image: `docker run … -e EDGE_NGINX_BIN=nginx`, xem
 * DEPLOYMENT "EG1 — kiểm tra"), không thì với nginx GIẢ bằng Node có đúng ngữ nghĩa tín hiệu của nginx
 * (SIGQUIT = graceful: ngừng nhận, trả nốt request đang proxy; SIGTERM = tắt nhanh, cắt ngang).
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const edge = require('../../../docker/nginx/edge.js');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { supervise, buildSpecs, edgeDrainMs, startEdgeLogSink } = require('../../../docker/hub-all.js');

const TEMPLATE = fs.readFileSync(edge.TEMPLATE, 'utf8');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'edge-'));

function render(env: Record<string, string> = {}): string {
  const { vars } = edge.edgeVars(env, { listenPort: 8080, upstream: '127.0.0.1:4000', prefix: '/tmp/edge-nginx' });
  return edge.renderTemplate(vars);
}

afterAll(() => disconnectSeedClient?.());

describe('EG1 — template nginx + envsubst', () => {
  it('[EG:T3] mọi sourceKey do seed, api-key-create (api_<uuid>) và bộ sinh key console (src_<provider>_<ulid>, key tự đặt ^[a-z0-9_]{3,64}$) đều khớp regex location /hooks/* — regex ĐỌC TỪ TEMPLATE', () => {
    const re: RegExp = edge.sourceKeyLocationRegex();
    expect(re.source).toContain('[A-Za-z0-9_-]{1,64}');
    const providers = Object.values(ProviderEnum).filter((p) => p !== 'api');
    const keys: string[] = [
      ...SEED_DEFAULT_SOURCE_KEYS,
      ...DEMO_PROJECTS.map((p) => p.sourceKey),
      `api_${require('crypto').randomUUID()}`,
      ...providers.map((p) => `src_${p}_${ulid().toLowerCase()}`),
      'abc',
      'a'.repeat(64),
      `src_${'x'.repeat(60)}`,
    ];
    const urls = keys.flatMap((k) => [...providers, 'api'].map((p) => `/hooks/${p}/${k}`));
    expect(urls.filter((u) => !re.test(u))).toEqual([]);
    // Lọc thô vẫn chặn đúng thứ cần chặn.
    for (const bad of ['/hooks/github/../etc/passwd', `/hooks/github/${'a'.repeat(65)}`, '/hooks/github/a.b', '/hooks/github/a/b', '/hooks/GitHub/k', '/hooks/github/']) {
      expect([bad, re.test(bad)]).toEqual([bad, false]);
    }
  });

  it('[EG:T10] (phần a) L0: EDGE_IP_FUSE mặc định TẮT (khoá rỗng = không đếm), bật = $binary_remote_addr; trần mặc định 50 r/s burst 500, conn 50; chỉ /hooks/* và /v1/p/* có limit_req; số kẹp trong khoảng', () => {
    const off = render();
    expect(off).toMatch(/map "0" \$edge_fuse_key/);
    expect(off).toMatch(/rate=50r\/s;/);
    expect(off).toMatch(/limit_req zone=hooks_ip burst=500 nodelay;/);
    expect(off).toMatch(/limit_conn hooks_conn 50;/);
    expect(render({ EDGE_IP_FUSE: '1' })).toMatch(/map "1" \$edge_fuse_key \{\s*"1" \$binary_remote_addr;/);
    const tuned = render({ EDGE_IP_FUSE: 'true', EDGE_IP_RATE: '7', EDGE_IP_BURST: '0', EDGE_CONN_PER_IP: '999999999' });
    expect(tuned).toMatch(/rate=7r\/s;/);
    expect(tuned).toMatch(/burst=0 nodelay;/);
    expect(tuned).toMatch(/limit_conn hooks_conn 100000;/);
    expect(render({ EDGE_IP_RATE: 'abc' })).toMatch(/rate=50r\/s;/);

    // Gom từng location -> có limit_req hay không.
    const locs = [...off.matchAll(/location (.*) \{\n([^}]*)\}/g)].map((m) => [m[1].trim(), /limit_req zone/.test(m[2])]);
    const withFuse = locs.filter(([, f]) => f).map(([l]) => l);
    expect(withFuse).toEqual(['~ "^/hooks/[a-z0-9-]+/[A-Za-z0-9_-]{1,64}$"', '/v1/p/']);
    for (const l of ['= /health', '/socket.io/', '/']) expect(locs.find(([x]) => x === l)?.[1]).toBe(false);
  });

  it('[EG:T10] (phần b) L0: envsubst chỉ thay danh sách biến cố định: $remote_addr/$request_id của nginx còn nguyên, secret trong env KHÔNG lọt vào file; trần body khớp ADR-162; body lỗi tĩnh là JSON đúng khuôn ERRORS.md', () => {
    process.env.EDGE_TEST_SECRET_MARKER = 'khong-duoc-lot-vao-nginx-conf';
    const out = render({ EDGE_TEST_SECRET_MARKER: 'x' });
    delete process.env.EDGE_TEST_SECRET_MARKER;
    expect(out).not.toContain('khong-duoc-lot-vao-nginx-conf');
    expect(out).toContain('$remote_addr');
    expect(out).toContain('$request_id');
    expect(out).toContain('proxy_set_header X-Forwarded-For $remote_addr;');
    expect(out).not.toMatch(/\$\{[A-Z_]+\}/);
    // ADR-162: /hooks 1 MB = MAX_INGEST_PAYLOAD_BYTES, còn lại 100 KB = MAX_API_BODY_BYTES (nginx: 1m = 1048576, 100k = 102400).
    const { MAX_INGEST_PAYLOAD_BYTES, MAX_API_BODY_BYTES } = require('@hub/common');
    expect([MAX_INGEST_PAYLOAD_BYTES, MAX_API_BODY_BYTES]).toEqual([1024 * 1024, 100 * 1024]);
    expect(out).toMatch(/^\s*client_max_body_size 100k;/m);
    expect(out).toMatch(/\{1,64\}\$" \{[^}]*client_max_body_size 1m;/);
    // Không sửa body: không gzip/sub_filter.
    expect(out).not.toMatch(/^\s*(gzip|sub_filter|proxy_set_body)\b/m);

    const bodies = [...out.matchAll(/return (\d{3}) '([^']+)';/g)].map((m) => ({ status: Number(m[1]), body: JSON.parse(m[2].replace(/\$edge_request_id/g, 'rid')) }));
    expect(bodies.map((b) => b.body.error).sort()).toEqual(['edge_rate_limited', 'not_found', 'payload_too_large']);
    for (const b of bodies) {
      const entry = (ERROR_CATALOG as Record<string, { status: number; message: string }>)[b.body.error];
      expect([b.body.error, entry?.status, entry?.message]).toEqual([b.body.error, b.status, b.body.message]);
      expect(b.body.docsUrl).toBe(`docs/ERRORS.md#${b.body.error}`);
      expect(b.body.requestId).toBe('rid');
      expect(typeof b.body.fix).toBe('string');
    }
  });

  it('[EG:T11] (phần a) L0: IP thật: EDGE_TRUSTED_PROXIES trống = không tin XFF; có danh sách = set_real_ip_from + recursive; phần tử lạ (chèn cấu hình) -> lỗi; HUB_DOCS_URL có nháy -> lỗi', () => {
    expect(edge.realIpBlock({})).not.toMatch(/set_real_ip_from|real_ip_header/);
    expect(edge.realIpBlock({ EDGE_TRUSTED_PROXIES: '10.0.0.0/8, 2001:db8::/32 192.168.1.7' }).split('\n')).toEqual([
      '    set_real_ip_from 10.0.0.0/8;',
      '    set_real_ip_from 2001:db8::/32;',
      '    set_real_ip_from 192.168.1.7;',
      '    real_ip_header X-Forwarded-For;',
      '    real_ip_recursive on;',
    ]);
    expect(edge.realIpBlock({ EDGE_TRUSTED_PROXIES: '0.0.0.0/0,::/0', EDGE_REAL_IP_RECURSIVE: 'off' })).toContain('real_ip_recursive off;');
    for (const bad of ['10.0.0.0/8; include /etc/passwd', '1.2.3.4/33', 'render', '10.0.0.0/8/1', '300.1.1.1']) {
      expect(() => edge.realIpBlock({ EDGE_TRUSTED_PROXIES: bad })).toThrow(/EDGE_TRUSTED_PROXIES/);
    }
    expect(() => edge.realIpBlock({ EDGE_TRUSTED_PROXIES: '10.0.0.0/8', EDGE_REAL_IP_RECURSIVE: 'maybe' })).toThrow(/on\|off/);
    expect(() => edge.edgeVars({ HUB_DOCS_URL: `x"}';` }, { listenPort: 1, upstream: 'a:1', prefix: '/tmp/x' })).toThrow(/HUB_DOCS_URL/);
    expect(() => edge.edgeVars({}, { listenPort: 1, upstream: 'a:1; evil', prefix: '/tmp/x' })).toThrow(/EDGE_UPSTREAM/);
    // Bật cầu chì mà không khai proxy tin cậy -> cảnh báo (đúng ở local, sai sau proxy Render).
    expect(edge.edgeVars({ EDGE_IP_FUSE: '1' }, { listenPort: 1, upstream: 'a:1', prefix: '/tmp/x' }).warnings.join()).toMatch(/EDGE_TRUSTED_PROXIES trống/);
  });
});

describe('EG1 — hub-all.js', () => {
  const base = { DATABASE_URL: 'postgresql://hub_app:p@h/db', SHUTDOWN_TIMEOUT_MS: '25000', PORT: '10000', PATH: process.env.PATH ?? '' };

  it('[EG:T16] EDGE_NGINX không bật (thiếu / 0 / false) -> đúng hai con api + worker như trước EG1: không nginx, hub-api không HOST, PORT/TRUST_PROXY giữ nguyên', () => {
    for (const flag of [undefined, '0', 'false', '']) {
      const env: Record<string, string> = { ...base, TRUST_PROXY: '1' };
      if (flag !== undefined) env.EDGE_NGINX = flag;
      const b = buildSpecs(env);
      expect(b.specs.map((s: any) => s.name)).toEqual(['api', 'worker']);
      const [api, worker] = b.specs;
      expect(api.args[1]).toBe('dist/apps/hub-api/src/main.js');
      expect(worker.args[1]).toBe('dist/apps/hub-worker/src/main.js');
      expect(api.env.HOST).toBeUndefined();
      expect(api.env.PORT).toBe('10000');
      expect(api.env.TRUST_PROXY).toBe('1');
      expect(api.stopAfter).toBeUndefined();
      expect(api.stopSignal).toBeUndefined();
      expect(b.timeoutMs).toBe(25000);
    }
  });

  it('[EG:T9] (phần a) cấu hình: EDGE_NGINX=1 -> con thứ ba `edge` (SIGQUIT), hub-api 127.0.0.1:EDGE_API_PORT + TRUST_PROXY=1, chờ nginx tối đa EDGE_DRAIN_MS (kẹp để còn ≥ 6 s trước SIGKILL); nginx không nhận env (secret) của container', () => {
    const dir = tmp();
    const b = buildSpecs({ ...base, EDGE_NGINX: '1', EDGE_PREFIX: dir, MASTER_KEY: 'k'.repeat(40) });
    expect(b.specs.map((s: any) => s.name)).toEqual(['edge', 'api', 'worker']);
    const [nginx, api] = b.specs;
    expect(nginx.stopSignal).toBe('SIGQUIT');
    expect(nginx.args).toEqual(['-e', 'stderr', '-p', dir, '-c', path.join(dir, 'nginx.conf'), '-g', 'daemon off;']);
    expect(Object.keys(nginx.env)).toEqual(['PATH']);
    expect(api.env).toMatchObject({ HOST: '127.0.0.1', PORT: '4000', TRUST_PROXY: '1' });
    expect(api.stopAfter).toBe('edge');
    expect(api.stopAfterMaxMs).toBe(16000);
    const conf = fs.readFileSync(path.join(dir, 'nginx.conf'), 'utf8');
    expect(conf).toMatch(/listen 10000 default_server;/);
    expect(conf).toMatch(/server 127\.0\.0\.1:4000;/);
    expect(edgeDrainMs({ EDGE_DRAIN_MS: '60000' }, 25000)).toBe(19000);
    expect(() => buildSpecs({ ...base, EDGE_NGINX: '1', EDGE_PREFIX: dir, PORT: '4000' })).toThrow(/trùng PORT/);
  });
});

// ---- [EG:T9] tắt máy thật: request dài 3 s đang chạy qua nginx vẫn nhận phản hồi --------------------------------------

/** hub-api giả: mỗi request trả 200 sau 3 s; SIGTERM -> thoát NGAY (giống shutdown.ts: không drain HTTP). */
const slowApi = (port: number) =>
  `const h=require('http');const s=h.createServer((q,r)=>setTimeout(()=>{r.writeHead(200,{'content-type':'text/plain'});r.end('slow-ok')},3000));` +
  `s.listen(${port},'127.0.0.1',()=>console.log('api up'));process.on('SIGTERM',()=>process.exit(0));`;
const drainer = `process.on('SIGTERM',()=>setTimeout(()=>process.exit(0),50));setInterval(()=>{},1000);`;
/** nginx giả (khi không có EDGE_NGINX_BIN): proxy Node; SIGQUIT = ngừng nhận + trả nốt; SIGTERM = cắt ngang. */
const fakeNginx = (listen: number, upstream: number) =>
  `const h=require('http');const s=h.createServer((q,r)=>{const u=h.request({host:'127.0.0.1',port:${upstream},path:q.url,method:q.method,headers:q.headers},(x)=>{r.writeHead(x.statusCode,x.headers);x.pipe(r)});u.on('error',()=>{r.writeHead(502);r.end('bad gateway')});q.pipe(u)});` +
  `s.listen(${listen},'127.0.0.1',()=>console.log('edge up'));` +
  `process.on('SIGQUIT',()=>{console.log('got SIGQUIT');s.close(()=>process.exit(0))});process.on('SIGTERM',()=>{console.log('got SIGTERM');process.exit(0)});`;

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitUp(port: number): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const ok = await new Promise<boolean>((r) => {
      const c = net.connect(port, '127.0.0.1');
      c.once('connect', () => (c.destroy(), r(true)));
      c.once('error', () => r(false));
    });
    if (ok) return;
    await sleep(100);
  }
  throw new Error(`cổng ${port} không lên`);
}
function get(port: number, p: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path: p }, (res) => {
        let body = '';
        res.on('data', (d) => (body += d));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      })
      .on('error', reject);
  });
}

async function shutdownWhileSlowRequest(sequenced: boolean) {
  const [edgePort, apiPort] = [await freePort(), await freePort()];
  const real = process.env.EDGE_NGINX_BIN;
  const out = new PassThrough();
  const lines: string[] = [];
  out.on('data', (d) => lines.push(...String(d).split('\n').filter(Boolean)));
  const logSink = await startEdgeLogSink(out);
  const built = buildSpecs({ DATABASE_URL: 'postgresql://u:p@h/db', SHUTDOWN_TIMEOUT_MS: '25000', PORT: String(edgePort), EDGE_API_PORT: String(apiPort), EDGE_NGINX: '1', EDGE_PREFIX: tmp(), PATH: process.env.PATH ?? '', ...(real ? { EDGE_NGINX_BIN: real } : {}) }, { accessLog: logSink.accessLog });
  const specs = built.specs.map((s: any) => {
    if (s.name === 'api') return { ...s, cmd: process.execPath, args: ['-e', slowApi(apiPort)], cwd: undefined, env: { PATH: process.env.PATH }, ...(sequenced ? {} : { stopAfter: undefined }) };
    if (s.name === 'worker') return { ...s, cmd: process.execPath, args: ['-e', drainer], cwd: undefined, env: { PATH: process.env.PATH } };
    return real ? s : { ...s, cmd: process.execPath, args: ['-e', fakeNginx(edgePort, apiPort)] };
  });
  const logs: string[] = [];
  let resolveExit!: (c: number) => void;
  const exited = new Promise<number>((r) => (resolveExit = r));
  const sup = supervise(specs, { timeoutMs: built.timeoutMs, log: (m: string) => logs.push(m), exit: resolveExit, stdout: out, stderr: out });
  try {
    await waitUp(edgePort);
    await waitUp(apiPort);
  } catch (e) {
    sup.stop('SIGTERM');
    throw new Error(`${(e as Error).message}\n${[...lines, ...logs].join('\n')}`);
  }
  const t0 = Date.now();
  const pending = get(edgePort, '/hooks/github/src_github_main').then(
    (r) => r,
    (e) => ({ status: -1, body: String(e?.code ?? e) }),
  );
  await sleep(500); // request đang nằm ở hub-api (còn ~2,5 s)
  sup.stop('SIGTERM');
  const res = await pending;
  const code = await exited;
  await sleep(200);
  logSink.close();
  return { res, code, ms: Date.now() - t0, logs, lines, real: !!real, sent: Object.fromEntries(sup.children.map((c: any) => [c.name, c.sentSignal])) };
}

describe('EG1 — tắt máy (SIGQUIT)', () => {
  it('[EG:T9] (phần b) SIGTERM supervisor -> nginx nhận SIGQUIT, worker SIGTERM; hub-api chỉ nhận SIGTERM SAU khi nginx thoát -> request đang chạy dài 3 s vẫn nhận 200; cả nhóm thoát 0 trước 25 s', async () => {
    const r = await shutdownWhileSlowRequest(true);
    console.log(`T9 nginx ${r.real ? 'THẬT' : 'giả (Node)'}: ${r.res.status} sau ${r.ms} ms, exit ${r.code}`);
    expect(r.res).toEqual({ status: 200, body: 'slow-ok' });
    expect(r.sent).toEqual({ edge: 'SIGQUIT', api: 'SIGTERM', worker: 'SIGTERM' });
    expect(r.code).toBe(0);
    expect(r.ms).toBeGreaterThanOrEqual(2000);
    expect(r.ms).toBeLessThan(25_000);
    if (!r.real) expect(r.lines.join('\n')).toMatch(/\[edge\] got SIGQUIT/);
    // nginx thật: access log (syslog UDP -> supervisor) có dòng JSON của request, gắn "proc":"edge".
    if (r.real) expect(r.lines.map((l) => (l.startsWith('{') ? JSON.parse(l) : {})).find((j) => j.uri_path === '/hooks/github/src_github_main')).toMatchObject({ proc: 'edge', status: 200, method: 'GET', ip: '127.0.0.1' });
  }, 40_000);

  it('[EG:T9] (phần c) đối chứng: gửi SIGTERM cho hub-api CÙNG LÚC với nginx (không chờ) -> request đang chạy MẤT phản hồi: lý do hub-api phải chờ nginx', async () => {
    const r = await shutdownWhileSlowRequest(false);
    expect(r.res.status).not.toBe(200);
    expect(r.sent.edge).toBe('SIGQUIT');
  }, 40_000);
});
