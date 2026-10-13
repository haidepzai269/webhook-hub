import * as http from 'http';
import * as https from 'https';
import * as net from 'net';
import { createHmac } from 'crypto';
import { aesGcmEncrypt } from '@hub/crypto';
import { CATALOG, GenericAdapter, ProviderRegistry } from '@hub/providers';
import { IngestService, MAX_INGEST_QUERY_CHARS } from '../src/modules/ingest/ingest.service';
import { parseSourceInput } from '../src/modules/service-api/source-input';

/**
 * PK4 (SPEC-provider-khac §6 + E3/E8/E9/E13/E20/E21/E27, ADR-205): bắt tay khai báo được, GET chỉ cho bắt tay, ack theo
 * cấu hình. L0: IngestService THẬT, Prisma/Redis giả — đếm được mọi ghi DB, mọi lệnh Redis, mọi lần phạt.
 *
 * Chuỗi bí mật dưới đây sinh lúc chạy (không literal secret).
 */
const MASTER = 'test-master-key-at-least-32-characters!!';
const SECRET = `sec-${process.pid}-${Date.now()}`;
const APP_SECRET = `app-${SECRET}`;
const VERIFY_TOKEN = `vt-${process.pid}-handshake`;
const IP = '203.0.113.9';

beforeAll(() => {
  process.env.MASTER_KEY = MASTER;
});
afterEach(() => jest.restoreAllMocks());

function build(verificationConfig: unknown) {
  const tx = { rawEvent: { create: jest.fn().mockResolvedValue({ id: 'raw-1' }) }, outbox: { create: jest.fn() }, sourceSecret: { create: jest.fn() } };
  const source = {
    id: 'src-1',
    tenantId: 'tenant-a',
    provider: 'generic',
    isActive: true,
    archivedAt: null,
    verificationConfig,
    secrets: [{ id: 's1', secretEncrypted: aesGcmEncrypt(SECRET, MASTER) }],
  };
  const prisma: any = {
    findSourceBySourceKeyForIngest: jest.fn().mockResolvedValue(source),
    rawEvent: { create: jest.fn() },
    tenantTx: jest.fn((_t: string, fn: any) => fn(tx)),
    forTenant: jest.fn(() => ({ addIngestDuplicates: async () => undefined, addSourceTraffic: async () => undefined })),
  };
  const redis: any = { checkRateLimit: jest.fn(async () => true), getIdempotencyKey: jest.fn(async () => null), setIdempotencyKey: jest.fn() };
  const svc = new IngestService(prisma, redis);
  const bad = jest.spyOn(svc.penalty, 'recordBadSignature');
  const redisCalls = () => redis.checkRateLimit.mock.calls.length + redis.getIdempotencyKey.mock.calls.length + redis.setIdempotencyKey.mock.calls.length;
  return { svc, prisma, redis, tx, bad, redisCalls };
}

function req(o: { method?: 'GET' | 'POST' | 'HEAD'; query?: string; body?: string; headers?: Record<string, string>; parse?: boolean }) {
  const body = o.body ?? '';
  return {
    provider: 'generic' as const,
    sourceKey: 'src_generic_k',
    headers: { ...(o.headers ?? {}) },
    rawBody: Buffer.from(body),
    body: o.parse === false || body === '' ? undefined : JSON.parse(body),
    contentType: o.headers?.['content-type'],
    ip: IP,
    method: o.method ?? 'POST',
    query: o.query ?? '',
  };
}

const hex = (key: string, data: string) => createHmac('sha256', key).update(data).digest('hex');

/** Một dòng REJECTED handshake (E8): signature_valid=true + __hub_meta.reason='handshake'. Không outbox. */
function expectHandshakeRow(tx: any) {
  expect(tx.rawEvent.create).toHaveBeenCalledTimes(1);
  const data = tx.rawEvent.create.mock.calls[0][0].data;
  expect(data.status).toBe('REJECTED');
  expect(data.signatureValid).toBe(true);
  expect(data.headers.__hub_meta.reason).toBe('handshake');
  expect(tx.outbox.create).not.toHaveBeenCalled();
  return data;
}

