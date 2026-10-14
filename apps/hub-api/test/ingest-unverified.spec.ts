import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { HttpException } from '@nestjs/common';
import { GenericAdapter } from '@hub/providers';
import { toWebhookBody } from '@hub/common';
import { unwrapUnverified } from '@hub/sdk';
import { IngestService, publicHooksUrl } from '../src/modules/ingest/ingest.service';
import { parseSourceInput } from '../src/modules/service-api/source-input';
import { ingestRequests } from '../src/modules/metrics/metrics';

/**
 * PK5 (SPEC-provider-khac §7 + E5/E6/E7/E14/E17/E18, ADR-206): nguồn `unverified` ("đích tự kiểm") qua IngestService THẬT,
 * Prisma/Redis giả — đếm được mọi ghi DB, lệnh Redis, lần phạt. Scheme này không có secret; chuỗi bí mật của provider giả
 * (Twilio auth token) sinh lúc chạy.
 */
const IP = '203.0.113.77';
const BASE = { scheme: 'unverified', eventType: 'momo.ipn' };

function build(verificationConfig: unknown, allowUnverified: boolean) {
  const tx = { rawEvent: { create: jest.fn(async ({ data }: any) => ({ id: `raw-${data.idempotencyKey}` })) }, outbox: { create: jest.fn() } };
  const source = { id: 'src-u', tenantId: 'tenant-a', provider: 'generic', isActive: true, archivedAt: null, verificationConfig, allowUnverified, secrets: [] };
  const prisma: any = {
    findSourceBySourceKeyForIngest: jest.fn().mockResolvedValue(source),
    rawEvent: { create: jest.fn() },
    tenantTx: jest.fn((_t: string, fn: any) => fn(tx)),
    forTenant: jest.fn(() => ({ addIngestDuplicates: async () => undefined, addSourceTraffic: async () => undefined })),
  };
  const redis: any = { checkRateLimit: jest.fn(async () => true), getIdempotencyKey: jest.fn(async () => null), setIdempotencyKey: jest.fn() };
  const svc = new IngestService(prisma, redis);
  const bad = jest.spyOn(svc.penalty, 'recordBadSignature');
  const traffic = jest.spyOn(svc.traffic, 'record');
  const redisCalls = () => redis.checkRateLimit.mock.calls.length + redis.getIdempotencyKey.mock.calls.length + redis.setIdempotencyKey.mock.calls.length;
  return { svc, prisma, redis, tx, bad, traffic, redisCalls };
}

function req(body: string | Buffer, o: { headers?: Record<string, string>; contentType?: string; parse?: boolean; query?: string } = {}) {
  const raw = Buffer.isBuffer(body) ? body : Buffer.from(body);
  let parsed: unknown;
  if (o.parse !== false) {
    try {
      parsed = JSON.parse(raw.toString('utf8'));
    } catch {
      parsed = undefined;
    }
  }
  return {
    provider: 'generic' as const,
    sourceKey: 'src_generic_unv',
    headers: { 'content-type': o.contentType ?? 'application/json', ...(o.headers ?? {}) },
    rawBody: raw,
    body: parsed,
    contentType: o.contentType ?? 'application/json',
    ip: IP,
    method: 'POST' as const,
    query: o.query ?? '',
  };
}

beforeAll(() => {
  // Ingest giải mã secret bằng master key (nguồn unverified không có secret nào, nhưng lõi vẫn đọc khoá). Sinh lúc chạy.
  process.env.MASTER_KEY = randomBytes(24).toString('hex');
});

const metric = async (outcome: string) => (await ingestRequests.get()).values.find((v) => v.labels.provider === 'generic' && v.labels.outcome === outcome)?.value ?? 0;

afterEach(() => {
  jest.restoreAllMocks();
  delete process.env.HUB_PUBLIC_URL;
});

