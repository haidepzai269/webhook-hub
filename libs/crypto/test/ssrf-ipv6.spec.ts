import { isPrivateIp, validateAndPinUrl } from '../src/ssrf';

/**
 * MS-R1 (review pha 1, ADR-083): IPv6 ánh xạ/nhúng IPv4 và địa chỉ đặc biệt phải bị chặn ở production. Trước đây
 * `http://[::ffff:127.0.0.1]/`, `http://[::ffff:10.0.0.1]/`, `http://[::]/` lọt -> key service dò được cổng nội bộ.
 */
describe('SSRF Guard — IPv6 (MS-R1)', () => {
  const env = process.env.NODE_ENV;
  beforeAll(() => ((process.env as any).NODE_ENV = 'production'));
  afterAll(() => ((process.env as any).NODE_ENV = env));

  it.each([
    'http://[::ffff:127.0.0.1]:4000/',
    'http://[::ffff:10.0.0.1]/',
    'http://[::ffff:7f00:1]/',
    'http://[::ffff:a9fe:a9fe]/latest/meta-data',
    'http://[0:0:0:0:0:ffff:192.168.1.1]/',
    'http://[::]/',
    'http://[::1]/',
    'http://[::127.0.0.1]/',
    'http://[64:ff9b::7f00:1]/',
    'http://[64:ff9b::808:808]/',
    'http://[fc00::1]/',
    'http://[fd12:3456::1]/',
    'http://[fe80::1]/',
    'http://[febf::1]/',
  ])('MS-R1: %s -> SSRF bị chặn ở production', async (url) => {
    await expect(validateAndPinUrl(url)).rejects.toThrow(/SSRF/);
  });

  it('MS-R1: IPv6 public và IPv4-mapped của IP public vẫn đi được', async () => {
    await expect(validateAndPinUrl('http://[2606:4700:4700::1111]/')).resolves.toMatchObject({ pinnedIp: '2606:4700:4700::1111' });
    expect(isPrivateIp('::ffff:8.8.8.8')).toBe(false);
    expect(isPrivateIp('::ffff:808:808')).toBe(false);
    expect(isPrivateIp('2001:db8::1')).toBe(false);
  });
});
