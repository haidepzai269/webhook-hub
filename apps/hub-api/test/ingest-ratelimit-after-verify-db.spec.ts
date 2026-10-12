import { randomUUID } from 'crypto';
import { PayOS } from '@payos/node';
import { aesGcmEncrypt } from '@hub/crypto';
import { describeDb } from '../../../libs/database/test/support/test-db';
import { IngestService } from '../src/modules/ingest/ingest.service';
import { RedisService } from '../src/modules/redis/redis.service';

/**
 * EG3 (SPEC-chong-qua-tai §4.3, ADR-178): rate limit theo source chạy SAU verify, đếm bằng Redis THẬT của hubv.
 * Trước EG3: 100 request sai chữ ký tiêu hết hạn mức 100/phút -> PayOS thật nhận 429. Sau EG3: vẫn 200.
 * Postgres giả (chỉ cần source + transaction); bộ đếm `rate:source:{id}` là Redis thật, id ngẫu nhiên mỗi lượt.
 */
describeDb('EG3 rate limit sau verify (Redis hubv)', () => {
  const MASTER = 'test-master-key-at-least-32-characters!!';
  const KEY = 'checksum-key-for-test-eg3-1234567890';
  const data = {
    orderCode: 31337, amount: 5000, description: 'EG3', accountNumber: '12345678', reference: 'EG3REF',
    transactionDateTime: '2026-10-12 10:00:00', currency: 'VND', paymentLinkId: 'eg3', code: '00', desc: 'Thành công',
    counterAccountBankId: '', counterAccountBankName: '', counterAccountName: '', counterAccountNumber: '',
    virtualAccountName: '', virtualAccountNumber: '',
  };
  let redis: RedisService;
  let prevMaster: string | undefined;
  let prevLimit: string | undefined;
  const sourceId = randomUUID();

  beforeAll(async () => {
    prevMaster = process.env.MASTER_KEY;
    prevLimit = process.env.INGEST_RATE_LIMIT_PER_MIN;
    process.env.MASTER_KEY = MASTER;
    delete process.env.INGEST_RATE_LIMIT_PER_MIN; // trần mặc định 100/phút
    redis = new RedisService();
    // checkRateLimit fail-open khi Redis chưa sẵn sàng -> phải chờ 'ready', không thì test xanh giả.
    if (redis.client.status !== 'ready') await new Promise((resolve) => redis.client.once('ready', resolve));
  });
  afterAll(async () => {
    await redis.client.del(`rate:source:${sourceId}`);
    redis.onModuleDestroy();
    process.env.MASTER_KEY = prevMaster;
    if (prevLimit !== undefined) process.env.INGEST_RATE_LIMIT_PER_MIN = prevLimit;
  });

  it('[EG:T12] 100 request sai chữ ký vào source A, rồi request PayOS hợp lệ vẫn nhận 200, không phải 429', async () => {
    const tx = { rawEvent: { create: jest.fn().mockResolvedValue({ id: 'raw-eg3' }) }, outbox: { create: jest.fn() } };
    const prisma: any = {
      findSourceBySourceKeyForIngest: jest.fn().mockResolvedValue({
        id: sourceId, tenantId: 'tenant-eg3', isActive: true, archivedAt: null, secrets: [{ id: 's', secretEncrypted: aesGcmEncrypt(KEY, MASTER) }],
      }),
      tenantTx: jest.fn(async (_t: string, fn: any) => fn(tx)),
    };
    const svc = new IngestService(prisma, redis);
    const good = await new PayOS({ clientId: 'x', apiKey: 'x', checksumKey: KEY }).crypto.createSignatureFromObj(data, KEY);
    const req = (signature: string, ip: string) => {
      const raw = JSON.stringify({ code: '00', desc: 'success', success: true, data, signature });
      return { provider: 'payos' as const, sourceKey: 'src_payos_eg3', headers: { 'content-type': 'application/json' }, rawBody: Buffer.from(raw), body: JSON.parse(raw), contentType: 'application/json', ip };
    };
    // Kẻ tấn công xoay IP (mỗi request một IP) -> hộp phạt theo cặp (EG2) không ra tay; chỉ còn EG3 bảo vệ hạn mức.
    for (let i = 0; i < 100; i++) {
      expect((await svc.ingestWebhook(req('0'.repeat(64), `198.18.${i >> 8}.${i & 255}`))).status).toBe(401);
    }
    expect(await redis.client.get(`rate:source:${sourceId}`)).toBeNull(); // sai chữ ký không tiêu hạn mức
    const ok = await svc.ingestWebhook(req(good, '203.0.113.200'));
    expect(ok.status).toBe(200);
    expect(await redis.client.get(`rate:source:${sourceId}`)).toBe('1');
  });
});