describe('[PK5] ingest nguồn unverified (khoá 1, E5/E14/E17)', () => {
  it('[PK:T14] (phần b) cờ project TẮT -> rejectStatus (401, hoặc 403 nếu khai), 0 ghi DB, không phạt, không lưu lượng, metric INVALID, 0 lệnh Redis', async () => {
    for (const [vc, status] of [
      [BASE, 401],
      [{ ...BASE, ack: { rejectStatus: 403 } }, 403],
    ] as const) {
      const t = build(vc, false);
      const before = await metric('INVALID');
      const r = await t.svc.ingestWebhook(req('{"transId":"T1"}'));
      expect(r.status).toBe(status);
      expect(r.body).toMatchObject({ ok: false, error: 'source_unverified_disabled', fix: expect.stringMatching(/Accept unverified sources/) });
      expect(t.tx.rawEvent.create).not.toHaveBeenCalled();
      expect(t.prisma.rawEvent.create).not.toHaveBeenCalled();
      expect(t.tx.outbox.create).not.toHaveBeenCalled();
      expect(t.bad).not.toHaveBeenCalled();
      expect(t.traffic).not.toHaveBeenCalled();
      expect(t.redisCalls()).toBe(0);
      expect((await metric('INVALID')) - before).toBe(1);
    }
  });

  it('[PK:T14] (phần c) cờ BẬT -> ACCEPTED: raw_events.verified=false, signature_valid=true (không mở cảnh báo chữ ký), outbox cùng tx; không cần SourceSecret', async () => {
    const t = build(BASE, true);
    const r = await t.svc.ingestWebhook(req('{"transId":"T1"}'));
    expect(r.status).toBe(200);
    const data = t.tx.rawEvent.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ status: 'ACCEPTED', verified: false, signatureValid: true, signatureHeader: null });
    expect(t.tx.outbox.create).toHaveBeenCalledTimes(1);
    expect(t.bad).not.toHaveBeenCalled();
    expect(t.redisCalls()).toBe(3); // EVAL + GET + SET — như mọi nguồn generic (ngân sách không đổi)
    // ack theo cấu hình (PK4) vẫn áp: successStatus 204.
    const t2 = build({ ...BASE, ack: { successStatus: 204 } }, true);
    expect((await t2.svc.ingestWebhook(req('{"transId":"T2"}'))).status).toBe(204);
  });

  it('[PK:T37] (phần b) nguồn unverified không bao giờ đi nhánh "chữ ký sai": 50 request cờ tắt + 50 cờ bật -> 0 recordBadSignature, 0 dòng signature_valid=false', async () => {
    for (const allow of [false, true]) {
      const t = build(BASE, allow);
      for (let i = 0; i < 50; i++) await t.svc.ingestWebhook(req(JSON.stringify({ transId: `T${i}` })));
      expect(t.bad).not.toHaveBeenCalled();
      expect(t.tx.rawEvent.create.mock.calls.filter((c: any) => c[0].data.signatureValid === false)).toHaveLength(0);
    }
  });

  it('[PK:T38] (phần c) hai body KHÁC nhau cùng transId -> CẢ HAI ACCEPTED (khoá ghép bodyHash, E7); gửi lại đúng từng byte -> trùng ở Postgres', async () => {
    const t = build({ ...BASE, idempotency: { field: 'transId' } }, true);
    const forged = await t.svc.ingestWebhook(req('{"transId":"T1","amount":1}'));
    const real = await t.svc.ingestWebhook(req('{"transId":"T1","amount":50000}'));
    expect([forged.status, real.status]).toEqual([200, 200]);
    const keys = t.tx.rawEvent.create.mock.calls.map((c: any) => c[0].data.idempotencyKey);
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2);
    expect(keys.every((k: string) => /^generic:T1:[0-9a-f]{32}$/.test(k))).toBe(true);
    expect(t.redis.getIdempotencyKey.mock.calls.map((c: any) => c[0])).toEqual(keys.map((k: string) => `idem:src-u:${k}`));
  });

  it('[PK:T38] (phần d) E17: body 60KB vào nguồn unverified -> 413 kèm fix, 0 ghi, không phạt, 0 Redis', async () => {
    const t = build(BASE, true);
    const big = Buffer.from(JSON.stringify({ transId: 'T1', pad: 'x'.repeat(60 * 1024) }));
    const before = await metric('TOO_LARGE');
    const r = await t.svc.ingestWebhook(req(big));
    expect(r.status).toBe(413);
    expect(r.body).toMatchObject({ error: 'unverified_body_too_large', fix: expect.stringMatching(/45KB/) });
    expect(t.tx.rawEvent.create).not.toHaveBeenCalled();
    expect(t.bad).not.toHaveBeenCalled();
    expect(t.redisCalls()).toBe(0);
    expect((await metric('TOO_LARGE')) - before).toBe(1);
  });

  it('[PK:T17] (phần c) url dựng từ HUB_PUBLIC_URL LÚC NHẬN, lưu ở headers.__hub_meta.url; Host: evil.com không đổi gì; forwardUrl tắt -> không lưu url', async () => {
    process.env.HUB_PUBLIC_URL = 'https://hub.example.com';
    const t = build({ ...BASE, forwardUrl: true, forwardHeaders: ['x-twilio-signature'] }, true);
    await t.svc.ingestWebhook(req('{"a":1}', { headers: { host: 'evil.com', 'x-forwarded-host': 'evil.com', 'x-twilio-signature': 's' }, query: 'q=1' }));
    const stored = t.tx.rawEvent.create.mock.calls[0][0].data.headers;
    expect(stored.__hub_meta).toEqual({ method: 'POST', url: 'https://hub.example.com/hooks/generic/src_generic_unv?q=1' });
    expect(stored['x-twilio-signature']).toBe('s'); // header gửi kèm lưu nguyên văn (không thuộc danh sách che)
    const t2 = build(BASE, true);
    await t2.svc.ingestWebhook(req('{"a":1}', { headers: { host: 'evil.com' } }));
    expect(t2.tx.rawEvent.create.mock.calls[0][0].data.headers.__hub_meta).toEqual({ method: 'POST' });
    // Hub không có URL công khai (localhost) -> null, không bao giờ rơi về Host.
    expect(publicHooksUrl({ provider: 'generic', sourceKey: 'k', query: '' }, { HUB_PUBLIC_URL: 'http://localhost:4000' })).toBeNull();
  });
});

