/**
 * EG1 (SPEC-chong-qua-tai §3, §8 — L2 trên hubv, ADR-175/176): cửa vào nginx (service `edge`, :18080 -> hub-api) và
 * `edge-sink` (:18090 -> sink, chỉ hubv) — cùng image, cùng docker/nginx/nginx.conf.template với hub-all trên Render.
 * hubv đặt trần THẤP cho edge (EDGE_IP_RATE=5, EDGE_IP_BURST=10, docker-compose.verify.yml) để chạm cầu chì nhanh.
 *
 * Thứ tự kịch bản có chủ đích: T2 -> T11 -> T10 (T10 cố tình làm cầu chì nổ; chạy cuối để không ảnh hưởng hai cái trước).
 * Chạy riêng: `npm run verify:e2e -- --tag EG1`. KHÔNG import code hub (hub-sim ký độc lập).
 */
import Redis from 'ioredis';
import { loadFixture, prepare } from '../../tools/hub-sim/src/fixture';
import { composeOutput, hostUrls } from '../lib/compose';
import { RUN, simSecret, sleep, SINK, uniq } from '../lib/e2e-world';
import { expect } from '../lib/http-session';
import { ScenarioFile, waitFor } from '../lib/scenario';

const EDGE = process.env.VERIFY_EDGE_URL || 'http://localhost:18080';
const EDGE_SINK = process.env.VERIFY_EDGE_SINK_URL || 'http://localhost:18090';

/**
 * Nguồn SEED của hubv (tenant default, secret = GITHUB_WEBHOOK_SECRET / PAYOS_CHECKSUM_KEY của .env.verify — đúng secret
 * hub-sim dùng). Không đăng ký dev mới: kịch bản chỉ kiểm cửa vào, không kiểm luồng tài khoản (và không phụ thuộc thư
 * mục mail capture của cây đã dựng hubv).
 */
const SOURCES = { github: '/hooks/github/src_github_main', payos: '/hooks/payos/src_payos_main' } as const;

/** Ký fixture bằng secret giả của hubv rồi POST qua `base` (edge hoặc edge-sink). */
async function sendVia(base: string, fixtureId: string, path: string, extraHeaders: Record<string, string> = {}) {
  const f = loadFixture(fixtureId);
  const p = prepare(f, simSecret(f.provider), { unique: uniq() });
  const r = await fetch(`${base}${path}`, { method: 'POST', headers: { ...p.headers, ...extraHeaders }, body: new Uint8Array(p.body) });
  return { status: r.status, text: await r.text(), headers: r.headers, sent: p };
}

async function sinkRequests(path: string): Promise<any[]> {
  const r = await fetch(`${SINK}/_requests?path=${encodeURIComponent(path)}`);
  const j = (await r.json()) as any;
  return Array.isArray(j) ? j : (j.requests ?? []);
}

