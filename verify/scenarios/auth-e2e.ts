/**
 * E2E đăng nhập (SPEC-auth §10.2) chạy vào stack `hubv` (API 14000) — `npm run verify:e2e:auth`.
 * Thay curl của spec bằng TS (SPEC-verification §7.2). Gọi THẲNG hub-api (không qua proxy web): cookie gửi tay
 * như trình duyệt. Trước mỗi kịch bản xoá khoá rate limit `rl:*` trong Redis CỦA HUBV để các kịch bản không
 * chặn lẫn nhau (giới hạn theo IP chung một máy). Không đụng stack dev.
 *
 * AU1: TA1 (phần đăng ký → key → event), TA3, TA4, TA5, TA6, TA7. AU3: TA8, TA15 (+ phần email_not_verified của TA2).
 * AU4: TA9.
 * AU2: TA2, TA10 — mail đọc từ file JSON của
 * MAIL_DRIVER=capture (verify/.mail, mount vào hub-api của hubv), KHÔNG grep log (SPEC-verification §4.2).
 */
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import Redis from 'ioredis';
import { io as ioClient } from 'socket.io-client';
import { composeOutput, hostUrls, ROOT } from '../lib/compose';
import { createRunner, expect, HttpSession } from '../lib/http-session';

const API = process.env.VERIFY_API_URL || hostUrls().HUB_API_URL;
const redis = new Redis(process.env.VERIFY_REDIS_URL || hostUrls().REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
const run = createRunner();
const RUN = randomUUID().slice(0, 8);
const PASSWORD = 'ca-phe-sua-da-2026';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const MAIL_DIR = path.join(ROOT, 'verify', '.mail');

/** Thư mới nhất gửi tới `to` có link khớp `re` (chờ tối đa 10s — mail gửi SAU COMMIT, không chặn response). */
async function mailLink(to: string, re: RegExp): Promise<string> {
  for (let i = 0; i < 40; i++) {
    const files = fs.existsSync(MAIL_DIR) ? fs.readdirSync(MAIL_DIR).filter((f) => f.endsWith('.json')).sort().reverse() : [];
    for (const f of files) {
      let m: { to?: string; text?: string };
      try {
        m = JSON.parse(fs.readFileSync(path.join(MAIL_DIR, f), 'utf8'));
      } catch {
        continue; // file đang ghi dở (driver cũ) — vòng sau đọc lại
      }
      const hit = m.to === to ? re.exec(m.text ?? '') : null;
      if (hit) return hit[0];
    }
    await sleep(250);
  }
  throw new Error(`không thấy thư tới ${to} khớp ${re} trong ${MAIL_DIR}`);
}

const tokenOf = (link: string) => new URL(link).searchParams.get('token') ?? '';

async function flushRateLimits() {
  const keys = await redis.keys('rl:*');
  if (keys.length) await redis.del(...keys);
}

function psql(sql: string): string {
  const r = composeOutput(['exec', '-T', 'postgres', 'psql', '-U', 'hub_user', '-d', 'webhook_hub', '-tA', '-c', sql]);
  if (r.status !== 0) throw new Error(`psql: ${r.stderr}`);
  return r.stdout.trim();
}

async function registered(tag: string): Promise<{ s: HttpSession; email: string; body: any }> {
  const s = new HttpSession(API);
  const email = `${tag}-${RUN}@e2e.test`;
  const r = await s.post('/auth/register', { email, name: `E2E ${tag}`, password: PASSWORD });
  expect(r.status === 201, `register ${tag} → ${r.status} ${r.text}`);
  return { s, email, body: r.body };
}

async function main() {
  await redis.connect();
  const health = await fetch(`${API}/health`).catch(() => null);
  if (!health?.ok) throw new Error(`hubv không chạy (${API}/health) — npm run verify:up`);

  await run.scenario('[AU:TA1] đăng ký → 3 cookie, owner → tạo key hk_test_ → publish → event hiện trong console (bấm giờ)', async () => {
    await flushRateLimits();
    const t0 = Date.now();
    const { s, body } = await registered('ta1');
    for (const c of ['__Host-hub_at', '__Host-hub_rt', 'hub_csrf']) expect(s.cookie(c), `thiếu cookie ${c}`);
    expect(!JSON.stringify(body).includes(s.cookie('__Host-hub_at')!), 'access token lọt vào body');
    const m = body.memberships?.[0];
    expect(m?.role === 'owner', `memberships[0].role = ${m?.role}`);
    const k = await s.post(`/api/v1/projects/${m.projectId}/keys`, { serviceName: 'ta1-svc', scopes: ['publish:events', 'read:events'] });
    expect(k.status === 201, `tạo key → ${k.status} ${k.text}`);
    expect(/^hk_test_/.test(k.body.key), 'key không phải hk_test_');
    const type = `ta1.created_${RUN}`;
    const pub = await fetch(`${API}/v1/p/${m.slug}/events`, {
      method: 'POST',
      headers: { authorization: `Bearer ${k.body.key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ type, idempotencyKey: `ta1-${RUN}`, data: { ok: true } }),
    });
    expect(pub.status === 202, `publish → ${pub.status}`);
    for (let i = 0; i < 30; i++) {
      const ev = await s.get(`/api/v1/events?projectId=${m.projectId}`);
      if (ev.status === 200 && ev.text.includes(type)) {
        console.log(`  TA1: đăng ký → event hiện trong console: ${Date.now() - t0}ms (chưa tính mail xác minh — AU2; chưa có quickstart — DX2)`);
        return;
      }
      await sleep(500);
    }
    throw new Error('event không hiện trong console sau 15s');
  });

  await run.scenario('[AU:TA3] chống dò: login email không tồn tại vs sai mật khẩu → body GIỐNG HỆT, lệch thời gian TB < 50ms; register email đã có → 201 cùng hình dạng', async () => {
    await flushRateLimits();
    const { email } = await registered('ta3');
    const a = new HttpSession(API);
    const times = { missing: [] as number[], wrong: [] as number[] };
    let bodyMissing = '';
    let bodyWrong = '';
    for (let i = 0; i < 10; i++) {
      await flushRateLimits(); // 10 lần sai > ngưỡng khoá email 5 — xoá để đo thời gian, không đo khoá
      const r1 = await a.post('/auth/login', { email: `khong-co-${i}-${RUN}@e2e.test`, password: 'sai-mat-khau-123' });
      const r2 = await a.post('/auth/login', { email, password: 'sai-mat-khau-123' });
      expect(r1.status === 401 && r2.status === 401, `status ${r1.status}/${r2.status}`);
      times.missing.push(r1.ms);
      times.wrong.push(r2.ms);
      bodyMissing = r1.text;
      bodyWrong = r2.text;
    }
    expect(bodyMissing === bodyWrong, `body khác nhau: ${bodyMissing} vs ${bodyWrong}`);
    const avg = (xs: number[]) => xs.reduce((x, y) => x + y, 0) / xs.length;
    const diff = Math.abs(avg(times.missing) - avg(times.wrong));
    console.log(`  TA3: TB email không có ${avg(times.missing).toFixed(1)}ms · sai mật khẩu ${avg(times.wrong).toFixed(1)}ms · lệch ${diff.toFixed(1)}ms`);
    expect(diff < 50, `lệch thời gian ${diff.toFixed(1)}ms ≥ 50ms`);
    await flushRateLimits();
    const dup = await new HttpSession(API).post('/auth/register', { email, name: 'Kẻ thử', password: PASSWORD + '-khac' });
    const fresh = await registered('ta3b');
    expect(dup.status === 201, `register trùng → ${dup.status}`);
    const shape = (b: any) => JSON.stringify(Object.keys(b)) + JSON.stringify(Object.keys(b.user)) + JSON.stringify(Object.keys(b.memberships[0]));
    expect(shape(dup.body) === shape(fresh.body), 'hình dạng body register trùng khác register mới');
    expect(dup.setCookies.length === 0, 'register trùng không được đặt cookie phiên');
  });

  await run.scenario('[AU:TA4] brute force: 6 lần sai cho một email → lần 6 là 429 + Retry-After; email không tồn tại cũng vậy', async () => {
    await flushRateLimits();
    const { email } = await registered('ta4');
    for (const target of [email, `khong-co-ta4-${RUN}@e2e.test`]) {
      const s = new HttpSession(API);
      const st: number[] = [];
      let last: Awaited<ReturnType<HttpSession['post']>> | undefined;
      for (let i = 0; i < 6; i++) {
        last = await s.post('/auth/login', { email: target, password: 'sai-mat-khau-123' });
        st.push(last.status);
      }
      expect(JSON.stringify(st) === JSON.stringify([401, 401, 401, 401, 401, 429]), `${target}: ${st}`);
      expect(Number(last!.headers.get('retry-after')) > 0, 'thiếu Retry-After');
    }
  });

  await run.scenario('[AU:TA5] refresh → 204; chờ 6s gửi rt cũ → 401; rt MỚI cũng 401 (cả family bị thu hồi); auth_audit có session.reuse_detected', async () => {
    await flushRateLimits();
    const { s, email } = await registered('ta5');
    const oldJar = new Map(s.jar);
    const r = await s.post('/auth/refresh');
    expect(r.status === 204, `refresh → ${r.status} ${r.text}`);
    const newJar = new Map(s.jar);
    expect(oldJar.get('__Host-hub_rt') !== newJar.get('__Host-hub_rt'), 'refresh token không đổi');
    await sleep(6_000);
    const replay = new HttpSession(API);
    oldJar.forEach((v, k) => replay.jar.set(k, v));
    expect((await replay.post('/auth/refresh')).status === 401, 'rt cũ sau 6s không bị 401');
    const after = new HttpSession(API);
    newJar.forEach((v, k) => after.jar.set(k, v));
    expect((await after.post('/auth/refresh')).status === 401, 'rt MỚI vẫn dùng được — family chưa bị thu hồi');
    const n = psql(`select count(*) from hub.auth_audit a join hub.users u on u.id=a.user_id where u.email='${email}' and a.action='session.reuse_detected'`);
    expect(Number(n) >= 1, `auth_audit session.reuse_detected = ${n}`);
  });

  await run.scenario('[AU:TA6] thu hồi tức thì: thiết bị A logout-all → request kế tiếp của B (access còn hạn) → 401', async () => {
    await flushRateLimits();
    const { email } = await registered('ta6');
    const A = new HttpSession(API);
    const B = new HttpSession(API);
    expect((await A.post('/auth/login', { email, password: PASSWORD })).status === 200, 'A login');
    expect((await B.post('/auth/login', { email, password: PASSWORD })).status === 200, 'B login');
    expect((await B.get('/auth/me')).status === 200, 'B /me trước');
    expect((await A.post('/auth/logout-all')).status === 204, 'A logout-all');
    const r = await B.get('/auth/me');
    expect(r.status === 401, `B /me sau logout-all → ${r.status}`);
  });

  await run.scenario('[AU:TA7] CSRF: POST /api/v1/projects có cookie nhưng thiếu x-csrf-token → 403 csrf_failed', async () => {
    await flushRateLimits();
    const { s } = await registered('ta7');
    const r = await s.post('/api/v1/projects', { slug: `ta7-${RUN}`, name: 'TA7' }, { csrf: false });
    expect(r.status === 403 && r.body?.error === 'csrf_failed', `→ ${r.status} ${r.text}`);
    const ok = await s.post('/api/v1/projects', { slug: `ta7-${RUN}`, name: 'TA7' });
    expect(ok.status === 201, `có CSRF → ${ok.status} ${ok.text}`);
  });

  await run.scenario('[AU:TA2] xác minh email: link trong thư (capture) → 200; dùng lại → 400 token_invalid; /auth/me emailVerified = true', async () => {
    await flushRateLimits();
    const { s, email } = await registered('ta2');
    expect((await s.get('/auth/me')).body?.user?.emailVerified === false, 'mới đăng ký đã xác minh?');
    const liveBefore = await s.post('/api/v1/projects', { slug: `ta2-live-${RUN}`, name: 'TA2 live', environment: 'live' });
    expect(liveBefore.status === 403 && liveBefore.body?.error === 'email_not_verified', `project live trước xác minh → ${liveBefore.status} ${liveBefore.text}`);
    const link = await mailLink(email, /https?:\/\/\S+\/verify-email\?token=[A-Za-z0-9_-]+/);
    const anon = new HttpSession(API);
    const first = await anon.post('/auth/verify-email', { token: tokenOf(link) });
    expect(first.status === 200, `verify → ${first.status} ${first.text}`);
    const again = await anon.post('/auth/verify-email', { token: tokenOf(link) });
    expect(again.status === 400 && again.body?.error === 'token_invalid', `dùng lại → ${again.status} ${again.text}`);
    const bogus = await anon.post('/auth/verify-email', { token: 'khong-phai-token' });
    expect(bogus.text === again.text, 'token sai và token đã dùng phải CÙNG body');
    expect((await s.get('/auth/me')).body?.user?.emailVerified === true, '/auth/me chưa thấy emailVerified');
    const live = await s.post('/api/v1/projects', { slug: `ta2-live-${RUN}`, name: 'TA2 live', environment: 'live' });
    expect(live.status === 201, `project live sau xác minh → ${live.status} ${live.text}`);
    const k = await s.post(`/api/v1/projects/${live.body.id}/keys`, { serviceName: 'ta2-live', scopes: ['read:events'] });
    expect(k.status === 201 && /^hk_live_/.test(k.body?.key), `key live → ${k.status} ${k.text}`);
  });

  await run.scenario('[AU:TA10] quên mật khẩu: email có / không có → CÙNG 202; đặt lại bằng link → mọi cookie jar cũ 401; mật khẩu mới đăng nhập được', async () => {
    await flushRateLimits();
    const { s: jarA, email } = await registered('ta10');
    const jarB = new HttpSession(API);
    expect((await jarB.post('/auth/login', { email, password: PASSWORD })).status === 200, 'login B');
    const anon = new HttpSession(API);
    const r1 = await anon.post('/auth/forgot-password', { email });
    const r2 = await anon.post('/auth/forgot-password', { email: `khong-co-ta10-${RUN}@e2e.test` });
    expect(r1.status === 202 && r2.status === 202 && r1.text === r2.text, `forgot → ${r1.status}/${r2.status} ${r1.text} vs ${r2.text}`);
    const link = await mailLink(email, /https?:\/\/\S+\/reset-password\?token=[A-Za-z0-9_-]+/);
    const NEW = 'mat-khau-moi-ta10-2026';
    const reset = await anon.post('/auth/reset-password', { token: tokenOf(link), password: NEW });
    expect(reset.status === 204, `reset → ${reset.status} ${reset.text}`);
    for (const [n, jar] of [['A', jarA], ['B', jarB]] as const) {
      const me = await jar.get('/auth/me');
      expect(me.status === 401, `jar ${n} sau reset → ${me.status}`);
    }
    expect((await anon.post('/auth/login', { email, password: PASSWORD })).status === 401, 'mật khẩu cũ vẫn đăng nhập được');
    expect((await new HttpSession(API).post('/auth/login', { email, password: NEW })).status === 200, 'mật khẩu mới không đăng nhập được');
  });

  await run.scenario('[AU:TA8] cô lập 2 người 2 project: B gọi events của project A → 404 GIỐNG HỆT project ngẫu nhiên; socket của B (vé project B) không nhận event của A', async () => {
    await flushRateLimits();
    const A = await registered('ta8a');
    const B = await registered('ta8b');
    const pa = A.body.memberships[0];
    const pb = B.body.memberships[0];
    const cross = await B.s.get(`/api/v1/events?projectId=${pa.projectId}`);
    const random = await B.s.get(`/api/v1/events?projectId=${randomUUID()}`);
    expect(cross.status === 404 && cross.text === random.text, `chéo → ${cross.status} ${cross.text} vs ngẫu nhiên ${random.text}`);
    const ticketCross = await B.s.get(`/auth/socket-ticket?projectId=${pa.projectId}`);
    expect(ticketCross.status === 404, `vé socket cho project người khác → ${ticketCross.status}`);
    const connect = async (sess: HttpSession, projectId: string) => {
      const t = await sess.get(`/auth/socket-ticket?projectId=${projectId}`);
      expect(t.status === 200, `xin vé → ${t.status} ${t.text}`);
      const sock = ioClient(API, { transports: ['websocket'], auth: { ticket: t.body.ticket }, reconnection: false });
      const got: any[] = [];
      sock.on('event.received', (e: any) => got.push(e));
      await new Promise<void>((ok, bad) => {
        sock.once('connect', () => ok());
        sock.once('connect_error', (e: Error) => bad(e));
      });
      return { sock, got };
    };
    const sa = await connect(A.s, pa.projectId);
    const sb = await connect(B.s, pb.projectId);
    try {
      const key = await A.s.post(`/api/v1/projects/${pa.projectId}/keys`, { serviceName: 'ta8', scopes: ['publish:events'] });
      expect(key.status === 201, `key A → ${key.status} ${key.text}`);
      const pub = await fetch(`${API}/v1/p/${pa.slug}/events`, {
        method: 'POST',
        headers: { authorization: `Bearer ${key.body.key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ type: `ta8.created_${RUN}`, idempotencyKey: `ta8-${RUN}`, data: { a: 1 } }),
      });
      expect(pub.status === 202, `publish A → ${pub.status}`);
      for (let i = 0; i < 40 && sa.got.length === 0; i++) await sleep(250);
      expect(sa.got.length >= 1, 'socket của A (đối chứng) không nhận event của chính A — kiểm tra realtime');
      await sleep(1500);
      expect(sb.got.length === 0, `socket của B nhận ${sb.got.length} event của A`);
      console.log(`  TA8: socket A nhận ${sa.got.length} event · socket B nhận ${sb.got.length}`);
    } finally {
      sa.sock.close();
      sb.sock.close();
    }
  });

  await run.scenario('[AU:TA15] operator mở project của người khác → 200, và audit_logs của project đó có operator.access', async () => {
    await flushRateLimits();
    const A = await registered('ta15');
    const pa = A.body.memberships[0];
    const op = new HttpSession(API);
    const login = await op.post('/auth/login', { email: process.env.VERIFY_OPERATOR_EMAIL || 'operator@verify.local', password: process.env.VERIFY_OPERATOR_PASSWORD || 'VERIFY_ONLY_admin_password' });
    expect(login.status === 200, `operator login → ${login.status} ${login.text}`);
    const ev = await op.get(`/api/v1/events?projectId=${pa.projectId}`);
    expect(ev.status === 200, `operator xem events project A → ${ev.status} ${ev.text}`);
    const audit = await A.s.get(`/api/v1/audit-logs?projectId=${pa.projectId}`);
    expect(audit.status === 200 && audit.text.includes('operator.access'), `audit của A không có operator.access: ${audit.text.slice(0, 300)}`);
  });

  await run.scenario('[AU:TA9] role: A mời B viewer (link trong thư) → B accept; B xem events 200, tạo đích 403 missing_scope, mời người 403; A nâng B developer → B tạo đích 201; A rời khi là owner duy nhất → 409 last_owner', async () => {
    await flushRateLimits();
    const A = await registered('ta9a');
    const B = await registered('ta9b');
    const pa = A.body.memberships[0];
    // A phải xác minh email mới mời được người (§5.6)
    const vlink = await mailLink(A.email, /https?:\/\/\S+\/verify-email\?token=[A-Za-z0-9_-]+/);
    expect((await new HttpSession(API).post('/auth/verify-email', { token: tokenOf(vlink) })).status === 200, 'A verify');
    const inv = await A.s.post(`/api/v1/projects/${pa.projectId}/invitations`, { email: B.email, role: 'viewer' });
    expect(inv.status === 201, `invite → ${inv.status} ${inv.text}`);
    const ilink = await mailLink(B.email, /https?:\/\/\S+\/invite\?token=[A-Za-z0-9_-]+/);
    const acc = await B.s.post('/auth/invitations/accept', { token: tokenOf(ilink) });
    expect(acc.status === 200 && acc.body?.membership?.role === 'viewer', `accept → ${acc.status} ${acc.text}`);
    expect((await B.s.get(`/api/v1/events?projectId=${pa.projectId}`)).status === 200, 'B (viewer) xem events');
    const dest = { name: `ta9-${RUN}`, type: 'webhook', config: { url: 'http://sink:4100/ta9' } };
    const d1 = await B.s.post(`/api/v1/destinations?projectId=${pa.projectId}`, dest);
    expect(d1.status === 403 && d1.body?.error === 'missing_scope' && d1.body?.required === 'manage:endpoints', `viewer tạo đích → ${d1.status} ${d1.text}`);
    const i2 = await B.s.post(`/api/v1/projects/${pa.projectId}/invitations`, { email: `x-${RUN}@e2e.test`, role: 'viewer' });
    expect(i2.status === 403, `viewer mời người → ${i2.status} ${i2.text}`);
    const up = await A.s.req('PATCH', `/api/v1/projects/${pa.projectId}/members/${B.body.user.id}`, { body: { role: 'developer' } });
    expect(up.status === 204, `nâng role → ${up.status} ${up.text}`);
    const d2 = await B.s.post(`/api/v1/destinations?projectId=${pa.projectId}`, dest);
    expect(d2.status === 201, `developer tạo đích → ${d2.status} ${d2.text}`);
    const leave = await A.s.req('DELETE', `/api/v1/projects/${pa.projectId}/members/${A.body.user.id}`);
    expect(leave.status === 409 && leave.body?.error === 'last_owner', `owner duy nhất rời → ${leave.status} ${leave.text}`);
  });

  await redis.quit();
  process.exit(run.finish());
}

main().catch(async (e) => {
  console.error(`✗ ${(e as Error).message}`);
  await redis.quit().catch(() => undefined);
  process.exit(1);
});