// ───── cấu hình ─────
const META = {
  scheme: 'hmac',
  header: 'x-hub-signature-256',
  prefix: 'sha256=',
  idempotency: { header: 'x-request-id' },
  eventType: 'meta.event',
  handshake: { kind: 'query-echo', param: 'hub.challenge', verifyTokenParam: 'hub.verify_token', verifyTokenEnc: aesGcmEncrypt(VERIFY_TOKEN, MASTER) },
};
const DROPBOX = { scheme: 'hmac', header: 'x-dropbox-signature', idempotency: { header: 'x-request-id' }, eventType: 'dropbox.event', handshake: { kind: 'query-echo', param: 'challenge' } };
const SLACK = {
  scheme: 'signed-template',
  template: 'v0:{timestamp}:{body}',
  signature: { headers: ['x-slack-signature'], prefix: 'v0=' },
  timestampHeader: 'x-slack-request-timestamp',
  toleranceSec: 300,
  idempotency: { field: 'event_id' },
  eventType: 'slack.event',
  handshake: { kind: 'body-echo', when: { field: 'type', equals: 'url_verification' }, echo: { field: 'challenge' } },
};
const TWITCH_WHEN = { kind: 'body-echo', when: { header: 'twitch-eventsub-message-type', equals: 'webhook_callback_verification' }, echo: { field: 'challenge' } };
const ASANA = { scheme: 'hmac', header: 'x-hook-signature', idempotency: { header: 'x-request-id' }, eventType: 'asana.event', handshake: { kind: 'header-echo', header: 'x-hook-secret' } };
const SNS = {
  scheme: 'static-token',
  location: 'query',
  param: 'token',
  idempotency: { header: 'x-amz-sns-message-id' },
  eventType: 'sns.message',
  handshake: { kind: 'manual-url', when: { field: 'Type', equals: 'SubscriptionConfirmation' }, urlField: 'SubscribeURL' },
};
const ZOOM = {
  scheme: 'signed-template',
  template: 'v0:{timestamp}:{body}',
  signature: { headers: ['x-zm-signature'], prefix: 'v0=' },
  timestampHeader: 'x-zm-request-timestamp',
  toleranceSec: 300,
  idempotency: { header: 'x-zm-request-id' },
  eventType: 'zoom.event',
  handshake: { kind: 'hmac-echo', when: { field: 'event', equals: 'endpoint.url_validation' }, tokenParent: 'payload', tokenField: 'plainToken', macField: 'encryptedToken' },
};
const zoomSigned = (body: string, key = SECRET) => {
  const ts = String(Math.floor(Date.now() / 1000));
  return { 'content-type': 'application/json', 'x-zm-request-timestamp': ts, 'x-zm-signature': `v0=${hex(key, `v0:${ts}:${body}`)}`, 'x-zm-request-id': 'zm-1' };
};