describe('[PK5] tạo nguồn unverified (E14, E24)', () => {
  const call = (body: unknown) => {
    try {
      return { ok: true, value: parseSourceInput(body) };
    } catch (e) {
      if (e instanceof HttpException) return { ok: false, value: e.getResponse() as any };
      throw e;
    }
  };
  it('unverified KHÔNG nhận secret (422 secret); không gửi -> secret null (không tạo SourceSecret)', () => {
    const withSecret = call({ provider: 'generic', name: 'momo', secret: `s-${process.pid}-0123456789`, verificationConfig: BASE });
    expect(withSecret).toMatchObject({ ok: false, value: { field: 'secret' } });
    const ok = call({ provider: 'generic', name: 'momo', verificationConfig: BASE });
    expect(ok).toMatchObject({ ok: true, value: { secret: null, verificationConfig: { scheme: 'unverified', eventType: 'momo.ipn' } } });
    // Scheme có verify vẫn bắt buộc secret như cũ.
    expect(call({ provider: 'generic', name: 'x', verificationConfig: { scheme: 'hmac', header: 'x-sig', idempotency: { header: 'x-id' }, eventType: 'a.b' } })).toMatchObject({ ok: false, value: { field: 'secret' } });
  });
  it('[PK:T15] (phần c) eventType chuẩn -> 422 verificationConfig.eventType lúc lưu (payment / repo / hub)', () => {
    for (const t of ['payment.received', 'repo.push', 'hub.source.signature_failing']) {
      expect(call({ provider: 'generic', name: 'x', verificationConfig: { ...BASE, eventType: t } })).toMatchObject({ ok: false, value: { field: 'verificationConfig.eventType' } });
    }
  });
});

/**
 * [PK:T18] vòng tròn L0 (stack LOCAL cần docker — phần HTTP thật để CI/§13 bài B): fixture Twilio DỰNG (constructed: thuật
 * toán theo twilio.com/docs/usage/security — Base64(HMAC-SHA1(authToken, URL + Σ key+value của tham số POST sắp theo khoá))),
 * đi qua IngestService (nguồn unverified, forwardUrl) -> GenericAdapter.normalize (đúng như worker) -> toWebhookBody (phong
 * bì hub gửi) -> unwrapUnverified (SDK) -> verify Twilio QUA; sửa 1 byte của `raw` -> TRƯỢT.
 */
