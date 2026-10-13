import { createHmac, randomBytes } from 'crypto';
import Stripe from 'stripe';
import { RawWebhookRequest } from '@hub/common';
import { swHeaders, swVerify } from '@hub/crypto';
import { GenericAdapter } from '../src/generic.adapter';
import { GenericConfig, validateGenericConfig } from '../src/generic-config';
import { parseTimestamp } from '../src/signed-template';

/**
 * PK3 (SPEC-provider-khac §5, E16, E2, ADR-204): scheme `signed-template`.
 *
 * Fixture: body là mẫu CHÍNH THỨC của từng provider (nguồn ghi cạnh mỗi body, rút gọn trường dài), chữ ký tính LÚC CHẠY
 * theo đúng thuật toán trong tài liệu của provider — viết tay ở đây, KHÔNG gọi code của hub — với secret sinh ngẫu nhiên
 * trong test (không literal trông như secret). Hub verify qua = cấu hình template mô tả đúng provider.
 */
const a = new GenericAdapter();
const NOW_MS = Date.UTC(2026, 9, 14, 3, 0, 0); // mốc cố định; verifyAt (E2) thay "bây giờ"
const NOW = Math.floor(NOW_MS / 1000);
const hmac = (algo: string, key: string | Buffer, data: string | Buffer, enc: 'hex' | 'base64') => createHmac(algo, key).update(data).digest(enc);
const rnd = (n = 24) => randomBytes(n).toString('base64url');

function req(body: string, headers: Record<string, string>): RawWebhookRequest {
  return { provider: 'generic', sourceKey: 'k', headers, rawBody: Buffer.from(body, 'utf8'), body: JSON.parse(body), contentType: 'application/json' };
}
function cfg(c: Record<string, unknown>): GenericConfig {
  const r = validateGenericConfig({ scheme: 'signed-template', idempotency: { field: 'id' }, eventType: 'acme.event', ...c });
  if (!r.ok) throw new Error(`config sai: ${(r as { field: string }).field} — ${(r as { message: string }).message}`);
  return (r as { config: GenericConfig }).config;
}
const at = (sec: number) => new Date(sec * 1000);
const verifyAt = (c: GenericConfig, r: RawWebhookRequest, secrets: string[], sec: number) => a.verify(r, secrets, { verificationConfig: c, verifyAt: at(sec) });