describe('[PK:T10] (phần a) 5 biến thể bắt tay: đúng khuôn, 0 outbox / 0 SET NX / 0 lệnh Redis, một dòng REJECTED handshake', () => {
  it('query-echo (Meta): GET hub.challenge + đúng hub.verify_token -> 200 text/plain challenge, nosniff', async () => {
    const t = build(META);
    const r = await t.svc.ingestWebhook(req({ method: 'GET', query: `hub.mode=subscribe&hub.challenge=1158201444&hub.verify_token=${VERIFY_TOKEN}` }));
    expect(r).toMatchObject({ status: 200, body: '1158201444', contentType: 'text/plain; charset=utf-8' });
    expect(r.headers).toMatchObject({ 'X-Content-Type-Options': 'nosniff' });
    expectHandshakeRow(t.tx);
    expect(t.redisCalls()).toBe(0);
    expect(t.bad).not.toHaveBeenCalled();
  });

  it('query-echo không verify token (Dropbox): GET ?challenge -> 200 echo', async () => {
    const t = build(DROPBOX);
    const r = await t.svc.ingestWebhook(req({ method: 'GET', query: 'challenge=abc_DEF-123' }));
    expect(r).toMatchObject({ status: 200, body: 'abc_DEF-123' });
    expectHandshakeRow(t.tx);
    expect(t.redisCalls()).toBe(0);
  });

  it('body-echo (Slack url_verification, when = field): 200 text/plain challenge — trước verify', async () => {
    const t = build(SLACK);
    const body = JSON.stringify({ token: 'XXYYZZ', challenge: 'PLACEHOLDER_challenge_value', type: 'url_verification' });
    const r = await t.svc.ingestWebhook(req({ body, headers: { 'content-type': 'application/json' } }));
    expect(r).toMatchObject({ status: 200, body: 'PLACEHOLDER_challenge_value', contentType: 'text/plain; charset=utf-8' });
    expectHandshakeRow(t.tx);
    expect(t.redisCalls()).toBe(0);
  });

  it('body-echo (Twitch, when = header): webhook_callback_verification -> challenge thô', async () => {
    const t = build({ ...SLACK, handshake: TWITCH_WHEN });
    const body = JSON.stringify({ challenge: 'pogchamp-kappa-360noscope-vohiyo', subscription: { status: 'webhook_callback_verification_pending' } });
    const r = await t.svc.ingestWebhook(req({ body, headers: { 'twitch-eventsub-message-type': 'webhook_callback_verification' } }));
    expect(r).toMatchObject({ status: 200, body: 'pogchamp-kappa-360noscope-vohiyo' });
    expectHandshakeRow(t.tx);
    // Header khác giá trị -> không phải bắt tay -> đi verify như thường (không ký -> 401).
    const t2 = build({ ...SLACK, handshake: TWITCH_WHEN });
    const r2 = await t2.svc.ingestWebhook(req({ body, headers: { 'twitch-eventsub-message-type': 'notification' } }));
    expect(r2.status).toBe(401);
  });

  it('header-echo (Asana X-Hook-Secret): 200, trả lại đúng header đó, body rỗng; KHÔNG ghi SourceSecret', async () => {
    const t = build(ASANA);
    const hook = `hs-${process.pid}-x`;
    const r = await t.svc.ingestWebhook(req({ headers: { 'x-hook-secret': hook } }));
    expect(r.status).toBe(200);
    expect(r.body).toBeNull();
    expect(r.headers).toEqual({ 'x-hook-secret': hook });
    const row = expectHandshakeRow(t.tx);
    expect(JSON.stringify(row.headers)).not.toContain(hook); // dòng lưu chỉ có header ĐÃ che (x-hook-secret mang bí mật)
    expect(t.tx.sourceSecret.create).not.toHaveBeenCalled();
    expect(t.redisCalls()).toBe(0);
  });

  it('manual-url (SNS SubscriptionConfirmation, text/plain): 200, lưu SubscribeURL vào meta; hub KHÔNG gọi ra ngoài (spy fetch/http/https)', async () => {
    // http/https.request không spy được (thuộc tính không cấu hình lại được) -> chặn ở tầng socket: MỌI kết nối ra ngoài
    // (http, https, undici/fetch) đều đi qua net.Socket.prototype.connect.
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    const connectSpy = jest.spyOn(net.Socket.prototype, 'connect');
    const agentSpy = jest.spyOn(http.Agent.prototype as any, 'createConnection');
    const httpsAgentSpy = jest.spyOn(https.Agent.prototype as any, 'createConnection');
    const t = build(SNS);
    const url = 'https://sns.us-west-2.amazonaws.com/?Action=ConfirmSubscription&TopicArn=arn:aws:sns:us-west-2:123456789012:MyTopic&Token=2336412f37';
    const body = JSON.stringify({ Type: 'SubscriptionConfirmation', MessageId: '165545c9-2a5c-472c-8df2-7ff2be2b3b1b', Token: '2336412f37', TopicArn: 'arn:aws:sns:us-west-2:123456789012:MyTopic', SubscribeURL: url });
    const r = await t.svc.ingestWebhook(req({ body, parse: false, headers: { 'content-type': 'text/plain; charset=UTF-8', 'x-amz-sns-message-type': 'SubscriptionConfirmation' } }));
    expect(r.status).toBe(200);
    const row = expectHandshakeRow(t.tx);
    expect(row.headers.__hub_meta.handshake).toEqual({ kind: 'manual-url', subscribeUrl: url });
    for (const s of [fetchSpy, connectSpy, agentSpy, httpsAgentSpy]) expect(s).not.toHaveBeenCalled();
    expect(t.redisCalls()).toBe(0);
  });

  it('hmac-echo (Zoom endpoint.url_validation) ký đúng: 200 JSON {plainToken, encryptedToken = hex HMAC-SHA256(secret, plainToken)} — sau verify', async () => {
    const t = build(ZOOM);
    const body = JSON.stringify({ payload: { plainToken: 'tok_PLACEHOLDER_A' }, event_ts: 1654503849680, event: 'endpoint.url_validation' });
    const r = await t.svc.ingestWebhook(req({ body, headers: zoomSigned(body) }));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ plainToken: 'tok_PLACEHOLDER_A', encryptedToken: hex(SECRET, 'tok_PLACEHOLDER_A') });
    expectHandshakeRow(t.tx);
    // Bắt tay KHÔNG qua EG3 (rate limit) — 0 lệnh Redis kể cả nhánh sau verify.
    expect(t.redisCalls()).toBe(0);
  });

  it('request thường (không phải bắt tay) của source có handshake vẫn đi đường cũ: ACCEPTED + outbox', async () => {
    const t = build(ZOOM);
    const body = JSON.stringify({ event: 'meeting.started', event_ts: 1, payload: { object: { id: '1' } } });
    const r = await t.svc.ingestWebhook(req({ body, headers: zoomSigned(body) }));
    expect(r.status).toBe(200);
    expect(t.tx.outbox.create).toHaveBeenCalledTimes(1);
    expect(t.tx.rawEvent.create.mock.calls[0][0].data.status).toBe('ACCEPTED');
  });

  it('E27: giá trị echo ngoài tập ký tự (dấu cách, CR/LF, > 256) -> 400, KHÔNG ghi DB, không phạt', async () => {
    for (const [cfg, mk] of [
      [DROPBOX, (v: string) => req({ method: 'GET', query: `challenge=${encodeURIComponent(v)}` })],
      [SLACK, (v: string) => req({ body: JSON.stringify({ type: 'url_verification', challenge: v }) })],
      [ASANA, (v: string) => req({ headers: { 'x-hook-secret': v } })],
    ] as const) {
      for (const v of ['a b', 'x\r\nSet-Cookie: a=1', 'y'.repeat(257), '<script>é']) {
        const t = build(cfg);
        const r = await t.svc.ingestWebhook(mk(v));
        expect([v.slice(0, 10), r.status]).toEqual([v.slice(0, 10), 400]);
        expect(t.tx.rawEvent.create).not.toHaveBeenCalled();
        expect(t.bad).not.toHaveBeenCalled();
      }
    }
  });
});

