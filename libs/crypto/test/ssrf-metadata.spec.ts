import { isLinkLocalIp, validateAndPinUrl } from '../src/ssrf';

/**
 * S6 (ADR-076): ngoài production hub cho phép IP private (sink/echo trong mạng docker, ADR-068) nhưng dải
 * link-local — nơi có metadata đám mây 169.254.169.254 / fe80::/10 — bị chặn Ở MỌI MÔI TRƯỜNG, kể cả allowPrivate.
 */
describe('SSRF Guard — link-local/metadata luôn bị chặn (S6)', () => {
  const env = process.env.NODE_ENV;
  afterEach(() => ((process.env as any).NODE_ENV = env));

  it('[MS:T4] (phần a) 169.254.169.254 bị chặn cả khi NODE_ENV=development và allowPrivate=true', async () => {
    (process.env as any).NODE_ENV = 'development';
    await expect(validateAndPinUrl('http://169.254.169.254/latest/meta-data')).rejects.toThrow(/SSRF/);
    await expect(validateAndPinUrl('http://169.254.169.254/latest/meta-data', true)).rejects.toThrow(/SSRF/);
    await expect(validateAndPinUrl('http://[fe80::1]/x', true)).rejects.toThrow(/SSRF/);
  });

  it('S6: IP private thường (10.x) vẫn được phép ở development (sink của hubv), bị chặn ở production', async () => {
    (process.env as any).NODE_ENV = 'development';
    await expect(validateAndPinUrl('http://10.0.0.5:4100/x')).resolves.toMatchObject({ pinnedIp: '10.0.0.5' });
    (process.env as any).NODE_ENV = 'production';
    await expect(validateAndPinUrl('http://10.0.0.5:4100/x')).rejects.toThrow(/SSRF/);
  });

  it('S6: isLinkLocalIp nhận cả dạng IPv4-mapped IPv6', () => {
    expect(isLinkLocalIp('169.254.1.1')).toBe(true);
    expect(isLinkLocalIp('::ffff:169.254.169.254')).toBe(true);
    expect(isLinkLocalIp('fe80::abcd')).toBe(true);
    expect(isLinkLocalIp('10.0.0.1')).toBe(false);
  });
});
