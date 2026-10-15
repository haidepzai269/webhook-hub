import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { PassThrough } from 'stream';
import { HttpException } from '@nestjs/common';
import { ERROR_CATALOG } from '@hub/common';
import { ProviderEnum } from '@prisma/client';
import { DEMO_PROJECTS, disconnectSeedClient, SEED_DEFAULT_SOURCE_KEYS } from '@hub/database/seed';
import { apiSourceKey, generateSourceKey, SOURCE_KEY_RE } from '../src/modules/console/source-key';
import { ApiController } from '../src/modules/api/api.controller';
import { toErrorBody } from '../src/modules/errors/service-exception.filter';

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
/**
 * Thư mục tạm cho EDGE_PREFIX (edge.js đòi đường dẫn POSIX `^/…`). Windows: bỏ ký tự ổ đĩa, đổi `\` -> `/` — Node trên
 * Windows hiểu `/Users/…` là gốc ổ hiện tại, nên vẫn là đúng thư mục tạm (máy dev chạy từ ổ C:).
 */
const tmp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-'));
  return process.platform === 'win32' ? dir.replace(/^[A-Za-z]:/, '').split(path.sep).join('/') : dir;
};

function render(env: Record<string, string> = {}): string {
  const { vars } = edge.edgeVars(env, { listenPort: 8080, upstream: '127.0.0.1:4000', prefix: '/tmp/edge-nginx' });
  // Checkout Windows (autocrlf) cho template CRLF: chuẩn hoá để regex theo dòng của test giống trên Linux.
  return edge.renderTemplate(vars).split('\r\n').join('\n');
}

/**
 * Mô phỏng thứ tự chọn location của nginx (đủ cho template này): `=` khớp chính xác thắng ngay; nhớ prefix dài nhất;
 * rồi regex (`~` phân biệt hoa thường, `~*` không) THEO THỨ TỰ trong file — regex đầu tiên khớp thắng; không có thì
 * dùng prefix đã nhớ. (Template không dùng `^~`.)
 */