describe('[PK:T35] hmac-echo (E3): không bao giờ là máy ký hộ', () => {
  it('request bắt tay KHÔNG ký / ký sai -> không echo: rejectStatus (401), không có chữ ký trong body, recordBadSignature', async () => {
    for (const headers of [{ 'content-type': 'application/json' }, zoomSigned('{"other":1}')]) {
      const t = build(ZOOM);
      const body = JSON.stringify({ payload: { plainToken: 'tok_PLACEHOLDER_A' }, event_ts: 1, event: 'endpoint.url_validation' });
      const r = await t.svc.ingestWebhook(req({ body, headers }));
      expect(r.status).toBe(401);
      expect(JSON.stringify(r.body)).not.toContain(hex(SECRET, 'tok_PLACEHOLDER_A'));
      expect(JSON.stringify(r.body)).not.toContain('encryptedToken');
      expect(t.bad).toHaveBeenCalledTimes(1);
      expect(t.tx.rawEvent.create.mock.calls[0][0].data.signatureValid).toBe(false);
    }
  });

  it('plainToken có `:` / `{` / `.` / dài > 128 (dù request ký ĐÚNG) -> 400, không có chữ ký nào trả ra', async () => {
    for (const plainToken of ['v0:1700000000:{"evil":1}', 'a{b', 'a.b', 'z'.repeat(129), '']) {
      const t = build(ZOOM);
      const body = JSON.stringify({ payload: { plainToken }, event: 'endpoint.url_validation' });
      const r = await t.svc.ingestWebhook(req({ body, headers: zoomSigned(body) }));
      expect([plainToken.slice(0, 12), r.status]).toEqual([plainToken.slice(0, 12), 400]);
      expect(JSON.stringify(r.body)).not.toContain(hex(SECRET, plainToken));
      expect(t.tx.rawEvent.create).not.toHaveBeenCalled();
    }
  });

  it('xoay khoá: ký bằng ĐÚNG secret đã verify request (secret thứ hai)', async () => {
    const t = build(ZOOM);
    const other = `old-${process.pid}`;
    t.prisma.findSourceBySourceKeyForIngest.mockResolvedValue({
      id: 'src-1', tenantId: 'tenant-a', provider: 'generic', isActive: true, archivedAt: null, verificationConfig: ZOOM,
      secrets: [{ id: 's0', secretEncrypted: aesGcmEncrypt(other, MASTER) }, { id: 's1', secretEncrypted: aesGcmEncrypt(SECRET, MASTER) }],
    });
    const body = JSON.stringify({ payload: { plainToken: 'tok_1' }, event: 'endpoint.url_validation' });
    const r = await t.svc.ingestWebhook(req({ body, headers: zoomSigned(body) }));
    expect(r.body).toEqual({ plainToken: 'tok_1', encryptedToken: hex(SECRET, 'tok_1') });
  });

  it('adapter: pha before-verify KHÔNG bao giờ trả lời hmac-echo (chỉ after-verify)', () => {
    const a = new GenericAdapter();
    const body = JSON.stringify({ payload: { plainToken: 'tok_1' }, event: 'endpoint.url_validation' });
    expect(a.handshake(req({ body }) as any, [SECRET], { verificationConfig: ZOOM }, 'before-verify')).toBeNull();
  });
});

