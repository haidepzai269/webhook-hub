import { isLinkLocalIp, isPrivateIp, validateAndPinUrl } from '../src/ssrf';

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
    expect(isPrivateIp('2a00:1450:4001:80b::200e')).toBe(false);
    expect(isPrivateIp('8.8.8.8')).toBe(false);
  });

  it.each([
    '192.0.0.8', '192.0.2.1', '198.18.0.1', '198.19.255.255', '198.51.100.7', '203.0.113.9', '224.0.0.1', '239.255.255.250',
    '240.0.0.1', '255.255.255.255', '192.88.99.1',
    '64:ff9b:1::a00:1', '2002:7f00:1::', '2002:a9fe:a9fe::1', '2001:db8::1', '2001::1', 'ff02::1', '::ffff:0:7f00:1', '100::1',
  ])('MS-P2-4: %s không phải global unicast -> chặn (allowlist)', (ip) => {
    expect(isPrivateIp(ip)).toBe(true);
  });

  it('MS-P2-4: development vẫn chặn link-local giấu trong NAT64 / 6to4', () => {
    expect(isLinkLocalIp('64:ff9b::a9fe:a9fe')).toBe(true);
    expect(isLinkLocalIp('2002:a9fe:a9fe::')).toBe(true);
    expect(isLinkLocalIp('64:ff9b::808:808')).toBe(false);
  });
});

