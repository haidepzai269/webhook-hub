/**
 * E2E đăng nhập (SPEC-auth §10.2) chạy vào stack `hubv` (API 14000) — `npm run verify:e2e:auth`.
 * Thay curl của spec bằng TS (SPEC-verification §7.2). Gọi THẲNG hub-api (không qua proxy web): cookie gửi tay
 * như trình duyệt. Trước mỗi kịch bản xoá khoá rate limit `rl:*` trong Redis CỦA HUBV để các kịch bản không
 * chặn lẫn nhau (giới hạn theo IP chung một máy). Không đụng stack dev.
 *
 * AU1: TA1 (phần đăng ký → key → event), TA3, TA4, TA5, TA6, TA7. AU3: TA8, TA15 (+ phần email_not_verified của TA2).
 * AU4: TA9. AU6: TA13 (TA12 là test jest libs/database/test/rls-db.spec.ts).
 * AU2: TA2, TA10 — mail đọc từ file JSON của
 * MAIL_DRIVER=capture (verify/.mail, mount vào hub-api của hubv), KHÔNG grep log (SPEC-verification §4.2).
 */
import { randomUUID } from 'crypto';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import Redis from 'ioredis';
import { io as ioClient } from 'socket.io-client';
import { composeOutput, hostUrls, ROOT } from '../lib/compose';
import { createRunner, expect, HttpSession } from '../lib/http-session';
import { assertLocalOrExit } from '../lib/local-url';

const API = process.env.VERIFY_API_URL || hostUrls().HUB_API_URL;
// M-R2-2: `npm run verify:e2e:auth` chạy thẳng file này (không qua guard của run.ts/e2e-world) — chặn TRƯỚC Redis/request.
assertLocalOrExit(API, 'verify:e2e:auth');
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

const VERIFY_LINK = /https?:\/\/\S+\/verify-email\?token=[A-Za-z0-9_-]+/;

/** R-6 (ADR-120): đăng ký KHÔNG đăng nhập — 201 body cố định, 0 cookie. */
async function registerOnly(tag: string): Promise<{ s: HttpSession; email: string; res: Awaited<ReturnType<HttpSession['post']>> }> {
  const s = new HttpSession(API);
  const email = `${tag}-${RUN}@e2e.test`;
  const res = await s.post('/auth/register', { email, name: `E2E ${tag}`, password: PASSWORD });
  expect(res.status === 201, `register ${tag} → ${res.status} ${res.text}`);
  expect(res.setCookies.length === 0, `register ${tag} đặt ${res.setCookies.length} cookie (R-6: phải 0)`);
  return { s, email, res };
}

/** Đăng ký + bấm link xác minh trong thư (capture) bằng CÙNG phiên -> đăng nhập (3 cookie), body = /auth/me. */
async function registered(tag: string): Promise<{ s: HttpSession; email: string; body: any }> {
  const { s, email } = await registerOnly(tag);
  // N-1 (ADR-121): tài khoản mật khẩu chưa xác minh -> người bấm link ĐẶT mật khẩu (ở đây đặt lại đúng PASSWORD).
  const v = await s.post('/auth/verify-email', { token: tokenOf(await mailLink(email, VERIFY_LINK)), password: PASSWORD, name: `E2E ${tag}` });
  expect(v.status === 200, `verify ${tag} → ${v.status} ${v.text}`);
  return { s, email, body: v.body };
}