describe('[PK:T11] (phần a) GET chỉ cho bắt tay; HEAD 405; sai verify token -> rejectStatus + phạt', () => {
  it('GET vào source KHÔNG có query-echo -> 405 method_not_allowed, 0 ghi DB, không phạt, không verify', async () => {
    const verify = jest.spyOn(ProviderRegistry.get('generic'), 'verify');
    for (const cfg of [SLACK, ASANA, { ...SLACK, handshake: undefined }]) {
      const t = build(cfg);
      const r = await t.svc.ingestWebhook(req({ method: 'GET', query: 'challenge=1&hub.challenge=2' }));
      expect(r).toEqual({ status: 405, body: { error: 'method_not_allowed' } });
      expect(t.tx.rawEvent.create).not.toHaveBeenCalled();
      expect(t.bad).not.toHaveBeenCalled();
    }
    expect(verify).not.toHaveBeenCalled();
  });

  it('GET query-echo nhưng thiếu param / param lặp -> 405; HEAD (cả với param đúng) -> 405', async () => {
    for (const r0 of [req({ method: 'GET', query: '' }), req({ method: 'GET', query: 'challenge=1&challenge=2' }), req({ method: 'HEAD', query: 'challenge=1' })]) {
      const t = build(DROPBOX);
      const r = await t.svc.ingestWebhook(r0);
      expect(r.status).toBe(405);
      expect(t.tx.rawEvent.create).not.toHaveBeenCalled();
    }
  });

  it('GET query-echo sai / thiếu verify_token -> rejectStatus (mặc định 401; khai 403), dòng REJECTED signature_valid=false, recordBadSignature, không echo', async () => {
    for (const [cfg, status] of [[META, 401], [{ ...META, ack: { rejectStatus: 403 } }, 403]] as const) {
      for (const q of ['hub.challenge=777&hub.verify_token=wrong-token-xx', 'hub.challenge=777']) {
        const t = build(cfg);
        const r = await t.svc.ingestWebhook(req({ method: 'GET', query: q }));
        expect(r.status).toBe(status);
        expect(JSON.stringify(r.body)).not.toContain('777');
        expect(t.bad).toHaveBeenCalledTimes(1);
        expect(t.tx.rawEvent.create.mock.calls[0][0].data.signatureValid).toBe(false);
      }
    }
  });

  it('verifyTokenEnc giải mã hỏng (master key khác) -> fail-closed: reject, không echo', async () => {
    const t = build({ ...META, handshake: { ...META.handshake, verifyTokenEnc: aesGcmEncrypt(VERIFY_TOKEN, 'another-master-key-at-least-32-characters!') } });
    const r = await t.svc.ingestWebhook(req({ method: 'GET', query: `hub.challenge=777&hub.verify_token=${VERIFY_TOKEN}` }));
    expect(r.status).toBe(401);
  });

  it('E27: query > 8KB -> 414 trước khi nạp source (0 DB)', async () => {
    const t = build(DROPBOX);
    const r = await t.svc.ingestWebhook(req({ method: 'GET', query: `challenge=${'a'.repeat(MAX_INGEST_QUERY_CHARS)}` }));
    expect(r.status).toBe(414);
    expect(t.prisma.findSourceBySourceKeyForIngest).not.toHaveBeenCalled();
  });

  it('adapter không cài acceptsMethod (github) -> GET 405', async () => {
    const t = build(null);
    t.prisma.findSourceBySourceKeyForIngest.mockResolvedValue({ id: 'g', tenantId: 'tenant-a', provider: 'github', isActive: true, archivedAt: null, secrets: [] });
    const r = await t.svc.ingestWebhook({ ...req({ method: 'GET', query: 'challenge=1' }), provider: 'github' as const });
    expect(r.status).toBe(405);
  });
});

