import { generateWhsecSecret, swHeaderSet, swHeaders, swSign, swVerify } from '../src/standard-webhooks';

/** S6 (SPEC §4.7): Standard Webhooks — ký/verify dùng chung cho hub, GenericAdapter, SDK, Shop. */
describe('Standard Webhooks (S6)', () => {
  const SECRET = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw';
  const ID = 'msg_p5jXN8AQM9LWM0D4loKWxJek';
  const TS = 1614265330;
  const BODY = '{"test": 2432232314}';
  const at = (ts: number) => ({ nowSec: ts });
  const hdr = (sig: string, ts = TS, id = ID) => ({ 'webhook-id': id, 'webhook-timestamp': String(ts), 'webhook-signature': sig });

  it('[MS:U6] vector chuẩn README standard-webhooks', () => {
    expect(swSign(SECRET, ID, TS, BODY)).toBe('v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=');
  });

  it('[MS:U1] ký rồi verify cùng secret whsec_ -> true', () => {
    expect(swVerify(SECRET, hdr(swSign(SECRET, ID, TS, BODY)), Buffer.from(BODY), at(TS))).toBe(true);
  });

  it('[MS:U2] sửa 1 byte body -> false', () => {
    const sig = swSign(SECRET, ID, TS, BODY);
    expect(swVerify(SECRET, hdr(sig), Buffer.from(BODY.replace('2432', '2433')), at(TS))).toBe(false);
  });

  it('[MS:U3] timestamp lệch 301s -> false, 299s -> true (cả hai chiều)', () => {
    const sig = swSign(SECRET, ID, TS, BODY);
    expect(swVerify(SECRET, hdr(sig), BODY, at(TS + 301))).toBe(false);
    expect(swVerify(SECRET, hdr(sig), BODY, at(TS - 301))).toBe(false);
    expect(swVerify(SECRET, hdr(sig), BODY, at(TS + 299))).toBe(true);
    expect(swVerify(SECRET, hdr(sig), BODY, at(TS - 299))).toBe(true);
  });

  // PK1 (SPEC-provider-khac §3.4, E30): Svix (Clerk, Resend…) ký đúng thuật toán Standard Webhooks, chỉ đổi tên header.
  const svix = (sig: string, ts = TS, id = ID) => ({ 'svix-id': id, 'svix-timestamp': String(ts), 'svix-signature': sig });

  it('[PK:T3] (phần a) bộ svix-* verify qua (vector chuẩn); nhiều chữ ký cách dấu cách khớp một là đủ; sửa 1 byte -> false', () => {
    const good = swSign(SECRET, ID, TS, BODY);
    expect(good).toBe('v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=');
    expect(swVerify(SECRET, svix(good), Buffer.from(BODY), at(TS))).toBe(true);
    expect(swVerify(SECRET, svix(`v1,AAAA${good.slice(7)} ${good}`), BODY, at(TS))).toBe(true);
    expect(swVerify(SECRET, svix(good), BODY.replace('2432', '2433'), at(TS))).toBe(false);
    expect(swVerify(SECRET, svix(good), BODY, at(TS + 301))).toBe(false);
    expect(swHeaderSet(svix(good))).toEqual({ id: 'svix-id', timestamp: 'svix-timestamp', signature: 'svix-signature' });
    expect(swHeaderSet(hdr(good))).toEqual({ id: 'webhook-id', timestamp: 'webhook-timestamp', signature: 'webhook-signature' });
    expect(swHeaderSet({})).toEqual({ id: 'webhook-id', timestamp: 'webhook-timestamp', signature: 'webhook-signature' });
  });

  it('[PK:T3] (phần b) trộn bộ (webhook-id + svix-timestamp/svix-signature, hoặc ngược lại) -> false', () => {
    const good = swSign(SECRET, ID, TS, BODY);
    const mixes = [
      { 'webhook-id': ID, 'svix-timestamp': String(TS), 'svix-signature': good },
      { 'webhook-id': ID, 'webhook-timestamp': String(TS), 'svix-signature': good },
      { 'svix-id': ID, 'svix-timestamp': String(TS), 'webhook-signature': good },
      { 'svix-id': ID, 'webhook-timestamp': String(TS), 'svix-signature': good },
    ];
    for (const h of mixes) expect([h, swVerify(SECRET, h, BODY, at(TS))]).toEqual([h, false]);
  });

  it('[MS:U4] header có 2 chữ ký "v1,sai v1,đúng" -> true', () => {
    const good = swSign(SECRET, ID, TS, BODY);
    expect(swVerify(SECRET, hdr(`v1,AAAA${good.slice(7)} ${good}`), BODY, at(TS))).toBe(true);
    expect(swVerify(SECRET, hdr('v1,sai v2,khac'), BODY, at(TS))).toBe(false);
  });

  it('[MS:U5] secret cũ không có whsec_ -> ký và verify bằng utf8', () => {
    const legacy = 'hub_outbound_signing_secret_999';
    const sig = swSign(legacy, ID, TS, BODY);
    expect(sig.startsWith('v1,')).toBe(true);
    expect(swVerify(legacy, hdr(sig), BODY, at(TS))).toBe(true);
    expect(swVerify(SECRET, hdr(sig), BODY, at(TS))).toBe(false);
  });

  it('S6: thiếu bất kỳ header nào / timestamp không phải số -> false', () => {
    const sig = swSign(SECRET, ID, TS, BODY);
    for (const k of ['webhook-id', 'webhook-timestamp', 'webhook-signature']) {
      const h: Record<string, string> = hdr(sig);
      delete h[k];
      expect(swVerify(SECRET, h, BODY, at(TS))).toBe(false);
    }
    expect(swVerify(SECRET, hdr(sig, 'abc' as any), BODY, at(TS))).toBe(false);
  });

  it('S6: swHeaders tạo đủ 3 header; generateWhsecSecret = whsec_ + base64 24 byte', () => {
    const h = swHeaders(SECRET, ID, BODY, TS);
    expect(h).toEqual({ 'webhook-id': ID, 'webhook-timestamp': String(TS), 'webhook-signature': swSign(SECRET, ID, TS, BODY) });
    const s = generateWhsecSecret();
    expect(s).toMatch(/^whsec_[A-Za-z0-9+/]{32}$/);
    expect(Buffer.from(s.slice(6), 'base64')).toHaveLength(24);
  });
});