function pickLocation(conf: string, uri: string): string {
  const locs = [...conf.matchAll(/^\s*location (?:(=|~\*|~) )?(?:"([^"]+)"|(\S+)) \{/gm)].map((m) => ({ mod: m[1] ?? '', arg: m[2] ?? m[3], raw: m[0].trim().replace(/ \{$/, '').replace(/^location /, '') }));
  const exact = locs.find((l) => l.mod === '=' && l.arg === uri);
  if (exact) return exact.raw;
  const prefix = locs.filter((l) => l.mod === '' && !l.arg.startsWith('@') && uri.startsWith(l.arg)).sort((a, b) => b.arg.length - a.arg.length)[0];
  const rx = locs.find((l) => (l.mod === '~' || l.mod === '~*') && new RegExp(l.arg, l.mod === '~*' ? 'i' : '').test(uri));
  return (rx ?? prefix)?.raw ?? '';
}

afterAll(() => disconnectSeedClient?.());

/** TB-1 (review EG1 lượt 3): cách viết vòng của dải IPv4 quá rộng (< /8) — parseTrustProxy và edge.js phải cùng chặn. */
const WIDE_MAPPED = ['::ffff:0:0/96', '::ffff:0.0.0.0/97', '::ffff:0.0.0.0/100', '::ffff:0:0/103', '::FFFF:0:0/96', '::/16', '::/80', '0:0:0:0:0:ffff::/90'];
/** Dạng mapped nhưng hẹp (≥ /104 = IPv4 ≥ /8) hoặc địa chỉ đơn: vẫn hợp lệ. */
const NARROW_MAPPED = ['::ffff:10.0.0.0/104', '::ffff:a00:0/104', '::ffff:10.250.250.6', '::ffff:10.250.250.0/125', '2001:db8::/32'];

describe('EG1 — template nginx + envsubst', () => {
  it('[EG:T10] (phần g) 404 tĩnh /hooks của nginx và 404 của lớp hub-api cùng một câu `fix` (review EG1 lượt 4, Thấp-B)', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { HOOKS_NOT_FOUND_FIX } = require('../src/body-parsers');
    const loc = /location ~\* "\^\/hooks\(\/\|\$\)" \{[\s\S]*?return 404 '([^']*)'/.exec(TEMPLATE);
    expect(loc).not.toBeNull();
    expect(loc![1]).toContain(`"fix":"${HOOKS_NOT_FOUND_FIX}"`);
  });

  it('[EG:T3] (phần a) mọi sourceKey do seed, apiSourceKey (api_<uuid>), generateSourceKey (src_<provider>_<ulid>) và key tự đặt đúng SOURCE_KEY_RE đều khớp regex location /hooks/* — regex ĐỌC TỪ TEMPLATE, hàm sinh key là hàm THẬT', () => {
    const re: RegExp = edge.sourceKeyLocationRegex();
    // D13: luật key phía ghi (SOURCE_KEY_RE) TRÙNG ĐÚNG phần sourceKey của regex nginx — không chặt hơn, không lỏng hơn.
    const keyPart = /\/(\[[^\]]+\]\{\d+,\d+\})\$$/.exec(re.source)?.[1];
    expect(SOURCE_KEY_RE.source).toBe(`^${keyPart}$`);
    const providers = Object.values(ProviderEnum).filter((p) => p !== 'api');
    const keys: string[] = [
      ...SEED_DEFAULT_SOURCE_KEYS,
      ...DEMO_PROJECTS.map((p) => p.sourceKey),
      apiSourceKey(require('crypto').randomUUID()),
      ...providers.map((p) => generateSourceKey(p)),
      'abc',
      'a'.repeat(64),
      `src_${'x'.repeat(60)}`,
    ];
    const urls = keys.flatMap((k) => [...providers, 'api'].map((p) => `/hooks/${p}/${k}`));
    expect(urls.filter((u) => !re.test(u))).toEqual([]);
    // Key tự đặt hợp lệ (kể cả chữ hoa và `-`, client cũ đang gửi) qua được cả SOURCE_KEY_RE lẫn nginx.
    for (const k of ['a', 'abc', 'a'.repeat(64), 'src_x_1', '___', 'My-Key_01', 'ABC-def']) expect([k, SOURCE_KEY_RE.test(k), re.test(`/hooks/github/${k}`)]).toEqual([k, true, true]);
    for (const k of providers.map((p) => generateSourceKey(p))) expect([k, SOURCE_KEY_RE.test(k)]).toEqual([k, true]);
    // Lọc thô vẫn chặn đúng thứ cần chặn.
    for (const bad of ['/hooks/github/../etc/passwd', `/hooks/github/${'a'.repeat(65)}`, '/hooks/github/a.b', '/hooks/github/a/b', '/hooks/GitHub/k', '/hooks/github/']) {
      expect([bad, re.test(bad)]).toEqual([bad, false]);
    }
  });

  it('[EG:T3] (phần b) POST /api/v1/sources với sourceKey sai khuôn (`my.key`, 65 ký tự, số, `../x`, có dấu) -> 422 validation_failed field sourceKey (giống parseSourceInput / source-connection), KHÔNG chạm DB', async () => {
    const prisma: any = new Proxy({}, { get: () => { throw new Error('không được chạm DB'); } });
    const c = new ApiController(prisma);
    const prev = process.env.MASTER_KEY;
    process.env.MASTER_KEY = prev && prev.length >= 32 ? prev : 'k'.repeat(64);
    try {
      for (const bad of ['my.key', 'a'.repeat(65), 12345, '../x', 'khoá', 'a b']) {
        const e = await c.createSource('t', 'u', { provider: 'github', name: 'x', secret: 's'.repeat(24), sourceKey: bad }).then(() => null, (x) => x);
        expect(e).toBeInstanceOf(HttpException);
        expect([bad, e.getStatus()]).toEqual([bad, 422]);
        expect(toErrorBody(e, 'rid').body).toMatchObject({ error: 'validation_failed', field: 'sourceKey', requestId: 'rid' });
      }
    } finally {
      if (prev === undefined) delete process.env.MASTER_KEY;
      else process.env.MASTER_KEY = prev;
    }
  });

  it('[EG:T3] (phần c) khoá cứng định dạng key hub tự sinh: generateSourceKey = src_<provider>_<ulid 26 ký tự thường>, apiSourceKey = api_<uuid>', () => {
    for (const p of Object.values(ProviderEnum)) {
      expect([p, /^src_[a-z]+_[0-9a-hjkmnp-tv-z]{26}$/.test(generateSourceKey(p))]).toEqual([p, true]);
      expect(generateSourceKey(p).startsWith(`src_${p}_`)).toBe(true);
    }
    const id = require('crypto').randomUUID();
    expect(apiSourceKey(id)).toBe(`api_${id}`);
    expect(/^api_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(apiSourceKey(id))).toBe(true);
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
    expect(withFuse).toEqual(['~ "^/hooks/[a-z0-9-]+/[A-Za-z0-9_-]{1,64}$"', '~* "^/v1/p/"']);
    for (const l of ['= /health', '/socket.io/', '/']) expect(locs.find(([x]) => x === l)?.[1]).toBe(false);
  });

  it('[LH:T22] (LH2, R2-L1) lưới bật chỉ nới cầu chì + limit_conn cho IP thuộc dải Cloudflare (geo); IP khác gọi thẳng /hooks/* vẫn bị đếm', () => {
    const on = render({ EDGE_IP_FUSE: '1', CATCHNET_FORWARD_SECRET: 's'.repeat(40) });
    const geo = on.split('geo $edge_cf_ip {\n')[1]?.split('}')[0] ?? '';
    expect(geo).toMatch(/default 0;/);
    // Mỗi dòng dải = CIDR hợp lệ + giá trị 1; có cả IPv4 lẫn IPv6.
    const ranges = geo.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('default'));
    expect(ranges.length).toBeGreaterThanOrEqual(15);
    for (const l of ranges) expect(l).toMatch(/^([0-9.]+\/\d{1,2}|[0-9a-f:]+\/\d{1,3}) 1;$/);
    expect(ranges.some((l) => l.includes(':'))).toBe(true);
    // Không có dải quá rộng (nới cho cả Internet = R2-L1 quay lại).
    for (const l of ranges) {
      const [cidr] = l.split(' ');
      const bits = Number(cidr.split('/')[1]);
      expect(bits).toBeGreaterThanOrEqual(cidr.includes(':') ? 16 : 8);
    }
    // "0:0" (lưới bật, IP không phải Cloudflare) vẫn mang khoá IP; chỉ "0:1" rơi về default "".
    for (const [key, val] of [['edge_hooks_fuse_key', '$edge_fuse_key'], ['edge_hooks_conn_key', '$binary_remote_addr']]) {
      const block = on.split(`$${key} {\n`)[1]?.split('}')[0] ?? '';
      expect(block).toContain(`"0:0" ${val};`);
      expect(block).not.toMatch(/"0:1"/);
    }
    expect(TEMPLATE).not.toMatch(/\$http_x_catchnet/i);
  });

  it('[LH:T22] (REVIEW-LH3 TB-1) lưới hứng bật -> nginx tắt cầu chì + limit_conn theo IP cho /hooks/* (không tin x-catchnet-client-ip), /v1/p/* giữ; phản hồi nginx tự sinh trên /hooks* mang x-hub-outcome', () => {
    const SECRET = 's'.repeat(40);
    const block = (conf: string, head: string) => conf.split(`${head} {\n`)[1]?.split('}')[0] ?? '';
    const hooksLoc = 'location ~ "^/hooks/[a-z0-9-]+/[A-Za-z0-9_-]{1,64}$"';
    // Không có lưới (hoặc secret < 32 ký tự = hub cũng coi là tắt): như EG1 — khoá theo IP.
    for (const env of [{ EDGE_IP_FUSE: '1' }, { EDGE_IP_FUSE: '1', CATCHNET_FORWARD_SECRET: 'ngan' }]) {
      const conf = render(env);
      expect(conf).toMatch(/map "1:\$edge_cf_ip" \$edge_hooks_fuse_key \{\s*"~\^1:" \$edge_fuse_key;/);
      expect(conf).toMatch(/map "1:\$edge_cf_ip" \$edge_hooks_conn_key \{\s*"~\^1:" \$binary_remote_addr;/);
      expect(edge.edgeVars(env, { listenPort: 1, upstream: 'a:1', prefix: '/tmp/x' }).vars.EDGE_HOOKS_IP_LIMITS).toBe('1');
    }
    const on = render({ EDGE_IP_FUSE: '1', CATCHNET_FORWARD_SECRET: `ngan,${SECRET}` });
    expect(on).toMatch(/map "0:\$edge_cf_ip" \$edge_hooks_fuse_key \{\s*"~\^1:" \$edge_fuse_key;\s*"0:0" \$edge_fuse_key;\s*default "";/);
    expect(on).toMatch(/map "0:\$edge_cf_ip" \$edge_hooks_conn_key \{\s*"~\^1:" \$binary_remote_addr;\s*"0:0" \$binary_remote_addr;\s*default "";/);
    // Zone của /hooks/* và limit_conn khoá bằng map trên (rỗng = không đếm); /v1/p/* vẫn hooks_ip theo $edge_fuse_key.
    expect(on).toMatch(/limit_req_zone \$edge_hooks_fuse_key zone=hooks_path_ip:/);
    expect(on).toMatch(/limit_conn_zone \$edge_hooks_conn_key zone=hooks_conn:/);
    expect(on).toMatch(/limit_req_zone \$edge_fuse_key zone=hooks_ip:/);
    expect(block(on, hooksLoc)).toMatch(/limit_req zone=hooks_path_ip /);
    expect(block(on, 'location ~* "^/v1/p/"')).toMatch(/limit_req zone=hooks_ip /);
    // nginx KHÔNG BAO GIỜ đọc header lưới (không kiểm được chữ ký) — luật cứng trên template.
    expect(TEMPLATE).not.toMatch(/\$http_x_catchnet/i);
    // Secret không lọt vào cấu hình nginx (chỉ đọc độ dài).
    expect(on).not.toContain(SECRET);
    const w = edge.edgeVars({ EDGE_IP_FUSE: '1', EDGE_TRUSTED_PROXIES: '0.0.0.0/0', EDGE_REAL_IP_RECURSIVE: 'off', CATCHNET_FORWARD_SECRET: SECRET }, { listenPort: 1, upstream: 'a:1', prefix: '/tmp/x' }).warnings;
    expect(w).toEqual([expect.objectContaining({ level: 50, msg: expect.stringMatching(/lưới hứng/) })]);
    expect(edge.edgeVars({ CATCHNET_FORWARD_SECRET: SECRET }, { listenPort: 1, upstream: 'a:1', prefix: '/tmp/x' }).warnings).toEqual([]);
    expect(edge.catchnetOn({ CATCHNET_FORWARD_SECRET: ` ${SECRET} ` })).toBe(true);
    expect(edge.catchnetOn({ CATCHNET_FORWARD_SECRET: 'a,b,' + SECRET })).toBe(false); // giá trị thứ ba bị bỏ như hub-api
    // x-hub-outcome cho phản hồi nginx tự sinh — chỉ trên /hooks* (map theo $uri, ngoài /hooks = rỗng = không gắn).
    expect(block(on, 'location @edge_rate_limited')).toMatch(/add_header x-hub-outcome \$edge_outcome_refused always;/);
    expect(block(on, 'location @edge_upstream_unavailable')).toMatch(/add_header x-hub-outcome \$edge_outcome_unavailable always;/);
    expect(block(on, 'location @edge_payload_too_large')).toMatch(/add_header x-hub-outcome \$edge_outcome_rejected always;/);
    expect(block(on, 'location ~* "^/hooks(/|$)"')).toMatch(/add_header x-hub-outcome rejected always;/);
    for (const v of ['refused', 'rejected', 'unavailable']) {
      expect(on).toMatch(new RegExp(`map \\$uri \\$edge_outcome_${v} \\{\\s*"~\\*\\^/hooks\\(/\\|\\$\\)" ${v};\\s*default "";`));
    }
  });

  it('[EG:T10] (phần e) L0: path viết hoa (`/HOOKS/…`, `/Hooks/…`, `/V1/P/…`) KHÔNG đi vòng location được bảo vệ — express khớp route không phân biệt hoa thường (review EG1 lượt 3, TB-2): /hooks/* hoa -> 404 tĩnh, /v1/p/* hoa -> có cầu chì', () => {
    const conf = render();
    const HOOK_OK = '~ "^/hooks/[a-z0-9-]+/[A-Za-z0-9_-]{1,64}$"';
    const HOOK_404 = '~* "^/hooks(/|$)"';
    const V1P = '~* "^/v1/p/"';
    const cases: [string, string][] = [
      ['/hooks/github/src_github_main', HOOK_OK],
      ['/hooks/github/My-Key_01', HOOK_OK],
      ['/HOOKS/github/src_github_main', HOOK_404],
      ['/Hooks/github/k1', HOOK_404],
      ['/hOoKs/github/k1', HOOK_404],
      ['/HOOKS', HOOK_404],
      ['/hooks/github/a.b', HOOK_404],
      ['/hooks/GitHub/k', HOOK_404],
      ['/hooks/github/' + 'a'.repeat(65), HOOK_404],
      ['/v1/p/demo/events', V1P],
      ['/V1/P/demo/events', V1P],
      ['/v1/P/demo/events', V1P],
      ['/health', '= /health'],
      ['/socket.io/', '/socket.io/'],
      ['/api/v1/me', '/'],
      ['/hooksx', '/'],
    ];
    for (const [uri, want] of cases) expect([uri, pickLocation(conf, uri)]).toEqual([uri, want]);
    // Location 404 hoa/thường không proxy lên hub-api; location /v1/p/* hoa vẫn qua cầu chì.
    const block = (name: string) => conf.split(`location ${name} {\n`)[1]?.split('}')[0] ?? '';
    expect(block(HOOK_404)).toMatch(/return 404 '/);
    expect(block(HOOK_404)).not.toMatch(/proxy_pass/);
    expect(block(V1P)).toMatch(/limit_req zone=hooks_ip/);
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
    expect(bodies.map((b) => b.body.error).sort()).toEqual(['edge_rate_limited', 'not_found', 'payload_too_large', 'service_unavailable']);
    expect(out).toMatch(/error_page 502 504 =503 @edge_upstream_unavailable;/);
    // Location nào tự đặt proxy_set_header thì KHÔNG kế thừa header của server -> phải lặp đủ 4 header (review EG1 #1).
    const base = ['Host $http_host', 'X-Forwarded-For $remote_addr', 'X-Real-IP $remote_addr', 'X-Request-Id $edge_request_id'];
    for (const m of out.matchAll(/location (.*) \{\n([^}]*)\}/g)) {
      if (!/proxy_set_header/.test(m[2])) continue;
      for (const h of base) expect([m[1].trim(), m[2].includes(`proxy_set_header ${h};`)]).toEqual([m[1].trim(), true]);
    }
    // worker_shutdown_timeout dẫn từ EDGE_DRAIN_MS (nhỏ hơn 1 s), không viết cứng (review EG1 #7).
    expect(out).toMatch(/worker_shutdown_timeout 15s;/);
    expect(render({ EDGE_DRAIN_MS: '8000' })).toMatch(/worker_shutdown_timeout 7s;/);
    expect(render({ EDGE_DRAIN_MS: '0' })).toMatch(/worker_shutdown_timeout 1s;/);
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
    // Review EG1 #2: dải quá rộng + recursive on = lấy phần tử ĐẦU của XFF (IP giả) -> từ chối khởi động.
    for (const wide of ['0.0.0.0/0', '::/0', '0.0.0.0/0,::/0', '10.0.0.0/7', '2000::/15']) {
      expect(() => edge.realIpBlock({ EDGE_TRUSTED_PROXIES: wide })).toThrow(/quá rộng/);
      expect(edge.realIpBlock({ EDGE_TRUSTED_PROXIES: wide, EDGE_REAL_IP_RECURSIVE: 'off' })).toContain('real_ip_recursive off;');
    }
    expect(edge.realIpBlock({ EDGE_TRUSTED_PROXIES: '10.0.0.0/8,2001:db8::/16,1.2.3.4' })).toContain('real_ip_recursive on;');
    // TB-1: cùng luật với parseTrustProxy cho dạng IPv4-mapped (phần tử dạng chấm `::ffff:a.b.c.d` cũng được nhận).
    for (const wide of WIDE_MAPPED) expect(() => edge.realIpBlock({ EDGE_TRUSTED_PROXIES: wide })).toThrow(/quá rộng/);
    for (const ok of NARROW_MAPPED) expect(edge.realIpBlock({ EDGE_TRUSTED_PROXIES: ok })).toContain(`set_real_ip_from ${ok};`);
    // Thấp-1: chỉ gồm dấu phân cách = trống.
    expect(edge.realIpBlock({ EDGE_TRUSTED_PROXIES: ' , ' })).not.toMatch(/set_real_ip_from|real_ip_header/);
    expect(() => edge.edgeVars({ HUB_DOCS_URL: `x"}';` }, { listenPort: 1, upstream: 'a:1', prefix: '/tmp/x' })).toThrow(/HUB_DOCS_URL/);
    expect(() => edge.edgeVars({}, { listenPort: 1, upstream: 'a:1; evil', prefix: '/tmp/x' })).toThrow(/EDGE_UPSTREAM/);
    // Bật cầu chì mà không khai proxy tin cậy -> cảnh báo (đúng ở local, sai sau proxy Render).
    expect(edge.edgeVars({ EDGE_IP_FUSE: '1' }, { listenPort: 1, upstream: 'a:1', prefix: '/tmp/x' }).warnings).toEqual([expect.objectContaining({ level: 40, msg: expect.stringMatching(/EDGE_TRUSTED_PROXIES trống/) })]);
  });

  it('[EG:T11] (phần c) L0: hub-all EDGE_NGINX=1 (D11) hoặc Render (env RENDER) mà EDGE_TRUSTED_PROXIES trống -> TỪ CHỐI khởi động (fuse bật hay tắt); EDGE_ALLOW_NO_REAL_IP=1 cố ý vượt -> chạy kèm cảnh báo level 50; hub-all thoát với thông báo', () => {
    const opt = { listenPort: 1, upstream: 'a:1', prefix: '/tmp/x' };
    for (const fuse of ['0', '1']) expect(() => edge.edgeVars({ RENDER: 'true', EDGE_IP_FUSE: fuse }, opt)).toThrow(/EDGE_ALLOW_NO_REAL_IP/);
    const allowed = edge.edgeVars({ RENDER: 'true', EDGE_ALLOW_NO_REAL_IP: '1' }, opt).warnings;
    expect(allowed).toEqual([expect.objectContaining({ level: 50, msg: expect.stringMatching(/IP proxy/) })]);
    expect(edge.edgeVars({ RENDER: 'true', EDGE_TRUSTED_PROXIES: '0.0.0.0/0,::/0', EDGE_REAL_IP_RECURSIVE: 'off', EDGE_IP_FUSE: '1' }, opt).warnings).toEqual([]);
    expect(edge.edgeVars({}, opt).warnings).toEqual([]); // local, không fuse: im lặng
    const base = { DATABASE_URL: 'postgresql://u:p@h/db', PORT: '10000', EDGE_NGINX: '1', EDGE_PREFIX: tmp(), PATH: process.env.PATH ?? '' };
    expect(() => buildSpecs({ ...base, RENDER: 'true' })).toThrow(/EDGE_TRUSTED_PROXIES/);
    expect(() => buildSpecs(base)).toThrow(/EDGE_TRUSTED_PROXIES/); // D11: hub-all EDGE_NGINX=1 từ chối cả khi không phải Render
    // Thấp-1 (review lượt 3): chỉ gồm dấu phân cách = trống -> D11 vẫn chặn.
    for (const v of [' , ', ',', ' ,, ']) expect(() => buildSpecs({ ...base, EDGE_TRUSTED_PROXIES: v })).toThrow(/EDGE_TRUSTED_PROXIES/);
    expect(() => edge.edgeVars({ RENDER: 'true', EDGE_TRUSTED_PROXIES: ' , ' }, opt)).toThrow(/EDGE_ALLOW_NO_REAL_IP/);
    expect(buildSpecs({ ...base, RENDER: 'true' , EDGE_ALLOW_NO_REAL_IP: '1' }).warnings[0].level).toBe(50);
    // EDGE_NGINX tắt thì RENDER không ảnh hưởng gì [EG:T16].
    expect(buildSpecs({ DATABASE_URL: 'postgresql://u:p@h/db', RENDER: 'true' }).specs.map((x: any) => x.name)).toEqual(['api', 'worker']);
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
    expect(() => buildSpecs({ ...base, EDGE_NGINX: '1', EDGE_PREFIX: dir })).toThrow(/EDGE_TRUSTED_PROXIES/); // D11: trống -> từ chối
    const b = buildSpecs({ ...base, EDGE_NGINX: '1', EDGE_PREFIX: dir, MASTER_KEY: 'k'.repeat(40), EDGE_TRUSTED_PROXIES: '0.0.0.0/0,::/0', EDGE_REAL_IP_RECURSIVE: 'off' });
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
    expect(() => buildSpecs({ ...base, EDGE_NGINX: '1', EDGE_PREFIX: dir, PORT: '4000', EDGE_ALLOW_NO_REAL_IP: '1' })).toThrow(/trùng PORT/);
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
  const built = buildSpecs({ DATABASE_URL: 'postgresql://u:p@h/db', SHUTDOWN_TIMEOUT_MS: '25000', PORT: String(edgePort), EDGE_API_PORT: String(apiPort), EDGE_NGINX: '1', EDGE_PREFIX: tmp(), EDGE_ALLOW_NO_REAL_IP: '1', PATH: process.env.PATH ?? '', ...(real ? { EDGE_NGINX_BIN: real } : {}) }, { accessLog: logSink.accessLog });
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

// Windows không có SIGQUIT/SIGTERM thật cho tiến trình con (kill = TerminateProcess) -> chỉ chạy trên Linux (CI, image).
const itPosix = process.platform === 'win32' ? it.skip : it;
describe('EG1 — tắt máy (SIGQUIT)', () => {
  itPosix('[EG:T9] (phần b) SIGTERM supervisor -> nginx nhận SIGQUIT, worker SIGTERM; hub-api chỉ nhận SIGTERM SAU khi nginx thoát -> request đang chạy dài 3 s vẫn nhận 200; cả nhóm thoát 0 trước 25 s', async () => {
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

  itPosix('[EG:T9] (phần c) đối chứng: gửi SIGTERM cho hub-api CÙNG LÚC với nginx (không chờ) -> request đang chạy MẤT phản hồi: lý do hub-api phải chờ nginx', async () => {
    const r = await shutdownWhileSlowRequest(false);
    expect(r.res.status).not.toBe(200);
    expect(r.sent.edge).toBe('SIGQUIT');
  }, 40_000);
});

// ---- [EG:T11] (phần d) chuỗi THẬT nginx -> hub-api `trust proxy 1` (review EG1 #5) ---------------------------------------
// hub-api giả dùng ĐÚNG express của Nest + ĐÚNG hàm parseTrustProxy của main.ts (nạp từ source qua ts-node), env lấy từ buildSpecs
// (hub-all tự ép TRUST_PROXY=1). Chỉ có nghĩa với nginx thật -> cần EDGE_NGINX_BIN (CI job unit cài nginx; local: chạy
// trong image, DEPLOYMENT §3.6). Thay cho ca hub-all-e2e.sh (script đó thay hub-api của hubv dùng chung bằng hub-all).
const ROOT = path.resolve(__dirname, '../../..');
const ipEcho = (port: number) =>
  `const e=require(require.resolve('express',{paths:[require.resolve('@nestjs/platform-express')]}));const a=e();` +
  `require(${JSON.stringify(require.resolve('ts-node'))}).register({transpileOnly:true,compilerOptions:{module:'commonjs'}});` +
  `const tp=require(${JSON.stringify(path.resolve(__dirname, '../src/trust-proxy.ts'))}).parseTrustProxy(process.env.TRUST_PROXY);` +
  `if(tp!==undefined)a.set('trust proxy',tp);` +
  `a.use((q,r)=>r.json({ip:q.ip,xff:q.headers['x-forwarded-for']??null,realIp:q.headers['x-real-ip']??null,rid:q.headers['x-request-id']??null}));` +
  `a.listen(${port},'127.0.0.1');process.on('SIGTERM',()=>process.exit(0));`;

function getJson(port: number, p: string, headers: Record<string, string>): Promise<any> {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path: p, headers }, (res) => {
        let body = '';
        res.on('data', (d) => (body += d));
        res.on('end', () => resolve({ status: res.statusCode, ...JSON.parse(body || '{}') }));
      })
      .on('error', reject);
  });
}

async function withRealChain(extraEnv: Record<string, string>, fn: (edgePort: number) => Promise<void>) {
  const [edgePort, apiPort] = [await freePort(), await freePort()];
  const out = new PassThrough();
  const lines: string[] = [];
  out.on('data', (d) => lines.push(String(d)));
  const logSink = await startEdgeLogSink(out);
  const built = buildSpecs({ DATABASE_URL: 'postgresql://u:p@h/db', PORT: String(edgePort), EDGE_API_PORT: String(apiPort), EDGE_NGINX: '1', EDGE_PREFIX: tmp(), EDGE_NGINX_BIN: process.env.EDGE_NGINX_BIN!, PATH: process.env.PATH ?? '', ...extraEnv }, { accessLog: logSink.accessLog });
  const specs = built.specs.map((x: any) =>
    x.name === 'api' ? { ...x, cmd: process.execPath, args: ['-e', ipEcho(apiPort)], cwd: ROOT } : x.name === 'worker' ? { ...x, cmd: process.execPath, args: ['-e', drainer], cwd: undefined, env: { PATH: process.env.PATH } } : x,
  );
  let resolveExit!: (c: number) => void;
  const exited = new Promise<number>((r) => (resolveExit = r));
  const sup = supervise(specs, { timeoutMs: 10_000, log: (m: string) => lines.push(m), exit: resolveExit, stdout: out, stderr: out });
  try {
    try {
      await waitUp(edgePort);
      await waitUp(apiPort);
    } catch (e) {
      throw new Error(`${(e as Error).message}\n${lines.join('')}`);
    }
    await fn(edgePort);
  } finally {
    sup.stop('SIGTERM');
    await exited;
    logSink.close();
  }
}

describe('EG1 — chuỗi nginx thật -> trust proxy 1', () => {
  (process.env.EDGE_NGINX_BIN ? it : it.skip)('[EG:T11] (phần d) nginx THẬT + express trust proxy 1 (env từ buildSpecs): XFF giả 6.6.6.6 -> req.ip = IP kết nối ở /hooks, /socket.io, /api; cấu hình Render (0.0.0.0/0 + recursive off) -> req.ip = phần tử CUỐI do proxy thêm, không phải 6.6.6.6; x-request-id sai khuôn bị thay ở /socket.io', async () => {
    await withRealChain({ EDGE_ALLOW_NO_REAL_IP: '1' }, async (port) => {
      for (const p of ['/hooks/github/src_github_main', '/socket.io/?EIO=4&transport=polling', '/api/v1/me']) {
        const r = await getJson(port, p, { 'x-forwarded-for': '6.6.6.6', 'x-real-ip': '6.6.6.6', 'x-request-id': 'abc' });
        expect([p, r.status, r.ip, r.xff, r.realIp]).toEqual([p, 200, '127.0.0.1', '127.0.0.1', '127.0.0.1']);
        expect([p, /^[0-9a-f]{32}$/.test(r.rid)]).toEqual([p, true]);
      }
    });
    await withRealChain({ EDGE_TRUSTED_PROXIES: '0.0.0.0/0,::/0', EDGE_REAL_IP_RECURSIVE: 'off' }, async (port) => {
      for (const p of ['/hooks/github/src_github_main', '/socket.io/?EIO=4&transport=polling', '/api/v1/me']) {
        const r = await getJson(port, p, { 'x-forwarded-for': '6.6.6.6, 203.0.113.9' });
        expect([p, r.ip, r.xff]).toEqual([p, '203.0.113.9', '203.0.113.9']);
      }
      // TB-2: viết hoa không tới được hub-api (ipEcho trả 200 cho mọi path) -> 404 tĩnh của nginx.
      for (const p of ['/HOOKS/github/src_github_main', '/Hooks/github/k1']) {
        const r = await getJson(port, p, {});
        expect([p, r.status, r.error, r.ip]).toEqual([p, 404, 'not_found', undefined]);
      }
    });
  }, 40_000);
});

describe('EG1 — log UDP của nginx về supervisor', () => {
  it('[EG:T10] (phần d) L0: dòng syslog -> JSON + "proc":"edge"; stdout chậm (đệm vượt trần) -> BỎ dòng và báo số dòng đã bỏ', async () => {
    const dgram = require('dgram');
    const out = new PassThrough({ highWaterMark: 1 });
    const errs: string[] = [];
    const sink = await startEdgeLogSink(out, { maxBuffered: 200, log: (m: string) => errs.push(m) });
    const port = Number(/:(\d+),/.exec(sink.accessLog)![1]);
    const c = dgram.createSocket('udp4');
    const send = (m: string) => new Promise((r) => c.send(Buffer.from(m), port, '127.0.0.1', r));
    await send('<190>Oct 12 08:54:35 edge: {"uri_path":"/hooks/a/b","status":429,"limit_req_status":"REJECTED"}');
    await sleep(100);
    expect(JSON.parse(String(out.read()))).toEqual({ uri_path: '/hooks/a/b', status: 429, limit_req_status: 'REJECTED', proc: 'edge' });
    // Không ai đọc `out` -> writableLength tăng tới trần -> các dòng sau bị bỏ, không dồn RAM.
    for (let i = 0; i < 20; i++) await send(`<190>Oct 12 08:54:35 edge: {"i":${i},"pad":"${'x'.repeat(50)}"}`);
    await sleep(150);
    expect(sink.dropped()).toBeGreaterThan(0);
    expect(out.writableLength).toBeLessThan(200 + 200);
    // Đọc hết -> dòng kế tiếp kèm thông báo đã bỏ bao nhiêu dòng.
    while (out.read() !== null);
    await send('<190>Oct 12 08:54:36 edge: {"after":true}');
    await sleep(100);
    const rest = String(out.read() ?? '');
    expect(rest).toMatch(/bỏ \d+ dòng access log nginx/);
    expect(rest).toContain('"after":true');
    c.close();
    sink.close();
    expect(errs).toEqual([]);
  });
});


describe('TRUST_PROXY (review feat/edge: hub-api chỉ tin service edge ở compose)', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { parseTrustProxy } = require('../src/trust-proxy');
  it('[EG:T11] (phần e) L0: trống/0/số khác 1 -> không tin (như cũ); 1 -> một chặng (như cũ); danh sách IP/CIDR -> chỉ tin đúng các địa chỉ đó; sai khuôn (`true`, `yes`) hoặc dải quá rộng (v4 < /8, v6 < /16) -> lỗi; express với danh sách: client gọi THẲNG giả XFF không được tin, request từ IP edge thì được', () => {
    for (const v of [undefined, '', '0', '2', ' 0 ']) expect([v, parseTrustProxy(v)]).toEqual([v, undefined]);
    expect(parseTrustProxy('1')).toBe(1);
    expect(parseTrustProxy('10.250.250.6')).toEqual(['10.250.250.6']);
    expect(parseTrustProxy('10.250.250.0/29, ::1')).toEqual(['10.250.250.0/29', '::1']);
    for (const bad of ['edge', 'true', 'yes', '10.0.0.0/33', '0.0.0.0/0', '0.0.0.0/1', '10.0.0.0/7', '::/0', '2000::/15', '1.2.3', 'loopback']) expect(() => parseTrustProxy(bad)).toThrow(/TRUST_PROXY/);
    // Review EG1 lượt 3 (TB-1): dải rộng viết dạng IPv4-mapped IPv6 — proxy-addr quy về IPv4 (`range - 96`), và một dải
    // IPv6 chứa trọn ::ffff:0:0/96 thì tin MỌI IPv4. Chuẩn hoá về IPv4 rồi áp cùng luật /8.
    for (const bad of WIDE_MAPPED) expect(() => parseTrustProxy(bad)).toThrow(/TRUST_PROXY/);
    for (const ok of NARROW_MAPPED) expect(parseTrustProxy(ok)).toEqual([ok]);
    // Thấp-1: chỉ gồm dấu phân cách = trống (không tin ai), không phải danh sách rỗng.
    for (const v of [' , ', ',', ' ,, ']) expect([v, parseTrustProxy(v)]).toEqual([v, undefined]);
    expect(parseTrustProxy('10.0.0.0/8,2001:db8::/16')).toEqual(['10.0.0.0/8', '2001:db8::/16']);
    // Đúng ngữ nghĩa express (bản của Nest) với danh sách: compileTrust -> hàm tin theo địa chỉ chặng.
    const express = require(require.resolve('express', { paths: [require.resolve('@nestjs/platform-express')] }));
    const app = express();
    app.set('trust proxy', parseTrustProxy('10.250.250.6'));
    const trust = app.get('trust proxy fn');
    expect(trust('10.250.250.6', 0)).toBe(true);
    expect(trust('172.20.0.1', 0)).toBe(false); // host gọi thẳng :4000 qua gateway docker
    expect(trust('10.250.250.1', 0)).toBe(false);
    // TB-1: đối chứng bằng proxy-addr THẬT — mọi ca WIDE_MAPPED đúng là tin IP công khai (1.1.1.1) nếu lọt qua; các ca
    // NARROW_MAPPED được nhận thì không tin 1.1.1.1 / 8.8.8.8 (cả dạng peer dual-stack ::ffff:…).
    // Dải IPv6 chứa trọn ::ffff:0:0/96 (`::/16`…) thì proxy-addr 2.0.8 tự không cho khớp IPv4 và nginx so họ địa chỉ trước
    // — vẫn chặn PHÒNG XA (bản proxy-addr khác, cùng một luật cho hai bên), nên đối chứng chỉ áp cho dạng ::ffff:….
    for (const w of WIDE_MAPPED.filter((x) => /^::ffff:/i.test(x))) {
      const a = express();
      a.set('trust proxy', [w]);
      expect([w, a.get('trust proxy fn')('1.1.1.1', 0)]).toEqual([w, true]);
    }
    for (const n of NARROW_MAPPED) {
      const a = express();
      a.set('trust proxy', parseTrustProxy(n));
      const t = a.get('trust proxy fn');
      for (const ip of ['1.1.1.1', '8.8.8.8', '::ffff:8.8.8.8']) expect([n, ip, t(ip, 0)]).toEqual([n, ip, false]);
    }
  });
});