describe('[PK:T12] (phần a) ack theo cấu hình: rejectStatus 503 vẫn phạt; 2xx khi từ chối bị cấm', () => {
  it('rejectStatus 503 + chữ ký sai -> 503, REJECTED, recordBadSignature (E21: mã đổi, luật phạt không)', async () => {
    const t = build({ ...ASANA, ack: { rejectStatus: 503 } });
    const r = await t.svc.ingestWebhook(req({ body: '{"events":[]}', headers: { 'x-hook-signature': 'deadbeef', 'x-request-id': 'r1' } }));
    expect(r.status).toBe(503);
    expect(t.tx.rawEvent.create.mock.calls[0][0].data.status).toBe('REJECTED');
    expect(t.bad).toHaveBeenCalledTimes(1);
  });

  it('cấu hình rejectStatus 2xx (200/204/202) hoặc lạ -> 422 lúc lưu config, đúng tên trường', () => {
    for (const rejectStatus of [200, 202, 204, 302, 400, '401']) {
      expect(() => parseSourceInput({ provider: 'generic', name: 'x', secret: SECRET, verificationConfig: { ...ASANA, ack: { rejectStatus } } })).toThrow(
        expect.objectContaining({ response: expect.objectContaining({ field: 'verificationConfig.ack.rejectStatus' }) }),
      );
    }
    for (const successStatus of [201, 400, 500]) {
      expect(() => parseSourceInput({ provider: 'generic', name: 'x', secret: SECRET, verificationConfig: { ...ASANA, ack: { successStatus } } })).toThrow(
        expect.objectContaining({ response: expect.objectContaining({ field: 'verificationConfig.ack.successStatus' }) }),
      );
    }
  });

  it('lõi kẹp: adapter trả 2xx cho từ chối -> vẫn 401 (không tin adapter)', async () => {
    const t = build(ASANA);
    const adapter = ProviderRegistry.get('generic');
    jest.spyOn(adapter, 'buildAck').mockReturnValue({ status: 200, body: { ok: true } });
    const r = await t.svc.ingestWebhook(req({ body: '{"events":[]}', headers: { 'x-hook-signature': 'deadbeef', 'x-request-id': 'r1' } }));
    expect(r.status).toBe(401);
  });

  it('successStatus 204 -> 204 không body, SAU COMMIT (outbox đã ghi); trùng cũng 204', async () => {
    const t = build({ ...ASANA, ack: { successStatus: 204 } });
    const body = '{"events":[{"action":"changed"}]}';
    const r = await t.svc.ingestWebhook(req({ body, headers: { 'x-hook-signature': hex(SECRET, body), 'x-request-id': 'r1' } }));
    expect(r).toEqual({ status: 204, body: null });
    expect(t.tx.outbox.create).toHaveBeenCalledTimes(1);
    t.redis.getIdempotencyKey.mockResolvedValue('raw-1');
    const again = await t.svc.ingestWebhook(req({ body, headers: { 'x-hook-signature': hex(SECRET, body), 'x-request-id': 'r1' } }));
    expect(again).toEqual({ status: 204, body: null });
  });

  it('successStatus 202 -> 202 kèm body ok', async () => {
    const t = build({ ...ASANA, ack: { successStatus: 202 } });
    const body = '{"events":[]}';
    const r = await t.svc.ingestWebhook(req({ body, headers: { 'x-hook-signature': hex(SECRET, body), 'x-request-id': 'r2' } }));
    expect(r).toEqual({ status: 202, body: { ok: true } });
  });
});

