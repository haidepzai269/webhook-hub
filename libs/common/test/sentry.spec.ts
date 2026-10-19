import * as http from 'http';
import { AddressInfo } from 'net';
import { CAUSE_LIST, CAUSES, SENTRY_CAUSES } from '../src/causes';
import { CanonicalLogger } from '../src/log-line';
import { logger } from '../src/logger';
import { errInfo } from '../src/log-line';
import { closeSentry, errClass, maskEmails, flushSentry, initSentry, reportUnexpected, scrubSentryEvent, sentryFingerprint, sentryInternalSeenSize, sentryStats } from '../src/sentry';

/**
 * LOGGING.md §11 (ADR-258) — L0. Không mạng ngoài: transport giả, hoặc DSN trỏ vào server local 127.0.0.1.
 * Chuỗi "mìn" dùng lại dạng đã allowlist ở .gitleaks.toml (hk_live_MINEKEYMINEKEY1234567890).
 */
const APIKEY = 'hk_live_MINEKEYMINEKEY1234567890';
const WHSEC = 'whsec_MINEMINEMINE1234567890abcdef';
const BEARER = 'Bearer MINEBEARERTOKEN1234567890abc';
const ACCT = '9704123456789012';
const MINES = [APIKEY, WHSEC, 'MINEBEARERTOKEN', ACCT, 'MINEBODYMARKER', 'MINECOOKIE', 'MINEQUERYTOKEN', 'MINEUSERIP'];
const DSN = 'http://key@127.0.0.1:9/1';

let sent: any[] = [];
const fakeTransport = () => () => ({
  send: async (env: unknown) => {
    sent.push(env);
    return {};
  },
  flush: async () => true,
});
const bodies = () => sent.map((e) => JSON.stringify(e)).join('\n');
const events = (): any[] => sent.flatMap((env) => (env[1] as any[]).filter(([h]) => h.type === 'event').map(([, p]) => p));

async function start(env: Record<string, string> = {}) {
  sent = [];
  const ok = initSentry('hub-api', { SENTRY_DSN: DSN, ...env } as any, { transport: fakeTransport(), noProcessHandlers: true });
  expect(ok).toBe(true);
}

afterEach(async () => {
  await closeSentry();
});

