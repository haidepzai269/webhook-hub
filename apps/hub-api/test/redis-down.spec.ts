import { RedisService } from '../src/modules/redis/redis.service';

/**
 * MS-P2-3 (review pha 2, ADR-090): Redis CHẾT (host không trả lời — kết nối treo, không bị từ chối ngay) thì mỗi lệnh
 * của đường ingest phải fail-open NHANH (BB-2: Redis được phép sai, chỉ được chậm rất ít). Trước: 8–18s/request.
 */
describe('Redis chết -> fail-open nhanh (MS-P2-3)', () => {
  const prev = process.env.REDIS_URL;
  let svc: RedisService;
  beforeAll(() => {
    process.env.REDIS_URL = 'redis://10.255.255.1:6379'; // không định tuyến được: connect treo
    svc = new RedisService();
  });
  afterAll(() => {
    svc.onModuleDestroy();
    process.env.REDIS_URL = prev;
  });

  it('MS-P2-3: rate limit + GET idem + SET idem (3 lệnh của /hooks) xong < 1s tổng, kết quả fail-open', async () => {
    const t0 = Date.now();
    expect(await svc.checkRateLimit('rate:x', 100, 60)).toBe(true); // fail-open
    expect(await svc.getIdempotencyKey('idem:x')).toBeNull();
    await svc.setIdempotencyKey('idem:x', 'r1', 60);
    expect(Date.now() - t0).toBeLessThan(1000);
  }, 30_000);
});