/** RFC 3339 có offset cố định (Box: `2026-10-13T20:00:00-07:00`). */
function isoWithOffset(sec: number, offsetMin: number): string {
  const d = new Date((sec + offsetMin * 60) * 1000).toISOString().slice(0, 19);
  const sign = offsetMin < 0 ? '-' : '+';
  const abs = Math.abs(offsetMin);
  return `${d}${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

interface Fixture {
  name: string;
  /** Tài liệu chính thức dùng cho thuật toán ký + body mẫu. */
  docs: string;
  config: Record<string, unknown>;
  idempotency: Record<string, string>;
  body: string;
  secret: () => string;
  /** Ký theo tài liệu provider, timestamp = `sec`. */
  sign: (secret: string, body: string, sec: number) => Record<string, string>;
}

const FIXTURES: Fixture[] = [
  {
    name: 'Slack',
    // Thuật toán: https://docs.slack.dev/authentication/verifying-requests-from-slack (v0:{ts}:{body}, "v0=" + hex, lệch ≤ 5 phút).
    // Body: mẫu event_callback ở https://docs.slack.dev/apis/events-api/ (rút gọn).
    docs: 'https://docs.slack.dev/authentication/verifying-requests-from-slack',
    config: {
      template: 'v0:{timestamp}:{body}',
      signature: { headers: ['x-slack-signature'], prefix: 'v0=' },
      timestampHeader: 'x-slack-request-timestamp',
      toleranceSec: 300,
    },
    idempotency: { field: 'event_id' },
    body: '{"token":"XXYYZZ","team_id":"T123ABC456","api_app_id":"A123ABC456","event":{"type":"name_of_event","event_ts":"1234567890.123456","user":"U123ABC456"},"type":"event_callback","authed_users":["U123ABC456","U222222222"],"event_id":"Ev123ABC456","event_time":1234567890}',
    secret: () => randomBytes(16).toString('hex'),
    sign: (secret, body, sec) => ({
      'x-slack-request-timestamp': String(sec),
      'x-slack-signature': `v0=${hmac('sha256', secret, `v0:${sec}:${body}`, 'hex')}`,
    }),
  },
  {
    name: 'Stripe',
    // Thuật toán: https://docs.stripe.com/webhooks#verify-manually (Stripe-Signature t=…,v1=…; "{t}.{body}"; hex; mặc định 300s).
    // Body: Event mẫu ở https://docs.stripe.com/api/events/object (rút gọn data.object).
    docs: 'https://docs.stripe.com/webhooks',
    config: {
      template: '{timestamp}.{body}',
      signature: { header: 'stripe-signature', kv: { sep: ',', sig: 'v1', timestamp: 't' } },
      toleranceSec: 300,
    },
    idempotency: { field: 'id' },
    body: '{"id":"evt_1NG8Du2eZvKYlo2CUI79vXWy","object":"event","api_version":"2019-02-19","created":1686089970,"data":{"object":{"id":"seti_1NG8Du2eZvKYlo2C9XMqbR0x","object":"setup_intent","status":"requires_confirmation"}},"livemode":false,"pending_webhooks":0,"request":{"id":null,"idempotency_key":null},"type":"setup_intent.created"}',
    secret: () => `whsec_${rnd()}`,
    sign: (secret, body, sec) => ({ 'stripe-signature': `t=${sec},v1=${hmac('sha256', secret, `${sec}.${body}`, 'hex')}` }),
  },
  {
    name: 'Paddle',
    // Thuật toán: https://developer.paddle.com/webhooks/signature-verification (Paddle-Signature ts=…;h1=…; "{ts}:{body}"; hex;
    // SDK chỉ chấp nhận lệch 5 giây). Body: khuôn notification ở https://developer.paddle.com/webhooks/overview (rút gọn data).
    docs: 'https://developer.paddle.com/webhooks/signature-verification',
    config: {
      template: '{timestamp}:{body}',
      signature: { header: 'paddle-signature', kv: { sep: ';', sig: 'h1', timestamp: 'ts' } },
      toleranceSec: 5,
    },
    idempotency: { field: 'event_id' },
    body: '{"event_id":"evt_01hv8x2acma2gz5szx6ekqtkp7","event_type":"transaction.completed","occurred_at":"2024-04-12T10:18:49.621022Z","notification_id":"ntf_01hv8x2af6bpwbwsdbbx2fcv1q","data":{"id":"txn_01hv8wptq8987qeep44cyrewp9","status":"completed"}}',
    secret: () => `pdl_ntfset_${rnd()}`,
    sign: (secret, body, sec) => ({ 'paddle-signature': `ts=${sec};h1=${hmac('sha256', secret, `${sec}:${body}`, 'hex')}` }),
  },
  {
    name: 'Calendly',
    // Thuật toán: https://developer.calendly.com/api-docs/overview/webhooks/webhook-signatures (Calendly-Webhook-Signature t=…,v1=…;
    // "{t}.{body}"; hex; cửa sổ 3 phút). Body: khuôn invitee.created (event, created_at, created_by, payload) — rút gọn payload.
    docs: 'https://developer.calendly.com/api-docs/overview/webhooks/webhook-signatures',
    config: {
      template: '{timestamp}.{body}',
      signature: { header: 'calendly-webhook-signature', kv: { sep: ',', sig: 'v1', timestamp: 't' } },
      toleranceSec: 180,
    },
    idempotency: { field: 'created_at' },
    body: '{"created_at":"2020-11-23T17:51:19.000000Z","created_by":"https://api.calendly.com/users/AAAAAAAAAAAAAAAA","event":"invitee.created","payload":{"email":"test@example.com","name":"John Doe","status":"active"}}',
    secret: () => rnd(),
    sign: (secret, body, sec) => ({ 'calendly-webhook-signature': `t=${sec},v1=${hmac('sha256', secret, `${sec}.${body}`, 'hex')}` }),
  },
  {
    name: 'Box',
    // Thuật toán: https://developer.box.com/guides/webhooks/v2/signatures-v2/ (HMAC-SHA256 trên body RỒI timestamp, base64;
    // BOX-SIGNATURE-PRIMARY / -SECONDARY, khớp một là đủ; quá 10 phút là hết hạn; timestamp parse bằng Date.parse).
    // Body: khuôn webhook_event (type, id, created_at, trigger, webhook, source) ở https://developer.box.com/reference/resources/webhook-invocation/.
    docs: 'https://developer.box.com/guides/webhooks/v2/signatures-v2/',
    config: {
      template: '{body}{timestamp}',
      encoding: 'base64',
      signature: { headers: ['box-signature-primary', 'box-signature-secondary'] },
      timestampHeader: 'box-delivery-timestamp',
      timestampFormat: 'iso8601',
      toleranceSec: 600,
    },
    idempotency: { header: 'box-delivery-id' },
    body: '{"type":"webhook_event","id":"eb0c4e06-751f-442c-86f8-fd5bb404dbec","created_at":"2019-02-06T14:30:31-08:00","trigger":"FILE.PREVIEWED","webhook":{"id":"1234567","type":"webhook"},"source":{"id":"12345678","type":"file","name":"Example.docx"}}',
    secret: () => rnd(),
    sign: (secret, body, sec) => {
      const ts = isoWithOffset(sec, -7 * 60);
      // Khoá primary đã xoay (khác secret của hub) — chỉ secondary khớp: "khớp một là đủ".
      return {
        'box-delivery-id': 'd-1',
        'box-delivery-timestamp': ts,
        'box-signature-primary': hmac('sha256', rnd(), body + ts, 'base64'),
        'box-signature-secondary': hmac('sha256', secret, body + ts, 'base64'),
      };
    },
  },
  {
    name: 'Twitch',
    // Thuật toán: https://dev.twitch.tv/docs/eventsub/handling-webhook-events/ (message-id + message-timestamp + body nối liền,
    // "sha256=" + hex; timestamp RFC 3339 tới nano giây). Cửa sổ 10 phút: https://dev.twitch.tv/docs/eventsub/ ("isn't older than
    // 10 minutes", review PK4 T-4, đọc 2026-10-14) -> toleranceSec 600, khớp mục danh mục.
    // Body: thông báo channel.follow mẫu ở cùng trang (rút gọn).
    docs: 'https://dev.twitch.tv/docs/eventsub/handling-webhook-events/',
    config: {
      template: '{id}{timestamp}{body}',
      signature: { headers: ['twitch-eventsub-message-signature'], prefix: 'sha256=' },
      timestampHeader: 'twitch-eventsub-message-timestamp',
      timestampFormat: 'iso8601',
      idHeader: 'twitch-eventsub-message-id',
      toleranceSec: 600,
    },
    idempotency: { header: 'twitch-eventsub-message-id' },
    body: '{"subscription":{"id":"f1c2a387-161a-49f9-a165-0f21d7a4e1c4","type":"channel.follow","version":"2","status":"enabled","cost":0,"condition":{"broadcaster_user_id":"1337","moderator_user_id":"1337"},"transport":{"method":"webhook","callback":"https://example.com/webhooks/callback"},"created_at":"2019-11-16T10:11:12.634234626Z"},"event":{"user_id":"1234","user_login":"cool_user","user_name":"Cool_User","broadcaster_user_id":"1337","broadcaster_user_login":"cooler_user","broadcaster_user_name":"Cooler_User","followed_at":"2020-07-15T18:16:11.17106713Z"}}',
    secret: () => rnd(),
    sign: (secret, body, sec) => {
      const id = 'e76c6bd4-55c9-4987-8304-da1588d8988b';
      const ts = new Date(sec * 1000).toISOString().replace('Z', '634234Z'); // .sss + 6 chữ số = nano giây
      return {
        'twitch-eventsub-message-id': id,
        'twitch-eventsub-message-timestamp': ts,
        'twitch-eventsub-message-signature': `sha256=${hmac('sha256', secret, id + ts + body, 'hex')}`,
      };
    },
  },
];

describe('[PK:T9] (phần a) signed-template: fixture Slack, Stripe, Paddle, Calendly, Box, Twitch', () => {
  it.each(FIXTURES.map((f) => [f.name, f] as const))('%s: ký đúng -> true; lệch toleranceSec+1 (hai phía) -> false; biên toleranceSec -> true; phát lại sau 10 phút -> false; sửa 1 byte -> false', async (_n, f) => {
    const c = cfg({ ...f.config, idempotency: f.idempotency });
    const tol = c.toleranceSec!;
    const secret = f.secret();
    const headers = f.sign(secret, f.body, NOW);
    const r = req(f.body, headers);
    expect(await verifyAt(c, r, [secret], NOW)).toBe(true);
    expect(await verifyAt(c, r, [secret], NOW + tol)).toBe(true);
    expect(await verifyAt(c, r, [secret], NOW - tol)).toBe(true);
    expect(await verifyAt(c, r, [secret], NOW + tol + 1)).toBe(false);
    expect(await verifyAt(c, r, [secret], NOW - tol - 1)).toBe(false);
    // Phát lại sau 10 phút (Box: cửa sổ chính thức đúng 10 phút -> 10 phút + 1 giây).
    expect(await verifyAt(c, r, [secret], NOW + Math.max(600, tol + 1))).toBe(false);
    // Sửa 1 byte body (giữ JSON hợp lệ) -> false.
    const tampered = f.body.slice(0, 2) + (f.body[2] === 'x' ? 'y' : 'x') + f.body.slice(3); // ký tự đầu của tên khoá đầu tiên
    expect(tampered).not.toBe(f.body);
    expect(await verifyAt(c, req(tampered, headers), [secret], NOW)).toBe(false);
    // Secret khác -> false; secret đúng nằm sau secret sai (xoay khoá) -> true.
    expect(await verifyAt(c, r, [f.secret()], NOW)).toBe(false);
    expect(await verifyAt(c, r, [f.secret(), secret], NOW)).toBe(true);
  });

  it('ingest thường (không verifyAt) dùng giờ thật: ký "bây giờ" -> true; ký 20 phút trước -> false', async () => {
    const f = FIXTURES.find((x) => x.name === 'Stripe')!;
    const c = cfg({ ...f.config, idempotency: f.idempotency });
    const secret = f.secret();
    const now = Math.floor(Date.now() / 1000);
    expect(await a.verify(req(f.body, f.sign(secret, f.body, now)), [secret], { verificationConfig: c })).toBe(true);
    expect(await a.verify(req(f.body, f.sign(secret, f.body, now - 1200)), [secret], { verificationConfig: c })).toBe(false);
  });

  it('Stripe xoay khoá: nhiều v1 + v0 -> khớp một v1 là đủ; v0 (khác tên khoá) không bao giờ được tính', async () => {
    const f = FIXTURES.find((x) => x.name === 'Stripe')!;
    const c = cfg({ ...f.config, idempotency: f.idempotency });
    const [oldS, newS] = [f.secret(), f.secret()];
    const sig = (s: string) => hmac('sha256', s, `${NOW}.${f.body}`, 'hex');
    const h = { 'stripe-signature': `t=${NOW},v1=${sig(oldS)},v1=${sig(newS)},v0=${sig(f.secret())}` };
    expect(await verifyAt(c, req(f.body, h), [newS], NOW)).toBe(true);
    expect(await verifyAt(c, req(f.body, h), [oldS], NOW)).toBe(true);
    const onlyV0 = { 'stripe-signature': `t=${NOW},v0=${sig(newS)}` };
    expect(await verifyAt(c, req(f.body, onlyV0), [newS], NOW)).toBe(false);
    // Hai `t` (không đoán bản nào thật) -> false; thiếu `t` -> false.
    expect(await verifyAt(c, req(f.body, { 'stripe-signature': `t=${NOW},t=${NOW},v1=${sig(newS)}` }), [newS], NOW)).toBe(false);
    expect(await verifyAt(c, req(f.body, { 'stripe-signature': `v1=${sig(newS)}` }), [newS], NOW)).toBe(false);
  });

  it('timestamp được ký: đổi timestamp (giữ chữ ký) -> false dù vẫn trong cửa sổ', async () => {
    const f = FIXTURES.find((x) => x.name === 'Slack')!;
    const c = cfg({ ...f.config, idempotency: f.idempotency });
    const secret = f.secret();
    const h = f.sign(secret, f.body, NOW);
    expect(await verifyAt(c, req(f.body, { ...h, 'x-slack-request-timestamp': String(NOW + 1) }), [secret], NOW)).toBe(false);
  });

  it('Twitch: thiếu id header / đổi id -> false ({id} nằm trong phần được ký)', async () => {
    const f = FIXTURES.find((x) => x.name === 'Twitch')!;
    const c = cfg({ ...f.config, idempotency: f.idempotency });
    const secret = f.secret();
    const h = f.sign(secret, f.body, NOW);
    const { 'twitch-eventsub-message-id': _id, ...noId } = h;
    expect(await verifyAt(c, req(f.body, noId), [secret], NOW)).toBe(false);
    expect(await verifyAt(c, req(f.body, { ...h, 'twitch-eventsub-message-id': 'khac' }), [secret], NOW)).toBe(false);
  });

  it('sha512 + base64 + keyEncoding hex; {body} là bytes gốc (body không phải JSON, có byte UTF-8 nhiều byte)', async () => {
    const key = randomBytes(32);
    const c = cfg({ template: '{timestamp}|{body}', algo: 'sha512', encoding: 'base64', keyEncoding: 'hex', signature: { headers: ['x-sig'] }, timestampHeader: 'x-ts', toleranceSec: 60, idempotency: { header: 'x-ts' } });
    const raw = Buffer.from('a=1&b=đ\n', 'utf8');
    const sig = createHmac('sha512', key).update(Buffer.concat([Buffer.from(`${NOW}|`), raw])).digest('base64');
    const r: RawWebhookRequest = { provider: 'generic', sourceKey: 'k', headers: { 'x-sig': sig, 'x-ts': String(NOW) }, rawBody: raw, body: null, contentType: 'text/plain' };
    expect(await a.verify(r, [key.toString('hex')], { verificationConfig: c, verifyAt: at(NOW) })).toBe(true);
    expect(await a.verify(r, [key.toString('base64')], { verificationConfig: c, verifyAt: at(NOW) })).toBe(false); // không giải mã được theo hex -> bỏ qua
  });

  it('unix-ms: Webflow-kiểu "{timestamp}:{body}" với timestamp mili giây', async () => {
    const secret = rnd();
    const c = cfg({ template: '{timestamp}:{body}', signature: { headers: ['x-webflow-signature'] }, timestampHeader: 'x-webflow-timestamp', timestampFormat: 'unix-ms', toleranceSec: 300 });
    const body = '{"id":"w1","triggerType":"form_submission","payload":{}}';
    const ms = String(NOW * 1000 + 123);
    const r = req(body, { 'x-webflow-timestamp': ms, 'x-webflow-signature': hmac('sha256', secret, `${ms}:${body}`, 'hex') });
    expect(await verifyAt(c, r, [secret], NOW)).toBe(true);
    expect(await verifyAt(c, r, [secret], NOW + 301)).toBe(false);
  });

  it('parseTimestamp: unix / unix-ms / iso8601 (Z, offset, nano giây); sai khuôn -> null', () => {
    expect(parseTimestamp('1531420618', 'unix')).toBe(1531420618);
    expect(parseTimestamp('1531420618.5', 'unix')).toBeNull();
    expect(parseTimestamp('1531420618123', 'unix-ms')).toBeCloseTo(1531420618.123);
    expect(parseTimestamp('2019-11-16T10:11:12.634234626Z', 'iso8601')).toBeCloseTo(Date.UTC(2019, 10, 16, 10, 11, 12, 634) / 1000);
    expect(parseTimestamp('2019-11-16T02:11:12-08:00', 'iso8601')).toBe(Date.UTC(2019, 10, 16, 10, 11, 12) / 1000);
    for (const bad of ['', 'abc', '2019-11-16 10:11:12Z', '2019-11-16T10:11:12', '-1']) {
      expect([bad, parseTimestamp(bad, 'iso8601') ?? parseTimestamp(bad, 'unix')]).toEqual([bad, null]);
    }
  });
});

describe('PK3 E2: verifyAt thay "bây giờ" (cả standard-webhooks)', () => {
  it('standard-webhooks ký 20 phút trước: không verifyAt -> false; verifyAt = giờ nhận -> true; verifyAt lệch > 300s -> false', async () => {
    const secret = `whsec_${randomBytes(24).toString('base64')}`;
    const body = '{"type":"user.created","id":"u1"}';
    const sentSec = Math.floor(Date.now() / 1000) - 1200;
    const r: RawWebhookRequest = { provider: 'generic', sourceKey: 'k', headers: swHeaders(secret, 'msg_1', body, sentSec), rawBody: Buffer.from(body), body: JSON.parse(body), contentType: 'application/json' };
    const c = validateGenericConfig({ scheme: 'standard-webhooks', eventType: 'user.created' });
    const vc = (c as { config: unknown }).config;
    expect(await a.verify(r, [secret], { verificationConfig: vc })).toBe(false);
    expect(await a.verify(r, [secret], { verificationConfig: vc, verifyAt: at(sentSec + 2) })).toBe(true);
    expect(await a.verify(r, [secret], { verificationConfig: vc, verifyAt: at(sentSec + 301) })).toBe(false);
  });
});

describe('PK3: diagnose / extractSignature của signed-template (chỉ tên header, không giá trị)', () => {
  const f = FIXTURES.find((x) => x.name === 'Slack')!;
  const c = cfg({ ...f.config, idempotency: f.idempotency });
  const ctx = { verificationConfig: c };
  const stored = (headers: Record<string, string>, receivedSec = NOW) => ({ status: 'REJECTED', signatureValid: false, headers, body: {}, receivedAt: at(receivedSec) });
  const h = f.sign('khoa-test-chan-doan', f.body, NOW);

  it('thiếu header chữ ký / timestamp -> missing_header; lệch giờ so với received_at -> timestamp_out_of_range; còn lại -> signature_mismatch', () => {
    expect(a.diagnose(stored({ 'x-slack-request-timestamp': String(NOW), 'x-signature': 'x' }), ctx)).toMatchObject({ ok: false, reason: 'missing_header', expectedHeader: 'x-slack-signature', candidateHeaders: ['x-signature'] });
    expect(a.diagnose(stored({ 'x-slack-signature': h['x-slack-signature'] }), ctx)).toMatchObject({ reason: 'missing_header', expectedHeader: 'x-slack-request-timestamp' });
    expect(a.diagnose(stored(h, NOW + 301), ctx)).toMatchObject({ reason: 'timestamp_out_of_range', expectedHeader: 'x-slack-request-timestamp' });
    expect(a.diagnose(stored(h, NOW + 30), ctx)).toEqual({ ok: false, reason: 'signature_mismatch', expectedHeader: 'x-slack-signature' });
    expect(JSON.stringify(a.diagnose(stored(h, NOW + 30), ctx))).not.toContain(h['x-slack-signature'].slice(3, 20));
  });

  it('kv (Stripe): thiếu khoá t -> missing_kv_key (review PK3 T-6); có t mà lệch -> timestamp_out_of_range; idHeader (Twitch) thiếu -> missing_header', () => {
    const s = FIXTURES.find((x) => x.name === 'Stripe')!;
    const sc = { verificationConfig: cfg({ ...s.config, idempotency: s.idempotency }) };
    expect(a.diagnose(stored({ 'stripe-signature': 'v1=ab' }), sc)).toEqual({ ok: false, reason: 'missing_kv_key', expectedHeader: 'stripe-signature', expectedKvKey: 't' });
    expect(a.diagnose(stored({ 'stripe-signature': `t=${NOW - 400},v1=ab` }), sc)).toMatchObject({ reason: 'timestamp_out_of_range', expectedHeader: 'stripe-signature' });
    const t = FIXTURES.find((x) => x.name === 'Twitch')!;
    const th = t.sign('khoa-test-chan-doan', t.body, NOW);
    const { 'twitch-eventsub-message-id': _id, ...noId } = th;
    expect(a.diagnose(stored(noId), { verificationConfig: cfg({ ...t.config, idempotency: t.idempotency }) })).toMatchObject({ reason: 'missing_header', expectedHeader: 'twitch-eventsub-message-id' });
  });

  it('extractSignature: header chữ ký (kv: cả header; nhiều header: header đầu tiên có mặt); sensitiveHeaders rỗng', () => {
    expect(a.extractSignature(req(f.body, h), ctx)).toBe(h['x-slack-signature']);
    const b = FIXTURES.find((x) => x.name === 'Box')!;
    const bh = b.sign('khoa-test-chan-doan', b.body, NOW);
    const bc = { verificationConfig: cfg({ ...b.config, idempotency: b.idempotency }) };
    expect(a.extractSignature(req(b.body, bh), bc)).toBe(bh['box-signature-primary']);
    const { 'box-signature-primary': _p, ...onlySecondary } = bh;
    expect(a.extractSignature(req(b.body, onlySecondary), bc)).toBe(bh['box-signature-secondary']);
    expect(a.sensitiveHeaders(bc)).toEqual([]);
  });
});

describe('[PK:T8] (phần a) validateGenericConfig: template sai luật -> đúng tên trường', () => {
  const base = { scheme: 'signed-template', idempotency: { field: 'id' }, eventType: 'acme.event', signature: { headers: ['x-sig'] }, timestampHeader: 'x-ts', toleranceSec: 300 };
  const field = (c: Record<string, unknown>) => {
    const r = validateGenericConfig({ ...base, ...c });
    return r.ok ? 'ok' : (r as { field: string }).field;
  };

  it.each([
    ['thiếu {body}', { template: '{timestamp}.x' }, 'template'],
    ['{body} hai lần', { template: '{body}.{body}' }, 'template'],
    ['token lạ {ts}', { template: '{ts}.{body}' }, 'template'],
    ['dấu { lẻ', { template: '{timestamp}.{body' }, 'template'],
    ['> 128 đơn vị', { template: `${'x'.repeat(128)}{body}` }, 'template'],
    ['không phải chuỗi', { template: 42 }, 'template'],
    ['có {timestamp} mà không toleranceSec', { template: '{timestamp}.{body}', toleranceSec: undefined }, 'toleranceSec'],
    ['toleranceSec 4', { template: '{timestamp}.{body}', toleranceSec: 4 }, 'toleranceSec'],
    ['toleranceSec 901', { template: '{timestamp}.{body}', toleranceSec: 901 }, 'toleranceSec'],
    ['toleranceSec lẻ', { template: '{timestamp}.{body}', toleranceSec: 30.5 }, 'toleranceSec'],
    ['có {timestamp} mà không nguồn timestamp', { template: '{timestamp}.{body}', timestampHeader: undefined }, 'timestampHeader'],
    ['timestamp cả kv lẫn header', { template: '{timestamp}.{body}', signature: { header: 'x-sig', kv: { sep: ',', sig: 'v1', timestamp: 't' } } }, 'timestampHeader'],
    ['không {timestamp} mà có toleranceSec', { template: '{body}', timestampHeader: undefined }, 'toleranceSec'],
    ['không {timestamp} mà có timestampHeader', { template: '{body}', toleranceSec: undefined }, 'timestampHeader'],
    ['timestampFormat lạ', { template: '{timestamp}.{body}', timestampFormat: 'rfc2822' }, 'timestampFormat'],
    ['có {id} mà không idHeader', { template: '{id}{timestamp}{body}' }, 'idHeader'],
    ['idHeader mà không {id}', { template: '{timestamp}{body}', idHeader: 'x-id' }, 'idHeader'],
    ['3 header chữ ký', { template: '{timestamp}{body}', signature: { headers: ['a', 'b', 'c'] } }, 'signature.headers'],
    ['header chữ ký trùng', { template: '{timestamp}{body}', signature: { headers: ['a', 'a'] } }, 'signature.headers'],
    ['kv sep lạ', { template: '{timestamp}{body}', timestampHeader: undefined, signature: { header: 'x-sig', kv: { sep: '|', sig: 'v1', timestamp: 't' } } }, 'signature.kv.sep'],
    ['kv sig trùng timestamp', { template: '{timestamp}{body}', timestampHeader: undefined, signature: { header: 'x-sig', kv: { sep: ',', sig: 't', timestamp: 't' } } }, 'signature.kv.timestamp'],
    ['signature thiếu', { template: '{timestamp}{body}', signature: undefined }, 'signature'],
    ['prefix chữ ký > 32', { template: '{timestamp}{body}', signature: { headers: ['x-sig'], prefix: 'p'.repeat(33) } }, 'signature.prefix'],
    ['algo sha1', { template: '{timestamp}{body}', algo: 'sha1' }, 'algo'],
    ['header (của hmac) không dùng', { template: '{timestamp}{body}', header: 'x-sig' }, 'header'],
    ['prefix cấp ngoài không dùng', { template: '{timestamp}{body}', prefix: 'v0=' }, 'prefix'],
  ] as const)('%s', (_n, c, expected) => {
    expect(field(c as Record<string, unknown>)).toBe(expected);
  });

  it('đúng luật: khuôn lưu dựng lại (mặc định algo/encoding/keyEncoding/timestampFormat), không mang trường lạ', () => {
    const r = validateGenericConfig({ ...base, template: 'v0:{timestamp}:{body}', signature: { headers: ['x-sig'], prefix: 'v0=' }, extra: 1 });
    expect(r).toEqual({
      ok: true,
      config: {
        scheme: 'signed-template',
        template: 'v0:{timestamp}:{body}',
        algo: 'sha256',
        encoding: 'hex',
        keyEncoding: 'utf8',
        signature: { headers: ['x-sig'], prefix: 'v0=' },
        timestampHeader: 'x-ts',
        timestampFormat: 'unix',
        toleranceSec: 300,
        idempotency: { field: 'id' },
        eventType: 'acme.event',
      },
    });
    // Config đã lưu được kiểm lại mỗi lần dùng: dựng lại lần hai không đổi.
    const again = validateGenericConfig((r as { config: unknown }).config);
    expect(again).toEqual(r);
  });
});

describe('Review PK3 (T-1..T-4): ranh giới token, verifyAt hỏng, bytes không phải UTF-8, vector biết trước đáp án', () => {
  it('[PK:T8] (phần c) T-1: unix / unix-ms không nhận số 0 đứng đầu; "0" vẫn là số hợp lệ', () => {
    expect(parseTimestamp('01700000000', 'unix')).toBeNull();
    expect(parseTimestamp('00001', 'unix')).toBeNull();
    expect(parseTimestamp('01700000000000', 'unix-ms')).toBeNull();
    expect(parseTimestamp('0', 'unix')).toBe(0);
    expect(parseTimestamp('1700000000', 'unix')).toBe(1700000000);
    expect(parseTimestamp('1234567890123', 'unix')).toBeNull(); // 13 chữ số > 12
  });

  it('[PK:T8] (phần d) T-1: {id} đứng sát {body} -> 422 template (cả hai phía); có ký tự ngăn cách hoặc sát {timestamp} -> được', () => {
    const base = { scheme: 'signed-template', idempotency: { header: 'x-id' }, eventType: 'acme.event', signature: { headers: ['x-sig'] }, idHeader: 'x-id' };
    const field = (template: string, extra: Record<string, unknown> = {}) => {
      const r = validateGenericConfig({ ...base, template, ...extra });
      return r.ok ? 'ok' : (r as { field: string }).field;
    };
    const ts = { timestampHeader: 'x-ts', toleranceSec: 300 };
    expect(field('{id}{body}')).toBe('template');
    expect(field('{body}{id}')).toBe('template');
    expect(field('{timestamp}.{id}{body}', ts)).toBe('template');
    expect(field('{id}.{body}')).toBe('ok');
    expect(field('{id}{timestamp}{body}', ts)).toBe('ok'); // Twitch
    expect(field('{body}{timestamp}', { ...ts, idHeader: undefined })).toBe('ok'); // Box
  });

  it('T-1 kịch bản 1: id "evt-10" + ts T được ký; phát lại với id "evt-1" + ts "0"+T (cùng bytes, khoá chống trùng mới) -> false', async () => {
    const secret = rnd();
    const c = cfg({ template: '{id}{timestamp}{body}', signature: { headers: ['x-sig'] }, timestampHeader: 'x-ts', idHeader: 'x-id', toleranceSec: 300, idempotency: { header: 'x-id' } });
    const body = '{"a":1}';
    const sig = hmac('sha256', secret, `evt-10${NOW}${body}`, 'hex');
    expect(await verifyAt(c, req(body, { 'x-id': 'evt-10', 'x-ts': String(NOW), 'x-sig': sig }), [secret], NOW)).toBe(true);
    expect(await verifyAt(c, req(body, { 'x-id': 'evt-1', 'x-ts': `0${NOW}`, 'x-sig': sig }), [secret], NOW)).toBe(false);
  });

  it('T-2: verifyAt không hợp lệ (Invalid Date) -> false ở signed-template VÀ standard-webhooks (fail-closed)', async () => {
    const f = FIXTURES.find((x) => x.name === 'Slack')!;
    const c = cfg({ ...f.config, idempotency: f.idempotency });
    const secret = f.secret();
    const r = req(f.body, f.sign(secret, f.body, NOW));
    expect(await a.verify(r, [secret], { verificationConfig: c, verifyAt: new Date(NaN) })).toBe(false);

    const sw = `whsec_${randomBytes(24).toString('base64')}`;
    const body = '{"type":"user.created","id":"u1"}';
    const sr: RawWebhookRequest = { provider: 'generic', sourceKey: 'k', headers: swHeaders(sw, 'msg_1', body, 1000), rawBody: Buffer.from(body), body: JSON.parse(body), contentType: 'application/json' };
    const vc = (validateGenericConfig({ scheme: 'standard-webhooks', eventType: 'user.created' }) as { config: unknown }).config;
    expect(await a.verify(sr, [sw], { verificationConfig: vc, verifyAt: new Date(NaN) })).toBe(false);
    // Thẳng vào swVerify: nowSec NaN không được bỏ qua kiểm độ lệch (chữ ký năm 1970).
    expect(swVerify(sw, sr.headers, sr.rawBody, { nowSec: NaN })).toBe(false);
    expect(swVerify(sw, sr.headers, sr.rawBody, { nowSec: 1000 })).toBe(true);
  });

  it('T-3: {body} là bytes gốc kể cả byte KHÔNG phải UTF-8 hợp lệ (khứ hồi toString/Buffer.from làm đổi bytes)', async () => {
    const secret = rnd();
    const c = cfg({ template: '{timestamp}.{body}', signature: { headers: ['x-sig'] }, timestampHeader: 'x-ts', toleranceSec: 60, idempotency: { header: 'x-ts' } });
    const raw = Buffer.from([0x61, 0xff, 0xfe, 0x62]);
    expect(Buffer.from(raw.toString('utf8'), 'utf8').equals(raw)).toBe(false); // tiền đề: khứ hồi UTF-8 làm hỏng
    const sig = createHmac('sha256', secret).update(Buffer.concat([Buffer.from(`${NOW}.`), raw])).digest('hex');
    const r: RawWebhookRequest = { provider: 'generic', sourceKey: 'k', headers: { 'x-sig': sig, 'x-ts': String(NOW) }, rawBody: raw, body: null, contentType: 'application/octet-stream' };
    expect(await verifyAt(c, r, [secret], NOW)).toBe(true);
  });

  it('[PK:T9] (phần b) T-4: vector CHÍNH THỨC của Slack (docs.slack.dev, đáp án cố định) verify qua cấu hình điền nhanh Slack', async () => {
    // https://docs.slack.dev/authentication/verifying-requests-from-slack — ví dụ công khai trong tài liệu (không phải khoá thật).
    const slackDocKey = '8f742231b10e8888abcd99yyyzzz85a5';
    const ts = 1531420618;
    const body =
      'token=xyzz0WbapA4vBCDEFasx0q6G&team_id=T1DC2JH3J&team_domain=testteamnow&channel_id=G8PSS9T3V&channel_name=foobar&user_id=U2CERLKJA&user_name=roadrunner&command=%2Fwebhook-collect&text=&response_url=https%3A%2F%2Fhooks.slack.com%2Fcommands%2FT1DC2JH3J%2F397700885554%2F96rGlfmibIGlgcZRskXaIFfN&trigger_id=398738663015.47445629121.803a0bc887a14d10d2c447fce8b6703c';
    const docSig = 'v0=a2114d57b48eac39b9ad189dd8316235a7b4a8d21a10bd27519666489c69b503';
    const f = FIXTURES.find((x) => x.name === 'Slack')!;
    const c = cfg({ ...f.config, idempotency: { header: 'x-slack-request-timestamp' } });
    const r: RawWebhookRequest = {
      provider: 'generic',
      sourceKey: 'k',
      headers: { 'x-slack-request-timestamp': String(ts), 'x-slack-signature': docSig },
      rawBody: Buffer.from(body, 'utf8'),
      body: null,
      contentType: 'application/x-www-form-urlencoded',
    };
    expect(await verifyAt(c, r, [slackDocKey], ts + 10)).toBe(true);
    expect(await verifyAt(c, r, [slackDocKey], ts + 301)).toBe(false);
    expect(await verifyAt(c, { ...r, rawBody: Buffer.from(body.replace('foobar', 'foobaz'), 'utf8') }, [slackDocKey], ts)).toBe(false);
  });

  it('[PK:T9] (phần c) T-4: header sinh bằng SDK stripe (webhooks.generateTestHeaderString) verify qua cấu hình điền nhanh Stripe', async () => {
    const f = FIXTURES.find((x) => x.name === 'Stripe')!;
    const c = cfg({ ...f.config, idempotency: f.idempotency });
    const whsec = f.secret();
    const sdk = new Stripe('sk_placeholder_webhook_verify_only');
    const header = sdk.webhooks.generateTestHeaderString({ payload: f.body, secret: whsec, timestamp: NOW });
    const r = req(f.body, { 'stripe-signature': header });
    expect(await verifyAt(c, r, [whsec], NOW)).toBe(true);
    expect(await verifyAt(c, r, [f.secret()], NOW)).toBe(false);
    expect(await verifyAt(c, r, [whsec], NOW + 301)).toBe(false);
  });
});