/** Dòng log JSON của nginx (proc edge) từ `docker compose logs`. */
function edgeLogLines(service: string, sinceIso: string): any[] {
  const r = composeOutput(['logs', '--no-log-prefix', '--since', sinceIso, service], 30_000);
  return r.stdout
    .split('\n')
    .filter((l) => l.startsWith('{'))
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

const file: ScenarioFile = {
  file: 'verify/scenarios/edge-e2e.ts',
  scenarios: [
    {
      name: '[EG:T2] webhook GitHub + PayOS ký thật (hub-sim) ĐI QUA nginx -> 200 (bytes không đổi, verify đúng); edge-sink nhận đúng từng byte + header chữ ký; body 1MB + 1 byte -> 413 payload_too_large của nginx, đúng 1MB thì nginx cho qua',
      tags: ['EG1'],
      fn: async () => {
        for (const [p, fx] of [['github', 'github/push'], ['payos', 'payos/paid-69000']] as const) {
          const r = await sendVia(EDGE, fx, SOURCES[p]);
          expect(r.status === 200, `${fx} qua edge -> ${r.status} ${r.text.slice(0, 200)}`);
        }
        const bad = await sendVia(EDGE, 'payos/bad-sig', SOURCES.payos);
        expect(bad.status === 401, `payos/bad-sig qua edge -> ${bad.status} (mong 401: nginx không "sửa" được chữ ký sai thành đúng)`);

        const path = `/hooks/github/eg_t2_${RUN}`;
        const viaSink = await sendVia(EDGE_SINK, 'github/push', path);
        expect(viaSink.status === 200, `edge-sink -> ${viaSink.status}`);
        const got = (await sinkRequests(path)).pop();
        expect(got, 'sink không nhận được request qua edge-sink');
        expect(got.body === viaSink.sent.body.toString('utf8'), 'body tới upstream KHÁC body đã ký');
        expect(got.headers['x-hub-signature-256'] === viaSink.sent.headers['x-hub-signature-256'], 'header chữ ký bị đổi');
        expect(got.headers['content-type'] === viaSink.sent.headers['content-type'], `content-type bị đổi: ${got.headers['content-type']}`);

        const big = await fetch(`${EDGE}${SOURCES.github}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: new Uint8Array(1024 * 1024 + 1) });
        const bigBody = (await big.json().catch(() => ({}))) as any;
        expect(big.status === 413 && bigBody.error === 'payload_too_large' && bigBody.requestId, `1MB+1 -> ${big.status} ${JSON.stringify(bigBody)}`);
        const exact = await fetch(`${EDGE_SINK}/hooks/github/eg_t2_exact_${RUN}`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: new Uint8Array(1024 * 1024) });
        expect(exact.status === 200, `đúng 1MB qua edge-sink -> ${exact.status} (nginx không được cắt)`);
      },
    },
    {
      name: '[EG:T11] (phần b) L2: IP thật: X-Forwarded-For/X-Real-IP giả 6.6.6.6 -> upstream nhận XFF = X-Real-IP = IP kết nối (GHI ĐÈ, không nối) ở /hooks VÀ /socket.io, log nginx ip ≠ 6.6.6.6; x-request-id client hợp lệ giữ nguyên, thiếu/rác thì nginx đặt; hub-api qua edge: req.ip = IP client nginx thấy (khoá rl:login:ip), không phải IP edge hay 6.6.6.6; gọi thẳng hub-api với XFF giả không được tin',
      tags: ['EG1'],
      fn: async () => {
        const since = new Date(Date.now() - 1000).toISOString();
        const spoof = { 'x-forwarded-for': '6.6.6.6', 'x-real-ip': '6.6.6.6' };
        const path = `/hooks/github/eg_t11_${RUN}`;
        const mine = `eg-t11-${RUN}`;
        await sendVia(EDGE_SINK, 'github/ping', path, { ...spoof, 'x-request-id': mine });
        await sendVia(EDGE_SINK, 'github/ping', path, spoof);
        await sendVia(EDGE_SINK, 'github/ping', path, { ...spoof, 'x-request-id': 'rac co dau cach' });
        const reqs = (await sinkRequests(path)).slice(-3);
        expect(reqs.length === 3, `sink nhận ${reqs.length}/3 request`);
        for (const r of reqs) {
          const xff = String(r.headers['x-forwarded-for'] ?? '');
          expect(xff && !xff.includes('6.6.6.6') && !xff.includes(','), `XFF tới upstream = "${xff}" (mong đúng một IP, không phải 6.6.6.6)`);
          expect(r.headers['x-real-ip'] === xff, `X-Real-IP (${r.headers['x-real-ip']}) ≠ XFF (${xff})`);
        }
        expect(reqs[0].headers['x-request-id'] === mine, `x-request-id hợp lệ của client bị đổi: ${reqs[0].headers['x-request-id']}`);
        expect(/^[0-9a-f]{32}$/.test(reqs[1].headers['x-request-id'] ?? ''), `thiếu x-request-id -> nginx phải đặt $request_id, nhận ${reqs[1].headers['x-request-id']}`);
        expect(/^[0-9a-f]{32}$/.test(reqs[2].headers['x-request-id'] ?? ''), `x-request-id rác -> nginx thay bằng $request_id, nhận ${reqs[2].headers['x-request-id']}`);
        const logs = await waitFor('log JSON của edge-sink cho 3 request', async () => {
          const l = edgeLogLines('edge-sink', since).filter((x) => x.uri_path === path);
          return l.length >= 3 ? l : null;
        });
        for (const l of logs) expect(l.ip !== '6.6.6.6' && l.ip === reqs[0].headers['x-forwarded-for'], `log nginx ip=${l.ip} (mong IP thật = XFF upstream)`);
        expect(logs.some((l) => l.request_id === mine), 'log nginx không mang request_id của client -> không nối được log hai bên');

        // /socket.io/ tự đặt proxy_set_header (Upgrade/Connection) -> phải lặp đủ 4 header ghi đè (review EG1 #1).
        const sio = await fetch(`${EDGE_SINK}/socket.io/?EIO=4&transport=polling&eg=${RUN}`, { headers: { ...spoof, 'x-request-id': 'abc' } });
        expect(sio.status === 200, `/socket.io/ qua edge-sink -> ${sio.status}`);
        const s = (await sinkRequests('/socket.io/')).filter((r) => r.query?.eg === RUN).pop();
        expect(s, 'sink không nhận request /socket.io/');
        expect(s.headers['x-forwarded-for'] === reqs[0].headers['x-forwarded-for'] && s.headers['x-real-ip'] === s.headers['x-forwarded-for'], `/socket.io/: XFF=${s.headers['x-forwarded-for']} X-Real-IP=${s.headers['x-real-ip']} (mong IP kết nối, không 6.6.6.6)`);
        expect(/^[0-9a-f]{32}$/.test(s.headers['x-request-id'] ?? ''), `/socket.io/: x-request-id sai khuôn "abc" phải bị thay, nhận ${s.headers['x-request-id']}`);
        expect(s.headers.host === new URL(EDGE_SINK).host, `/socket.io/: Host bị đổi thành ${s.headers.host}`);

        // hub-api qua edge (review feat/edge): hub-api CHỈ tin edge (TRUST_PROXY=10.250.250.6) -> req.ip = IP client mà nginx
        // thấy (khoá rl:login:ip:<ip đó>), KHÔNG phải IP container edge, KHÔNG phải 6.6.6.6. Gọi thẳng :14000 với XFF giả
        // -> không được tin (đường k6). Khoá: auth.service `rl:login:ip:<req.ip>`.
        const redis = new Redis(process.env.VERIFY_REDIS_URL || hostUrls().REDIS_URL, { maxRetriesPerRequest: 1 });
        try {
          const loginSince = new Date(Date.now() - 1000).toISOString();
          const body = JSON.stringify({ email: `eg-t11-${RUN}@example.test`, password: 'sai-mat-khau-123' });
          const viaEdge = await fetch(`${EDGE}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', ...spoof }, body });
          expect([400, 401, 403, 429].includes(viaEdge.status), `login qua edge -> ${viaEdge.status}`);
          const line = await waitFor('log edge của /auth/login', async () => edgeLogLines('edge', loginSince).filter((x) => x.uri_path === '/auth/login').pop());
          expect(line.ip && line.ip !== '6.6.6.6' && line.ip !== '10.250.250.6', `nginx ghi ip=${line.ip}`);
          const keys = await redis.keys('*rl:login:ip:*');
          const mine = keys.filter((k) => k.endsWith(`:${line.ip}`));
          expect(mine.length > 0, `hub-api KHÔNG thấy IP client ${line.ip} (khoá hiện có: ${keys.join(', ')}) — TRUST_PROXY của hub-api chưa tin edge?`);
          expect(!keys.some((k) => k.endsWith(':10.250.250.6')), `hub-api thấy IP container edge: ${keys.join(', ')}`);
          const direct = await fetch(`${hostUrls().HUB_API_URL}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '7.7.7.7' }, body });
          expect([400, 401, 403, 429].includes(direct.status), `login thẳng hub-api -> ${direct.status}`);
          const all = await redis.keys('*rl:login:ip:*');
          expect(!all.some((k) => k.includes('6.6.6.6') || k.includes('7.7.7.7')), `hub-api tin IP giả: ${all.join(', ')}`);
          console.log(`  req.ip của hub-api sau edge = ${line.ip} (IP client nginx thấy)`);
        } finally {
          await redis.quit().catch(() => undefined);
        }
      },
    },
    {
      name: '[EG:T10] (phần c) L2: cầu chì: vượt EDGE_IP_RATE/BURST trên /hooks/* -> 429 edge_rate_limited + Retry-After: 1, log JSON có limit_req_status=REJECTED; cùng tải đó trên /api/* và /health KHÔNG bị nginx chặn',
      tags: ['EG1'],
      fn: async () => {
        await sleep(3000); // xô của IP này đầy lại sau T2/T11 (5 r/s)
        const since = new Date(Date.now() - 1000).toISOString();
        const path = `/hooks/github/eg_t10_${RUN}`;
        const hooks = await Promise.all(
          Array.from({ length: 30 }, () => fetch(`${EDGE}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then(async (r) => ({ status: r.status, retry: r.headers.get('retry-after'), body: (await r.json().catch(() => ({}))) as any }))),
        );
        const limited = hooks.filter((r) => r.status === 429 && r.body.error === 'edge_rate_limited');
        expect(limited.length >= 15, `30 request đồng thời (burst 10) -> chỉ ${limited.length} lần 429 edge_rate_limited: ${hooks.map((h) => h.status).join(',')}`);
        expect(limited.every((r) => r.retry === '1' && r.body.requestId && r.body.docsUrl?.endsWith('#edge_rate_limited')), 'thiếu Retry-After: 1 / requestId / docsUrl');
        const rejected = await waitFor('log REJECTED của edge', async () => {
          const l = edgeLogLines('edge', since).filter((x) => x.uri_path === path && x.limit_req_status === 'REJECTED' && x.status === 429);
          return l.length > 0 ? l : null;
        });
        console.log(`  cầu chì: ${limited.length}/30 bị chặn, ${rejected.length} dòng log REJECTED`);

        for (const p of ['/api/v1/me', '/health']) {
          const res = await Promise.all(Array.from({ length: 30 }, () => fetch(`${EDGE}${p}`).then(async (r) => ({ status: r.status, body: await r.text() }))));
          const edgeBlocked = res.filter((r) => r.body.includes('edge_rate_limited'));
          expect(edgeBlocked.length === 0, `${p}: ${edgeBlocked.length}/30 bị cầu chì nginx chặn (không được áp cho ${p})`);
        }
      },
    },
  ],
};

export default file;