describe('[PK5] vòng tròn Twilio qua unverified', () => {
  const twilioSign = (authToken: string, url: string, params: URLSearchParams) => {
    const keys = [...new Set([...params.keys()])].sort();
    const data = url + keys.map((k) => params.getAll(k).sort().map((v) => k + v).join('')).join('');
    return createHmac('sha1', authToken).update(Buffer.from(data, 'utf8')).digest('base64');
  };
  const twilioVerify = (authToken: string, u: { rawBody: Buffer; headers: Record<string, string>; url: string | null }) => {
    if (!u.url) return false;
    const presented = Buffer.from(u.headers['x-twilio-signature'] ?? '');
    const expected = Buffer.from(twilioSign(authToken, u.url, new URLSearchParams(u.rawBody.toString('utf8'))));
    return presented.length === expected.length && timingSafeEqual(presented, expected);
  };

  it('[PK:T18] fixture Twilio (constructed) -> ACCEPTED verified=false -> envelope -> unwrapUnverified + thuật toán Twilio QUA; sửa 1 byte raw -> TRƯỢT', async () => {
    process.env.HUB_PUBLIC_URL = 'https://hub.example.com';
    const authToken = randomBytes(16).toString('hex');
    const vc = { scheme: 'unverified', eventType: 'twilio.sms.received', forwardHeaders: ['x-twilio-signature'], forwardUrl: true, idempotency: { field: 'MessageSid' } };
    // Body form mẫu (rút gọn từ tài liệu Twilio Messaging webhook): có `+` (dấu cách) và `%20`, `%2B` — bytes phải đi nguyên.
    const form = 'AccountSid=AC0000000000000000000000000000000&Body=Hello+world%20%2B1&From=%2B15555550100&MessageSid=SM11111111111111111111111111111111&To=%2B15555550199';
    const url = 'https://hub.example.com/hooks/generic/src_generic_unv';
    const sig = twilioSign(authToken, url, new URLSearchParams(form));
    const t = build(vc, true);
    const r = await t.svc.ingestWebhook({
      ...req(form, { parse: false, contentType: 'application/x-www-form-urlencoded', headers: { 'x-twilio-signature': sig, 'i-twilio-idempotency-token': 'x' } }),
      // express.urlencoded đã parse -> body là object (MessageSid đọc từ đây).
      body: Object.fromEntries(new URLSearchParams(form)),
    });
    expect(r.status).toBe(200);
    const raw = t.tx.rawEvent.create.mock.calls[0][0].data;
    expect(raw.verified).toBe(false);
    // Worker: dựng lại request từ dòng đã lưu (như NormalizeConsumer) -> normalize.
    const [evt] = new GenericAdapter().normalize(
      { provider: 'generic', sourceKey: '', headers: raw.headers, rawBody: Buffer.from(raw.bodyRaw), body: raw.body, contentType: raw.contentType },
      { tenantId: 't', sourceId: 's', correlationId: 'c', rawEventId: 'r', verificationConfig: vc },
    );
    const body = toWebhookBody({ ...evt, verified: false });
    const delivered = JSON.parse(body);
    expect(delivered.verified).toBe(false);
    const u = unwrapUnverified(delivered);
    expect(u.rawBody.toString('utf8')).toBe(form);
    expect(u.url).toBe(url);
    expect(twilioVerify(authToken, u)).toBe(true);
    // Sửa 1 byte của raw -> trượt.
    const tampered = Buffer.from(u.rawBody);
    tampered[tampered.length - 1] ^= 0x01;
    expect(twilioVerify(authToken, { ...u, rawBody: tampered })).toBe(false);
    // Sai URL (đích dựng từ Host giả) -> trượt.
    expect(twilioVerify(authToken, { ...u, url: 'https://evil.com/hooks/generic/src_generic_unv' })).toBe(false);
  });
});
