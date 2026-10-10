import { redactSecrets } from '../src/modules/api/redact-secrets.interceptor';

describe('redactSecrets', () => {
  it('bỏ 3 cột ciphertext ở mọi độ sâu, thay bằng cờ has*', () => {
    const delivery = {
      id: 'd1',
      subscription: {
        destination: { id: 'x', configEncrypted: 'iv:ct:tag', signingSecretEncrypted: null },
      },
      source: { secrets: [{ id: 's', secretEncrypted: 'iv:ct:tag', version: 1 }] },
    };

    expect(redactSecrets([delivery])).toEqual([
      {
        id: 'd1',
        subscription: { destination: { id: 'x', hasConfig: true, hasSigningSecret: false } },
        source: { secrets: [{ id: 's', hasSecret: true, version: 1 }] },
      },
    ]);
    expect(JSON.stringify(redactSecrets(delivery))).not.toContain('iv:ct:tag');
  });

  it('KHÔNG đụng vào payload người dùng có trường tình cờ tên …Encrypted', () => {
    const event = { data: { cardEncrypted: 'abc', nested: { fooEncrypted: 1 } } };
    expect(redactSecrets(event)).toEqual(event);
  });

  it('BigInt (DeliveryAttempt.id) → string để JSON.stringify không ném lỗi', () => {
    const delivery = { id: 'd1', attempts: [{ id: 42n, attemptNo: 1 }] };
    const out = redactSecrets(delivery);
    expect(out).toEqual({ id: 'd1', attempts: [{ id: '42', attemptNo: 1 }] });
    expect(() => JSON.stringify(out)).not.toThrow();
  });

  it('giữ nguyên Date và Buffer (raw body) thay vì đệ quy vào chúng', () => {
    const at = new Date('2026-10-09T00:00:00Z');
    const raw = Buffer.from('{"a":1}');
    const out = redactSecrets({ receivedAt: at, bodyRaw: raw }) as { receivedAt: Date; bodyRaw: Buffer };
    expect(out.receivedAt).toBe(at);
    expect(out.bodyRaw).toBe(raw);
  });

  it('null / primitive đi qua nguyên vẹn', () => {
    expect(redactSecrets(null)).toBeNull();
    expect(redactSecrets(42)).toBe(42);
    expect(redactSecrets('x')).toBe('x');
  });
});
