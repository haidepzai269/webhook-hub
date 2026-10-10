import { API_KEY_RE, apiKeyPrefix, buildConnectionString, generateApiKey, hashApiKey, installBigIntJson, isApiScope } from '../src';

describe('API key + connection string (S1/S2, ADR-038/039)', () => {
  it('generateApiKey: hk_<env>_ + 43 ký tự base64url (32 byte), mỗi lần khác nhau', () => {
    const a = generateApiKey('test');
    const b = generateApiKey('live');
    expect(a).toMatch(API_KEY_RE);
    expect(a.startsWith('hk_test_')).toBe(true);
    expect(b.startsWith('hk_live_')).toBe(true);
    expect(a.length).toBe(8 + 43);
    expect(generateApiKey('test')).not.toBe(a);
  });

  it('hashApiKey = sha256 hex 64 ký tự; prefix 12 ký tự', () => {
    expect(hashApiKey('hk_test_x')).toMatch(/^[0-9a-f]{64}$/);
    expect(apiKeyPrefix('hk_test_AbCdEfGh')).toBe('hk_test_AbCd');
  });

  it('connection string: http -> hub://, https -> hubs://, giữ cổng', () => {
    expect(buildConnectionString('http://localhost:4000', 'hk_test_k', 'cafe')).toBe('hub://hk_test_k@localhost:4000/cafe');
    expect(buildConnectionString('https://hub.example.com/', 'hk_live_k', 'bookstore')).toBe('hubs://hk_live_k@hub.example.com/bookstore');
  });

  it('isApiScope chỉ nhận 4 scope', () => {
    expect(['publish:events', 'read:events', 'manage:endpoints', 'manage:sources'].every(isApiScope)).toBe(true);
    expect(isApiScope('manage:keys')).toBe(false);
  });

  it('installBigIntJson: bigint ra JSON là CHUỖI (cursor seq không mất chính xác)', () => {
    installBigIntJson();
    expect(JSON.stringify({ seq: 9007199254740993n })).toBe('{"seq":"9007199254740993"}');
  });
});