describe('Sentry backend (ADR-258)', () => {
  it('không SENTRY_DSN -> no-op hoàn toàn: không bật, không handler toàn cục, không gửi', () => {
    const before = process.listenerCount('uncaughtException');
    expect(initSentry('hub-api', {} as any)).toBe(false);
    expect(initSentry('hub-worker', { SENTRY_DSN: '   ' } as any)).toBe(false);
    expect(process.listenerCount('uncaughtException')).toBe(before);
    expect(reportUnexpected(new Error('boom'), { cause: 'fail.hub_unknown' })).toBeNull();
    expect(sentryStats()).toEqual({ enabled: false, sent: 0, dropped: 0, deduped: 0 });
  });

  it('bãi mìn: envelope gửi đi không chứa secret/body/header/cookie/query/IP', async () => {
    await start();
    const err: any = new Error(`xử lý lỗi ${APIKEY} ${WHSEC} ${BEARER} tài khoản ${ACCT} gọi https://u:pw@dest.example.com/path?token=MINEQUERYTOKEN`);
    err.body_raw = Buffer.from('MINEBODYMARKER').toString('base64');
    err.headers = { cookie: 'MINECOOKIE', authorization: BEARER };
    err.stack = `Error: ${err.message}\n    at foo (/app/x.ts:1:1)\n    at bar (/app/${APIKEY}.ts:2:2)`;
    expect(reportUnexpected(err, { cause: 'fail.hub_unknown', stage: 'ingest', traceId: 'a'.repeat(32), tenantId: 't-1' })).toEqual(expect.any(String));
    await flushSentry();
    const out = bodies();
    expect(out.length).toBeGreaterThan(200);
    for (const m of MINES) expect(out).not.toContain(m);
    expect(out).not.toContain('body_raw');
    expect(out).not.toContain('dest.example.com/path');
    const ev = events()[0];
    expect(ev.request).toBeUndefined();
    expect(ev.user).toBeUndefined();
    expect(ev.breadcrumbs).toBeUndefined();
    expect(ev.extra).toBeUndefined();
    expect(ev.server_name).toBeUndefined();
    expect(ev.tags).toMatchObject({ svc: 'hub-api', cause: 'fail.hub_unknown', blame: 'hub', stage: 'ingest', trace_id: 'a'.repeat(32), tenant_id: 't-1' });
    expect(ev.fingerprint).toEqual(['hub-api', 'fail.hub_unknown', 'Error', 'ingest']);
    expect(JSON.stringify(ev.exception)).toContain('foo'); // stack vẫn còn (mục đích của Sentry)
  });

  it('beforeSend: bỏ request/user/breadcrumbs/extra, tag lạ, context lạ; scrub phần còn lại', () => {
    const e = scrubSentryEvent({
      message: 'm',
      request: { data: 'MINEBODYMARKER', cookies: { a: 'MINECOOKIE' }, headers: { authorization: BEARER }, query_string: 'token=MINEQUERYTOKEN' },
      user: { ip_address: 'MINEUSERIP' },
      breadcrumbs: [{ message: APIKEY }],
      extra: { body_raw: 'MINEBODYMARKER' },
      tags: { svc: 'hub-api', secret_tag: WHSEC },
      contexts: { device: { name: 'x' }, trace: { trace_id: 'abc' }, culture: {} },
      exception: { values: [{ type: 'Error', value: `k ${APIKEY}` }] },
    });
    const out = JSON.stringify(e);
    for (const m of MINES) expect(out).not.toContain(m);
    expect(e.tags).toEqual({ svc: 'hub-api' });
    expect(Object.keys(e.contexts)).toEqual(['trace']);
  });

  it('beforeSend bỏ ECONNRESET/EPIPE/abort', () => {
    expect(scrubSentryEvent({ exception: { values: [{ type: 'Error', value: 'read ECONNRESET' }] } })).toBeNull();
    expect(scrubSentryEvent({ message: 'write EPIPE' })).toBeNull();
  });

  it('hợp đồng cổng: mọi cause blame≠hub (hoặc ngoài nhóm "lạ") KHÔNG BAO GIỜ gửi', async () => {
    await start({ SENTRY_MAX_PER_MIN: '1000' });
    let i = 0;
    for (const cause of CAUSE_LIST) reportUnexpected(new Error('x'), { cause, stage: `s${i++}` });
    await flushSentry();
    const should = CAUSE_LIST.filter((c) => CAUSES[c].blame === 'hub' && SENTRY_CAUSES.has(c));
    expect(should.length).toBeGreaterThan(0);
    expect(events().map((e) => e.tags.cause).sort()).toEqual([...should].sort());
    for (const c of SENTRY_CAUSES) expect(CAUSES[c].blame).toBe('hub'); // tập SENTRY_CAUSES không lọt cause của bên khác
    expect(events().every((e) => CAUSES[e.tags.cause as keyof typeof CAUSES].blame === 'hub')).toBe(true);
  });

  it('lỗi hạ tầng tạm thời (infra) do bên gọi phân loại -> không gửi', async () => {
    await start();
    expect(reportUnexpected(new Error('x'), { cause: 'fail.hub_unknown', infra: true })).toBeNull();
    expect(sent.length).toBe(0);
  });

  it('trần SENTRY_MAX_PER_MIN: vượt thì đếm drop; sang phút mới được gửi lại', async () => {
    await start({ SENTRY_MAX_PER_MIN: '3', SENTRY_DEDUPE_WINDOW_MS: '300000' });
    const t0 = 1_000_000;
    for (let i = 0; i < 10; i++) reportUnexpected(new Error('x'), { cause: 'fail.hub_unknown', stage: `st${i}` }, t0 + i);
    expect(sentryStats()).toMatchObject({ sent: 3, dropped: 7, deduped: 0 });
    reportUnexpected(new Error('x'), { cause: 'fail.hub_unknown', stage: 'next' }, t0 + 61_000);
    expect(sentryStats().sent).toBe(4);
  });

  it('fingerprint ổn định (không phụ thuộc message/id) + dedupe theo cửa sổ', async () => {
    await start({ SENTRY_DEDUPE_WINDOW_MS: '1000' });
    const mk = (m: string) => Object.assign(new TypeError(m), {});
    expect(reportUnexpected(mk('lần 1 id=111'), { cause: 'fail.hub_unknown', stage: 'normalize' }, 10)).not.toBeNull();
    expect(reportUnexpected(mk('lần 2 id=222'), { cause: 'fail.hub_unknown', stage: 'normalize' }, 500)).toBeNull(); // trong cửa sổ
    expect(reportUnexpected(mk('lần 3 id=333'), { cause: 'fail.hub_unknown', stage: 'normalize' }, 2000)).not.toBeNull(); // hết cửa sổ
    expect(reportUnexpected(mk('khác chặng'), { cause: 'fail.hub_unknown', stage: 'delivery' }, 2001)).not.toBeNull();
    await flushSentry();
    const fps = events().map((e) => e.fingerprint.join('|'));
    expect(fps[0]).toBe(fps[1]);
    expect(fps[0]).toBe(sentryFingerprint('hub-api', 'fail.hub_unknown', 'TypeError', 'normalize').join('|'));
    expect(fps[2]).not.toBe(fps[0]);
    expect(sentryStats().deduped).toBe(1);
  });

  it('nối từ canonical line: chỉ cause lạ của hub, kèm trace_id; cause của bên khác thì không', async () => {
    await start();
    const lines: any[] = [];
    const log = { info: (o: any) => lines.push(o), warn: (o: any) => lines.push(o), error: (o: any) => lines.push(o) };
    const c = new CanonicalLogger({ log, successSample: 1 });
    const trace = 'b'.repeat(32);
    c.emit({ svc: 'hub-worker', msg: 'normalize.done', outcome: 'dead', traceId: trace, cause: 'fail.hub_unknown', totalMs: 5, err: new Error(`oops ${APIKEY}`) });
    c.emit({ svc: 'hub-worker', msg: 'delivery.attempt', outcome: 'retry', traceId: trace, cause: 'fail.dest_5xx' as any, totalMs: 5, err: new Error('dest 500') });
    c.emit({ svc: 'hub-api', msg: 'ingest.done', outcome: 'rejected', traceId: trace, cause: 'wrong.signature', totalMs: 5, err: new Error('bad sig') });
    await flushSentry();
    expect(events()).toHaveLength(1);
    expect(events()[0].tags).toMatchObject({ cause: 'fail.hub_unknown', stage: 'normalize', trace_id: trace });
    expect(bodies()).not.toContain(APIKEY);
  });

  it('DSN trỏ vào server local giả: envelope tới nơi, không chứa mìn', async () => {
    const got: string[] = [];
    const srv = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (d) => chunks.push(d));
      req.on('end', () => {
        got.push(`${req.url}\n${Buffer.concat(chunks).toString('utf8')}`);
        res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
      });
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    try {
      const port = (srv.address() as AddressInfo).port;
      expect(initSentry('hub-worker', { SENTRY_DSN: `http://key@127.0.0.1:${port}/1`, SENTRY_ENVIRONMENT: 'test', SENTRY_RELEASE: 'abc123' } as any, { noProcessHandlers: true })).toBe(true);
      reportUnexpected(new Error(`x ${WHSEC}`), { cause: 'fail.hub_unknown', stage: 'relay' });
      expect(await flushSentry(3000)).toBe(true);
      expect(got.length).toBeGreaterThan(0);
      expect(got[0]).toContain('/api/1/envelope/');
      const all = got.join('\n');
      expect(all).toContain('"release":"abc123"');
      expect(all).toContain('"environment":"test"');
      expect(all).toContain('hub-worker');
      for (const m of MINES) expect(all).not.toContain(m);
    } finally {
      await closeSentry();
      await new Promise((r) => srv.close(r));
    }
  });

  it('PII: email trong message bị che; poison_message và SyntaxError chỉ gửi class + code (bỏ message)', async () => {
    await start({ SENTRY_MAX_PER_MIN: '1000' });
    reportUnexpected(new Error('lỗi với user nguyen.van-a+x@congty.com.vn tên Nguyễn Văn A'), { cause: 'fail.hub_unknown', stage: 'normalize' });
    let parseErr: any;
    try {
      JSON.parse('{"email":"khach@mail.com","ten":"Tran Thi B"');
    } catch (e) {
      parseErr = e;
    }
    reportUnexpected(parseErr, { cause: 'fail.hub_unknown', stage: 'delivery' });
    reportUnexpected(Object.assign(new Error('Unexpected token khach@mail.com'), { code: 'E_PARSE' }), { cause: 'fail.poison_message', stage: 'ingest' });
    await flushSentry();
    const out = bodies();
    for (const m of ['nguyen.van', 'congty.com', 'khach@mail', 'khach', 'Tran Thi']) expect(out).not.toContain(m);
    const byStage = Object.fromEntries(events().map((e) => [e.tags.stage, e.exception.values[0]]));
    expect(byStage.normalize.value).toContain('***@***');
    expect(byStage.delivery.type).toBe('SyntaxError');
    expect(byStage.delivery.value).toBe('');
    expect(byStage.ingest.value).toBe('E_PARSE');
  });

  it('beforeSend che email ở mọi chuỗi của event (lớp cuối)', () => {
    const e = scrubSentryEvent({ message: 'a@b.co', tags: { svc: 'x' }, exception: { values: [{ type: 'E', value: 'gửi tới lan@x.vn' }] } });
    expect(JSON.stringify(e)).not.toMatch(/@(b\.co|x\.vn)/);
    expect(maskEmails('a.b@c.io và d@e.com')).toBe('***@*** và ***@***');
  });

  it('errClass (rẻ) luôn trùng errInfo().class', () => {
    class MyErr extends Error {}
    const prisma = Object.assign(new Error('p'), { name: 'PrismaClientKnownRequestError' });
    for (const v of [new Error('a'), new TypeError('b'), new MyErr('c'), prisma, 'chuỗi', null, undefined, { class: 'K', code: 'C', msg: 'm' }, { name: 'Lạ' }]) {
      expect(errClass(v)).toBe(errInfo(v).class);
    }
  });

  it('trần map seen = 500 fingerprint (bơm 600 không phình)', async () => {
    await start({ SENTRY_MAX_PER_MIN: '100000', SENTRY_DEDUPE_WINDOW_MS: '600000' });
    for (let i = 0; i < 600; i++) reportUnexpected(new Error('x'), { cause: 'fail.hub_unknown', stage: `st${i}` }, 1000 + i);
    expect(sentryStats().sent).toBe(600);
    expect(sentryInternalSeenSize()).toBe(500);
    // fingerprint cũ nhất (st0) đã bị đẩy ra -> gửi lại được; st599 còn -> dedupe
    expect(reportUnexpected(new Error('x'), { cause: 'fail.hub_unknown', stage: 'st0' }, 2000)).not.toBeNull();
    expect(reportUnexpected(new Error('x'), { cause: 'fail.hub_unknown', stage: 'st599' }, 2001)).toBeNull();
  });

  it('dedupe/trần kiểm TRƯỚC khi dựng thế thân (không gọi errInfo/đọc stack khi bị chặn)', async () => {
    await start({ SENTRY_MAX_PER_MIN: '1', SENTRY_DEDUPE_WINDOW_MS: '600000' });
    let reads = 0;
    const mk = () => Object.defineProperty(new Error('x'), 'stack', { get: () => (reads++, 'Error: x\n    at f (a.ts:1:1)') });
    expect(reportUnexpected(mk(), { cause: 'fail.hub_unknown', stage: 'a' }, 10)).not.toBeNull();
    const after1 = reads;
    expect(after1).toBeGreaterThan(0);
    reportUnexpected(mk(), { cause: 'fail.hub_unknown', stage: 'a' }, 20); // dedupe
    reportUnexpected(mk(), { cause: 'fail.hub_unknown', stage: 'b' }, 30); // trần
    expect(reads).toBe(after1);
    expect(sentryStats()).toMatchObject({ sent: 1, deduped: 1, dropped: 1 });
  });

  it('thẻ id sai định dạng bị BỎ (không gắn, không làm sạch)', async () => {
    await start();
    reportUnexpected(new Error('x'), { cause: 'fail.hub_unknown', stage: 'ingest', traceId: 'Nguyen Van A <a@b.com>', requestId: 'a@b.com', tenantId: 'ten khách hàng', provider: 'GitHub Inc', attempt: 5, httpStatus: 500 });
    reportUnexpected(new Error('x'), { cause: 'fail.hub_unknown', stage: 'normalize', traceId: 'c'.repeat(32), requestId: 'req-1.abc_2', tenantId: 'cl9x_Tenant-1', provider: 'github' });
    await flushSentry();
    const [bad, good] = events();
    expect(bad.tags.trace_id).toBeUndefined();
    expect(bad.tags.request_id).toBeUndefined();
    expect(bad.tags.tenant_id).toBeUndefined();
    expect(bad.tags.provider).toBeUndefined();
    expect(bad.tags).toMatchObject({ attempt: '5', http_status: '500' });
    expect(good.tags).toMatchObject({ trace_id: 'c'.repeat(32), request_id: 'req-1.abc_2', tenant_id: 'cl9x_Tenant-1', provider: 'github' });
  });

  it('crash handler: ghi log kèm stack đã scrub TRƯỚC flush rồi exit(1)', async () => {
    sent = [];
    const order: string[] = [];
    const logSpy = jest.spyOn(logger, 'error').mockImplementation(((o: any) => { order.push(o?.err instanceof Error ? 'log:stack' : 'log'); }) as any);
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(((c: number) => { order.push(`exit:${c}`); }) as any);
    const before = process.listenerCount('uncaughtException');
    expect(initSentry('hub-worker', { SENTRY_DSN: DSN } as any, { transport: () => ({ send: async (e: unknown) => { order.push('send'); sent.push(e); return {}; }, flush: async () => true }) })).toBe(true);
    expect(process.listenerCount('uncaughtException')).toBe(before + 1);
    const handler = process.listeners('uncaughtException').slice(-1)[0] as any;
    handler(new Error('crash'), 'unhandledRejection');
    await new Promise((r) => setTimeout(r, 100));
    expect(order[0]).toBe('log:stack');
    expect(order.indexOf('send')).toBeGreaterThan(0);
    expect(order[order.length - 1]).toBe('exit:1');
    expect(events()[0].tags).toMatchObject({ origin: 'unhandledRejection', stage: 'process' });
    logSpy.mockRestore();
    exitSpy.mockRestore();
  });
});