describe('[PK:T13] adoptSecret (E20): chỉ ở chế độ thu (PK6) — source PK4 đã có secret thì 422; header-echo không đổi SourceSecret', () => {
  it('header-echo + adoptSecret -> 422 field verificationConfig.handshake.adoptSecret', () => {
    expect(() =>
      parseSourceInput({ provider: 'generic', name: 'x', secret: SECRET, verificationConfig: { ...ASANA, handshake: { kind: 'header-echo', header: 'x-hook-secret', adoptSecret: true } } }),
    ).toThrow(expect.objectContaining({ response: expect.objectContaining({ field: 'verificationConfig.handshake.adoptSecret' }) }));
  });

  it('request bắt tay thứ hai mang secret khác: không ghi SourceSecret, verify vẫn dùng secret cũ', async () => {
    const t = build(ASANA);
    await t.svc.ingestWebhook(req({ headers: { 'x-hook-secret': 'first-secret-xx' } }));
    await t.svc.ingestWebhook(req({ headers: { 'x-hook-secret': 'second-secret-yy' } }));
    expect(t.tx.sourceSecret.create).not.toHaveBeenCalled();
    const body = '{"events":[]}';
    const bad = await t.svc.ingestWebhook(req({ body, headers: { 'x-hook-signature': hex('second-secret-yy', body), 'x-request-id': 'r3' } }));
    expect(bad.status).toBe(401);
    const ok = await t.svc.ingestWebhook(req({ body, headers: { 'x-hook-signature': hex(SECRET, body), 'x-request-id': 'r3' } }));
    expect(ok.status).toBe(200);
  });
});

describe('PK4 (E13): verifyToken lưu mã hoá trong verificationConfig, KHÔNG phải SourceSecret', () => {
  const base = { provider: 'generic', name: 'Meta', secret: APP_SECRET };
  const vc = (h: Record<string, unknown>) => ({ ...META, handshake: { kind: 'query-echo', param: 'hub.challenge', verifyTokenParam: 'hub.verify_token', ...h } });

  it('verifyToken rõ -> verifyTokenEnc (giải mã ra đúng token); không còn verifyToken; secret vẫn là secret', () => {
    const out = parseSourceInput({ ...base, verificationConfig: vc({ verifyToken: VERIFY_TOKEN }) });
    const h = out.verificationConfig!.handshake as Record<string, unknown>;
    expect(h.verifyToken).toBeUndefined();
    expect(typeof h.verifyTokenEnc).toBe('string');
    expect(JSON.stringify(out.verificationConfig)).not.toContain(VERIFY_TOKEN);
    expect(out.secret).toBe(APP_SECRET);
    const { aesGcmDecrypt } = require('@hub/crypto');
    expect(aesGcmDecrypt(h.verifyTokenEnc, MASTER)).toBe(VERIFY_TOKEN);
  });

  it('client gửi verifyTokenEnc -> 422; verifyTokenParam thiếu verifyToken -> 422; verifyToken ngắn / có dấu cách -> 422', () => {
    const field = (v: unknown) => {
      try {
        parseSourceInput({ ...base, verificationConfig: v });
        return null;
      } catch (e: any) {
        return e?.response?.field;
      }
    };
    expect(field(vc({ verifyTokenEnc: 'abc' }))).toBe('verificationConfig.handshake.verifyTokenEnc');
    expect(field(vc({}))).toBe('verificationConfig.handshake.verifyToken');
    expect(field(vc({ verifyToken: 'short' }))).toBe('verificationConfig.handshake.verifyToken');
    expect(field(vc({ verifyToken: 'has space inside' }))).toBe('verificationConfig.handshake.verifyToken');
    expect(field({ ...DROPBOX, handshake: { kind: 'query-echo', param: 'challenge', verifyToken: VERIFY_TOKEN } })).toBe('verificationConfig.handshake.verifyToken');
  });
});