async function main() {
  await redis.connect();
  const health = await fetch(`${API}/health`).catch(() => null);
  if (!health?.ok) throw new Error(`hubv không chạy (${API}/health) — npm run verify:up`);

  await run.scenario('[AU:TA1] đăng ký → link xác minh → 3 cookie (R-6), owner → tạo key hk_test_ → publish → event hiện trong console (bấm giờ)', async () => {
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
        console.log(`  TA1: đăng ký → bấm link xác minh → event hiện trong console: ${Date.now() - t0}ms (chưa có quickstart — DX2)`);
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
    const fresh = (await registerOnly('ta3b')).res;
    expect(dup.status === 201, `register trùng → ${dup.status}`);
    // R-6: GIỐNG HỆT từng byte, cả hai đều 0 cookie (trước: 201+0 cookie vs 201+3 cookie).
    expect(dup.text === fresh.text, `body register trùng khác register mới: ${dup.text} vs ${fresh.text}`);
    expect(dup.setCookies.length === 0 && fresh.setCookies.length === 0, `cookie: trùng ${dup.setCookies.length} / mới ${fresh.setCookies.length}`);
  });

  await run.scenario('[AR:R-6] (phần b) register email đã có (đã xác minh) vs email mới: cùng 201, cùng body từng byte, 0 cookie, lệch thời gian TB < 50ms; đăng ký + đăng nhập ngay không còn phân biệt được', async () => {
    const { email: taken } = await registered('r6x');
    const t = { taken: [] as number[], fresh: [] as number[] };
    const bodies = new Set<string>();
    for (let i = 0; i < 8; i++) {
      await flushRateLimits(); // registerIp 5/giờ — xoá để đo thời gian
      const a = await new HttpSession(API).post('/auth/register', { email: taken, name: 'R6', password: PASSWORD + '-x' });
      const b = await new HttpSession(API).post('/auth/register', { email: `r6-moi-${i}-${RUN}@e2e.test`, name: 'R6', password: PASSWORD });
      expect(a.status === 201 && b.status === 201 && a.setCookies.length === 0 && b.setCookies.length === 0, `status/cookie ${a.status}/${b.status} ${a.setCookies.length}/${b.setCookies.length}`);
      bodies.add(a.text).add(b.text);
      t.taken.push(a.ms);
      t.fresh.push(b.ms);
    }
    expect(bodies.size === 1, `body khác nhau: ${[...bodies].join(' | ')}`);
    // Kẻ dò: đăng ký email mới rồi đăng nhập ngay bằng chính mật khẩu đó -> 401 như email đã có (sai mật khẩu).
    await flushRateLimits();
    const probeNew = await new HttpSession(API).post('/auth/login', { email: `r6-moi-0-${RUN}@e2e.test`, password: PASSWORD });
    const probeTaken = await new HttpSession(API).post('/auth/login', { email: taken, password: PASSWORD + '-x' });
    expect(probeNew.status === 401 && probeNew.text === probeTaken.text, `login sau đăng ký: mới ${probeNew.status} vs đã có ${probeTaken.status}`);
    const avg = (xs: number[]) => xs.reduce((x, y) => x + y, 0) / xs.length;
    const diff = Math.abs(avg(t.taken) - avg(t.fresh));
    console.log(`  R-6: TB đã có ${avg(t.taken).toFixed(1)}ms · mới ${avg(t.fresh).toFixed(1)}ms · lệch ${diff.toFixed(1)}ms`);
    expect(diff < 50, `lệch thời gian ${diff.toFixed(1)}ms ≥ 50ms`);
  });

  await run.scenario('[AR:N-1] (phần c) chiếm tài khoản bằng đăng ký trước: kẻ xấu đăng ký email nạn nhân (A) → nạn nhân đăng ký (V) → bấm link (phải đặt mật khẩu) → A 401, V 200, phiên kẻ xấu không còn', async () => {
    await flushRateLimits();
    const email = `n1-nannhan-${RUN}@e2e.test`;
    const A = 'mat-khau-ke-xau-2026';
    const V = 'mat-khau-nan-nhan-2026';
    const atk = await new HttpSession(API).post('/auth/register', { email, name: 'Attacker', password: A });
    expect(atk.status === 201, `1. kẻ xấu đăng ký → ${atk.status}`);
    const firstLink = await mailLink(email, VERIFY_LINK);
    await flushRateLimits();
    const victim = new HttpSession(API);
    expect((await victim.post('/auth/register', { email, name: 'Victim', password: V })).status === 201, '2. nạn nhân đăng ký');
    let link = firstLink;
    for (let i = 0; i < 40 && link === firstLink; i++) {
      link = await mailLink(email, VERIFY_LINK);
      if (link === firstLink) await sleep(250);
    }
    expect(link !== firstLink, 'không thấy link xác minh thứ hai');
    const bare = await victim.post('/auth/verify-email', { token: tokenOf(link) });
    expect(bare.status === 400 && bare.body?.error === 'password_required', `3. bấm link không đặt mật khẩu → ${bare.status} ${bare.text}`);
    const ok = await victim.post('/auth/verify-email', { token: tokenOf(link), password: V, name: 'Victim' });
    expect(ok.status === 200 && ok.body?.user?.name === 'Victim', `3. đặt mật khẩu → ${ok.status} ${ok.text}`);
    await flushRateLimits();
    const la = await new HttpSession(API).post('/auth/login', { email, password: A });
    const lv = await new HttpSession(API).post('/auth/login', { email, password: V });
    expect(la.status === 401, `4. kẻ xấu login bằng A → ${la.status} (phải 401)`);
    expect(lv.status === 200, `4. nạn nhân login bằng V → ${lv.status}`);
    const stale = await new HttpSession(API).post('/auth/verify-email', { token: tokenOf(firstLink), password: A });
    expect(stale.status === 400, `link đầu (của lượt kẻ xấu) → ${stale.status}`);
    const live = psql(`select count(*) from hub.auth_sessions s join hub.users u on u.id = s.user_id where u.email = '${email}' and s.revoked_at is null`);
    expect(live === '2', `phiên còn sống = ${live} (mong 2: link xác minh + login của nạn nhân)`);
    console.log(`  N-1: A → ${la.status} · V → ${lv.status} · phiên sống ${live} (đều của nạn nhân)`);
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
    const { s, email } = await registerOnly('ta2');
    // R-6: chưa xác minh -> đăng nhập ĐÚNG mật khẩu vẫn 401, CÙNG body với sai mật khẩu (không còn phiên "chưa xác minh").
    const early = await new HttpSession(API).post('/auth/login', { email, password: PASSWORD });
    const wrong = await new HttpSession(API).post('/auth/login', { email, password: PASSWORD + '-sai' });
    expect(early.status === 401 && early.text === wrong.text, `login trước xác minh → ${early.status} ${early.text}`);
    const link = await mailLink(email, VERIFY_LINK);
    const anon = new HttpSession(API);
    const need = await s.post('/auth/verify-email', { token: tokenOf(link) });
    expect(need.status === 400 && need.body?.error === 'password_required', `verify không mật khẩu → ${need.status} ${need.text}`);
    const first = await s.post('/auth/verify-email', { token: tokenOf(link), password: PASSWORD });
    expect(first.status === 200 && first.setCookies.length >= 3, `verify → ${first.status} (${first.setCookies.length} cookie) ${first.text}`);
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
    // registered() đã bấm link xác minh (R-6) — A mời được người (§5.6)
    const inv = await A.s.post(`/api/v1/projects/${pa.projectId}/invitations`, { email: B.email, role: 'viewer' });
    expect(inv.status === 201, `invite → ${inv.status} ${inv.text}`);
    const ilink = await mailLink(B.email, /https?:\/\/\S+\/invite\?token=[A-Za-z0-9_-]+/);
    const acc = await B.s.post('/auth/invitations/accept', { token: tokenOf(ilink) });
    expect(acc.status === 200 && acc.body?.membership?.role === 'viewer', `accept → ${acc.status} ${acc.text}`);
    expect((await B.s.get(`/api/v1/events?projectId=${pa.projectId}`)).status === 200, 'B (viewer) xem events');
    // KN1 (ADR-138): đích webhook đi POST /api/v1/endpoints; /destinations còn cho telegram/discord — scope y hệt.
    const dest = { name: `ta9-${RUN}`, type: 'discord', config: { webhookUrl: 'http://sink:4100/ta9' } };
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

  await run.scenario('[AU:TA13] khởi động hub-api với DATABASE_URL là superuser -> THOÁT với thông báo rõ (RLS không được thành trang trí)', async () => {
    const superUrl = 'postgresql://hub_user:hub_password@postgres:5432/webhook_hub?schema=hub';
    const name = `hubv-ta13-${RUN}`;
    const r = composeOutput(['run', '--rm', '--no-deps', '--name', name, '-e', `DATABASE_URL=${superUrl}`, '-e', 'RUN_SEED=false', '-e', 'HUB_APP_DB_PASSWORD=', 'hub-api'], 120_000);
    // Hết giờ: dọn container do CHÍNH kịch bản này đặt tên (không phải container của stack).
    if (r.status === -1) spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
    const out = `${r.stdout}
${r.stderr}`;
    expect(r.status !== 0, `hub-api vẫn chạy (exit ${r.status}) với role superuser`);
    expect(/superuser\/BYPASSRLS/.test(out), `không thấy thông báo rõ trong log: ${out.slice(-600)}`);
    console.log(`  TA13: exit ${r.status}, log có "superuser/BYPASSRLS"`);
  });

  await run.scenario('[AR:R-3] (phần d) socket đang mở: E bị A xoá khỏi project -> socket bị ngắt, không nhận event mới; E logout-all -> socket project của E bị ngắt', async () => {
    await flushRateLimits();
    const A = await registered('r3a');
    const E = await registered('r3e');
    const pa = A.body.memberships[0];
    const pe = E.body.memberships[0];
    const inv = await A.s.post(`/api/v1/projects/${pa.projectId}/invitations`, { email: E.email, role: 'viewer' });
    expect(inv.status === 201, `invite → ${inv.status} ${inv.text}`);
    const ilink = await mailLink(E.email, /https?:\/\/\S+\/invite\?token=[A-Za-z0-9_-]+/);
    expect((await E.s.post('/auth/invitations/accept', { token: tokenOf(ilink) })).status === 200, 'E accept');
    const open = async (projectId: string) => {
      const t = await E.s.get(`/auth/socket-ticket?projectId=${projectId}`);
      expect(t.status === 200, `vé → ${t.status} ${t.text}`);
      const sock = ioClient(API, { transports: ['websocket'], auth: { ticket: t.body.ticket }, reconnection: false });
      const st = { got: 0, closed: false };
      sock.on('event.received', () => st.got++);
      sock.on('disconnect', () => (st.closed = true));
      await new Promise<void>((ok, bad) => {
        sock.once('connect', () => ok());
        sock.once('connect_error', (e: Error) => bad(e));
      });
      return { sock, st };
    };
    const onA = await open(pa.projectId);
    const onE = await open(pe.projectId);
    try {
      const rm = await A.s.req('DELETE', `/api/v1/projects/${pa.projectId}/members/${E.body.user.id}`);
      expect(rm.status === 204, `xoá E → ${rm.status} ${rm.text}`);
      for (let i = 0; i < 20 && !onA.st.closed; i++) await sleep(150);
      const key = await A.s.post(`/api/v1/projects/${pa.projectId}/keys`, { serviceName: 'r3', scopes: ['publish:events'] });
      await fetch(`${API}/v1/p/${pa.slug}/events`, {
        method: 'POST',
        headers: { authorization: `Bearer ${key.body.key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ type: `r3.created_${RUN}`, idempotencyKey: `r3-${RUN}`, data: { a: 1 } }),
      });
      await sleep(1500);
      expect(onA.st.closed && onA.st.got === 0, `sau khi bị xoá: socket ${onA.st.closed ? 'đã' : 'VẪN'} mở, nhận ${onA.st.got} event`);
      expect(!onE.st.closed, 'socket project của chính E bị ngắt oan khi E bị xoá khỏi project A');
      const la = await E.s.post('/auth/logout-all', {});
      expect(la.status === 204 || la.status === 200, `logout-all → ${la.status} ${la.text}`);
      for (let i = 0; i < 20 && !onE.st.closed; i++) await sleep(150);
      expect(onE.st.closed, 'sau logout-all socket của E vẫn mở');
      console.log(`  R-3: xoá thành viên -> ngắt, nhận ${onA.st.got} event · logout-all -> ngắt`);
    } finally {
      onA.sock.close();
      onE.sock.close();
    }
  });

  // AU5b (ADR-127) — đăng nhập Google qua fake-google (sink), đi QUA proxy web nếu web chạy (giống người dùng ở :3000).
  await run.scenario('[AU:GO9] Google qua fake-google: người mới -> /invite (next) + 3 cookie; chiếm trước (đăng ký mật khẩu A rồi Google) -> A 401; sub khác cùng email -> google_account_mismatch; nút Google có trên /login', async () => {
    await flushRateLimits();
    const WEBG = process.env.VERIFY_WEB_URL || 'http://localhost:13000';
    const viaWeb = await fetch(`${WEBG}/login`).then((r) => r.ok).catch(() => false);
    const base = viaWeb ? WEBG : API;
    if (viaWeb) expect((await (await fetch(`${WEBG}/login`)).text()).includes('href="/auth/google"'), '/login không có nút "Đăng nhập bằng Google"');
    const SINK = process.env.VERIFY_SINK_URL || 'http://localhost:14100';
    const google = async (sub: string, email: string, next?: string) => {
      const s = new HttpSession(base);
      const start = await s.get(`/auth/google${next ? `?next=${encodeURIComponent(next)}` : ''}`);
      expect(start.status === 302 && s.cookie('__Host-hub_oauth'), `/auth/google → ${start.status} ${start.text}`);
      const auth = new URL(start.headers.get('location')!.replace('http://sink:4100', SINK));
      expect(auth.searchParams.get('scope') === 'openid email profile' && auth.searchParams.get('prompt') === 'select_account', `tham số auth: ${auth.search}`);
      auth.searchParams.set('test_sub', sub);
      auth.searchParams.set('test_email', email);
      auth.searchParams.set('test_name', `Google ${sub}`);
      const back = await fetch(auth, { redirect: 'manual' });
      const cb = new URL(back.headers.get('location')!);
      const done = await s.get(`${cb.pathname}${cb.search}`);
      return { s, done, location: done.headers.get('location') ?? '' };
    };
    const fresh = `go9-moi-${RUN}@gmail.test`;
    const a = await google(`go9-sub-a-${RUN}`, fresh, '/invite');
    expect(a.done.status === 302 && a.location.endsWith('/invite') && a.done.setCookies.length >= 3, `người mới → ${a.done.status} ${a.location} (${a.done.setCookies.length} cookie)`);
    const me = await a.s.get('/auth/me');
    expect(me.status === 200 && me.body?.user?.email === fresh && me.body?.user?.emailVerified === true, `/auth/me → ${me.status} ${me.text}`);

    const victim = `go9-nannhan-${RUN}@gmail.test`;
    expect((await new HttpSession(API).post('/auth/register', { email: victim, name: 'Attacker', password: 'mat-khau-ke-xau-2026' })).status === 201, 'kẻ xấu đăng ký trước');
    await sleep(500);
    const v = await google(`go9-sub-v-${RUN}`, victim);
    expect(v.done.status === 302 && v.location.endsWith('/dashboard'), `nạn nhân đăng nhập Google → ${v.done.status} ${v.location}`);
    await flushRateLimits();
    const atk = await new HttpSession(API).post('/auth/login', { email: victim, password: 'mat-khau-ke-xau-2026' });
    expect(atk.status === 401, `kẻ xấu login bằng mật khẩu A → ${atk.status}`);
    expect(((await v.s.get('/auth/me')).body?.user?.name ?? '') === `Google go9-sub-v-${RUN}`, 'tên vẫn là của kẻ đăng ký trước');

    const mm = await google(`go9-sub-khac-${RUN}`, fresh);
    expect(mm.location.endsWith('/login?error=google_account_mismatch') && mm.done.setCookies.filter((c) => c.startsWith('__Host-hub_at')).length === 0, `sub khác → ${mm.location}`);
    console.log(`  GO9 (${viaWeb ? 'qua web :13000' : 'thẳng API'}): mới → ${a.location} · chiếm trước → A ${atk.status} · sub khác → mismatch`);
  });

  // R-2 (ADR-110) — đi QUA proxy web (cổng 13000, profile `web`). Web chưa chạy -> bỏ qua có ghi rõ (không tính).
  const WEB = process.env.VERIFY_WEB_URL || 'http://localhost:13000';
  const webUp = await fetch(`${WEB}/login`, { redirect: 'manual' }).then((r) => r.status < 500).catch(() => false);
  if (!webUp) {
    console.log(`∅ R-2 (phần c), R-5 bỏ qua: web hubv chưa chạy ở ${WEB} (COMPOSE_PROFILES=web npm run verify:up)`);
  } else {
    await run.scenario('[AR:R-5] link trong mail trỏ vào trang có thật: /forgot-password, /reset-password, /invite trả 200 (trước: 404), có Referrer-Policy no-referrer cho trang token', async () => {
      const out: string[] = [];
      for (const p of ['/forgot-password', '/reset-password?token=x', '/invite?token=x']) {
        const r = await fetch(`${WEB}${p}`, { redirect: 'manual' });
        out.push(`${p}=${r.status}`);
        expect(r.status === 200, `${p} → ${r.status}`);
        if (p !== '/forgot-password') expect(r.headers.get('referrer-policy') === 'no-referrer', `${p} thiếu Referrer-Policy: no-referrer`);
      }
      console.log(`  R-5: ${out.join(' · ')}`);
    });
    await run.scenario('[AR:R-2] (phần c) qua proxy web: client X đăng ký 6 lần -> lần 6 bị 429; client Y (IP khác, cùng proxy) vẫn 201; header IP giả gửi THẲNG API (không secret) bị bỏ qua', async () => {
      await flushRateLimits();
      const reg = (base: string, ip: string, i: string, extra: Record<string, string> = {}) =>
        new HttpSession(base).post('/auth/register', { email: `r2-${i}-${RUN}@e2e.test`, name: 'R2', password: PASSWORD }, { headers: { 'x-forwarded-for': ip, ...extra } });
      const x: number[] = [];
      for (let i = 0; i < 6; i++) x.push((await reg(WEB, '203.0.113.10', `x${i}`)).status);
      expect(x.slice(0, 5).every((s) => s === 201) && x[5] === 429, `client X qua web: ${x.join(',')} (mong 201×5, 429)`);
      const y = await reg(WEB, '198.51.100.20', 'y');
      expect(y.status === 201, `client Y qua web bị ${y.status} — giới hạn theo IP đang là giới hạn CHUNG (R-2)`);
      // Kẻ gọi thẳng API tự đặt x-hub-client-ip, không có secret -> vẫn tính theo IP socket của chính nó.
      const z: number[] = [];
      for (let i = 0; i < 6; i++) z.push((await reg(API, '1.1.1.1', `z${i}`, { 'x-hub-client-ip': `192.0.2.${i + 1}` })).status);
      expect(z[5] === 429, `header giả không secret được tin: ${z.join(',')}`);
      console.log(`  R-2: X=${x.join(',')} · Y=${y.status} · thẳng API giả IP=${z.join(',')}`);
    });
  }

  await redis.quit();
  process.exit(run.finish());
}

main().catch(async (e) => {
  console.error(`✗ ${(e as Error).message}`);
  await redis.quit().catch(() => undefined);
  process.exit(1);
});
