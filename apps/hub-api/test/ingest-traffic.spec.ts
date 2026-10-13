import { createHmac } from 'crypto';
import { aesGcmEncrypt } from '@hub/crypto';
import { IngestService } from '../src/modules/ingest/ingest.service';
import { PenaltyBox } from '../src/modules/ingest/penalty-box';
import { flushAll, onShutdownFlush, shutdownFlusherCount } from '../src/shutdown';
import { addSpaceSaving } from '../src/modules/ingest/traffic-recorder';

/**
 * EG4 (ADR-179): `traced()` cộng lưu lượng trong bộ nhớ — không I/O trên đường nóng; 404 sourceKey lạ không thuộc tenant nào
 * nên KHÔNG vào bảng; BLOCKED = hộp phạt chặn theo cặp.
 */
describe('EG4 ingest -> lưu lượng trong bộ nhớ', () => {
  const MASTER = 'test-master-key-at-least-32-characters!!';
  const SECRET = 'gh-secret-eg4';
  const body = JSON.stringify({ ref: 'refs/heads/main', after: 'abc', repository: { name: 'r' } });
  const sign = (s: string) => `sha256=${createHmac('sha256', s).update(body).digest('hex')}`;
  let d = 0;
  const req = (sourceKey: string, ip: string, sig = sign(SECRET), delivery = `d-${++d}`) => ({
    provider: 'github' as const, sourceKey, ip, contentType: 'application/json', rawBody: Buffer.from(body), body: JSON.parse(body),
    headers: { 'x-hub-signature-256': sig, 'x-github-delivery': delivery, 'x-github-event': 'push' },
  });

  beforeAll(() => {
    process.env.MASTER_KEY = MASTER;
  });

  it('ACCEPTED / DUPLICATE / REJECTED / RATE_LIMITED / BLOCKED được đếm theo (tenant, source); 404 lạ thì không; sink nhận đúng dòng', async () => {
    const src = { id: 'src-a', tenantId: 'tenant-a', provider: 'github', isActive: true, archivedAt: null, secrets: [{ id: 's', secretEncrypted: aesGcmEncrypt(SECRET, MASTER) }] };
    const tx = { rawEvent: { create: jest.fn().mockResolvedValue({ id: 'raw-1' }) }, outbox: { create: jest.fn() } };
    const add = jest.fn().mockResolvedValue(1);
    const prisma: any = {
      findSourceBySourceKeyForIngest: jest.fn(async (k: string) => (k === 'ok' ? src : null)),
      tenantTx: jest.fn(async (_t: string, fn: any) => fn(tx)),
      forTenant: () => ({ addSourceTraffic: add }),
    };
    let rateOk = true;
    const redis: any = {
      checkRateLimit: jest.fn(async () => rateOk),
      getIdempotencyKey: jest.fn().mockResolvedValueOnce(null).mockResolvedValueOnce('raw-1').mockResolvedValue(null),
      setIdempotencyKey: jest.fn(),
    };
    const svc = new IngestService(prisma, redis);
    svc.penalty = new PenaltyBox({ threshold404: 20, threshold401: 2, banMs: 600_000, maxEntries: 1000, windowMs: 60_000 });
    expect((await svc.ingestWebhook(req('ok', '1.1.1.1', sign(SECRET), 'x'))).status).toBe(200); // ACCEPTED
    expect((await svc.ingestWebhook(req('ok', '1.1.1.1', sign(SECRET), 'x'))).status).toBe(200); // DUPLICATE (Redis)
    rateOk = false;
    expect((await svc.ingestWebhook(req('ok', '1.1.1.1'))).status).toBe(429); // RATE_LIMITED
    expect((await svc.ingestWebhook(req('ok', '6.6.6.6', sign('sai')))).status).toBe(401);
    expect((await svc.ingestWebhook(req('ok', '6.6.6.6', sign('sai')))).status).toBe(401); // -> bị phạt theo cặp
    expect((await svc.ingestWebhook(req('ok', '6.6.6.6', sign('sai')))).status).toBe(429); // BLOCKED
    expect((await svc.ingestWebhook(req('khong-co', '9.9.9.9'))).status).toBe(404); // không thuộc tenant nào
    expect(add).not.toHaveBeenCalled(); // đường nóng không ghi DB
    expect(svc.traffic.pendingCount()).toBe(6);

    await svc.traffic.flush();
    expect(add).toHaveBeenCalledTimes(1);
    const rows = add.mock.calls[0][0];
    expect(rows.map((r: any) => [r.outcome, r.count])).toEqual([
      ['ACCEPTED', 1], ['DUPLICATE', 1], ['REJECTED', 2], ['RATE_LIMITED', 1], ['BLOCKED', 1],
    ]);
    expect(rows.find((r: any) => r.outcome === 'REJECTED').topIps).toEqual([{ ip: '6.6.6.6', count: 2 }]);
    expect(rows.every((r: any) => r.sourceId === 'src-a')).toBe(true);
  });

  it('tắt máy: bộ đệm đã đăng ký được ghi nốt cùng flush chính; một bộ lỗi không chặn bộ khác', async () => {
    const order: string[] = [];
    const off1 = onShutdownFlush(async () => {
      order.push('traffic');
    });
    const off2 = onShutdownFlush(async () => Promise.reject(new Error('db down')));
    await flushAll(async () => {
      order.push('duplicates');
    });
    off1();
    off2();
    expect(order.sort()).toEqual(['duplicates', 'traffic']);
  });

  it('IngestService đăng ký ghi nốt lưu lượng khi init và GỠ khi destroy (không rò bộ đăng ký)', async () => {
    const before = shutdownFlusherCount();
    const svc = new IngestService({ forTenant: () => ({ addSourceTraffic: jest.fn(), addIngestDuplicates: jest.fn() }) } as any, {} as any);
    svc.onModuleInit();
    expect(shutdownFlusherCount()).toBe(before + 1);
    await svc.onModuleDestroy();
    expect(shutdownFlusherCount()).toBe(before);
  });

  it('top_ips space-saving: đầy thì IP mới thay IP nhỏ nhất — IP gửi dồn dập đến SAU 64 IP khác vẫn lên top', () => {
    const ips = new Map<string, number>();
    for (let i = 0; i < 64; i++) addSpaceSaving(ips, `198.51.100.${i}`);
    for (let i = 0; i < 50; i++) addSpaceSaving(ips, '203.0.113.7');
    expect(ips.size).toBe(64);
    const top = [...ips].sort((a, b) => b[1] - a[1])[0];
    expect(top[0]).toBe('203.0.113.7');
    expect(top[1]).toBeGreaterThanOrEqual(50);
  });
});