describe('[PK:T10] (phần c) Lắng nghe: dòng bắt tay -> diagnosis handshake + kind; manual-url kèm SubscribeURL, không lộ giá trị khác', () => {
  it('inspectSourceRows', async () => {
    const { inspectSourceRows } = require('../src/modules/service-api/source-inspect');
    const id = '55555555-5555-5555-5555-555555555555';
    const url = 'https://sns.us-west-2.amazonaws.com/?Action=ConfirmSubscription&Token=t1';
    const rows = [
      { id: 'h1', status: 'REJECTED', signatureValid: true, headers: { 'x-hook-secret': '***', __hub_meta: { reason: 'handshake', handshake: { kind: 'header-echo' } } }, body: { a: 'BODYVAL' }, receivedAt: new Date(1) },
      { id: 'h2', status: 'REJECTED', signatureValid: true, headers: { __hub_meta: { reason: 'handshake', handshake: { kind: 'manual-url', subscribeUrl: url } } }, body: { Token: 'BODYVAL' }, receivedAt: new Date(2) },
      { id: 'r3', status: 'REJECTED', signatureValid: true, headers: { __hub_meta: { bodyTruncated: false } }, body: {}, receivedAt: new Date(3) },
    ];
    const repo = { findSourceById: async () => ({ id, provider: 'generic', verificationConfig: ASANA }), findRecentRawEventsForInspect: async () => rows };
    const out = await inspectSourceRows(repo, id);
    expect(out[0]).toEqual({ id: 'h1', receivedAt: new Date(1), status: 'REJECTED', diagnosis: { ok: true, reason: 'handshake' }, handshake: { kind: 'header-echo' } });
    expect(out[1].handshake).toEqual({ kind: 'manual-url', subscribeUrl: url });
    expect(out[2].diagnosis).toMatchObject({ reason: 'missing_idempotency_key' }); // không phải bắt tay -> như cũ
    expect(JSON.stringify(out)).not.toContain('BODYVAL');
  });
});

describe('[PK:T10] (phần e) mục danh mục chuyển sang entries ở PK4 (slack, twitch): config của mục bắt tay được qua ingest thật', () => {
  const cfg = (id: string) => (CATALOG.find((e) => e.id === id)!.handler as { config: unknown }).config;

  it('slack: url_verification -> 200 challenge; event_callback ký đúng -> ACCEPTED', async () => {
    const t = build(cfg('slack'));
    const hs = await t.svc.ingestWebhook(req({ body: JSON.stringify({ token: 'XXYYZZ', challenge: 'PLACEHOLDER_ch_1', type: 'url_verification' }) }));
    expect(hs).toMatchObject({ status: 200, body: 'PLACEHOLDER_ch_1' });
    const body = JSON.stringify({ type: 'event_callback', event_id: 'Ev123ABC456', event: { type: 'x' } });
    const ts = String(Math.floor(Date.now() / 1000));
    const ok = await t.svc.ingestWebhook(req({ body, headers: { 'x-slack-request-timestamp': ts, 'x-slack-signature': `v0=${hex(SECRET, `v0:${ts}:${body}`)}` } }));
    expect(ok.status).toBe(200);
    expect(t.tx.outbox.create).toHaveBeenCalledTimes(1);
  });

  it('twitch: webhook_callback_verification -> 200 challenge thô; notification ký đúng -> ACCEPTED', async () => {
    const t = build(cfg('twitch'));
    const vbody = JSON.stringify({ challenge: 'pogchamp-kappa-360noscope-vohiyo', subscription: { status: 'webhook_callback_verification_pending' } });
    const hs = await t.svc.ingestWebhook(req({ body: vbody, headers: { 'twitch-eventsub-message-type': 'webhook_callback_verification' } }));
    expect(hs).toMatchObject({ status: 200, body: 'pogchamp-kappa-360noscope-vohiyo' });
    const body = JSON.stringify({ subscription: { type: 'channel.follow' }, event: { user_id: '1' } });
    const id = 'e76c6bd4-55c9-4987-8304-da1588d8988b';
    const ts = new Date().toISOString();
    const ok = await t.svc.ingestWebhook(
      req({ body, headers: { 'twitch-eventsub-message-type': 'notification', 'twitch-eventsub-message-id': id, 'twitch-eventsub-message-timestamp': ts, 'twitch-eventsub-message-signature': `sha256=${hex(SECRET, id + ts + body)}` } }),
    );
    expect(ok.status).toBe(200);
    expect(t.tx.outbox.create).toHaveBeenCalledTimes(1);
  });
});
