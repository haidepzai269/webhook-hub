import { createHmac } from 'crypto';
import { aesGcmEncrypt } from '@hub/crypto';
import { IngestService } from '../src/modules/ingest/ingest.service';
import { PenaltyBox } from '../src/modules/ingest/penalty-box';
import { TrafficRecorder } from '../src/modules/ingest/traffic-recorder';

/**
 * QT2 (SPEC-han-muc-dung-luong ĐÍNH CHÍNH E2, ADR-183): đo dung lượng cộng dồn qua bộ gộp EG4 — `traced()` cộng số byte
 * THỰC SỰ ghi xuống DB, không I/O trên đường nóng.
 */
describe('QT2 — byte cộng dồn qua bộ gộp lưu lượng', () => {
  const MASTER = 'test-master-key-at-least-32-characters!!';
  const SECRET = 'gh-secret-qt2';
  const body = JSON.stringify({ ref: 'refs/heads/main', after: 'abc', repository: { name: 'r' }, pad: 'x'.repeat(5000) });
  const sign = (s: string) => `sha256=${createHmac('sha256', s).update(body).digest('hex')}`;
  let d = 0;
  const req = (sig = sign(SECRET), delivery = `d-${++d}`) => ({
    provider: 'github' as const, sourceKey: 'ok', ip: '1.1.1.1', contentType: 'application/json', rawBody: Buffer.from(body), body: JSON.parse(body),
    headers: { 'x-hub-signature-256': sig, 'x-github-delivery': delivery, 'x-github-event': 'push' },
  });

  beforeAll(() => {
    process.env.MASTER_KEY = MASTER;
  });

  it('[QT:T31] (phần a) ACCEPTED cộng rawBody.length; DUPLICATE / RATE_LIMITED cộng 0; REJECTED cộng đúng độ dài mẫu đã lưu (≤4KB); publish cũng cộng; sink nhận cột bytes', async () => {
    const src = { id: 'src-a', tenantId: 'tenant-a', provider: 'github', isActive: true, archivedAt: null, secrets: [{ id: 's', secretEncrypted: aesGcmEncrypt(SECRET, MASTER) }] };
    const stored: Buffer[] = [];
    const tx = {
      rawEvent: { create: jest.fn(async ({ data }: any) => (stored.push(Buffer.from(data.bodyRaw)), { id: `raw-${stored.length}` })) },
      outbox: { create: jest.fn() },
    };
    const add = jest.fn().mockResolvedValue(1);
    const apiSource = { id: 'src-api', tenantId: 'tenant-a', provider: 'api', isActive: true, archivedAt: null, secrets: [] };
    const prisma: any = {
      findSourceBySourceKeyForIngest: jest.fn(async () => src),
      tenantTx: jest.fn(async (_t: string, fn: any) => fn(tx)),
      forTenant: () => ({ addSourceTraffic: add, findSourceById: jest.fn(async () => apiSource) }),
    };
    let rateOk = true;
    const redis: any = {
      checkRateLimit: jest.fn(async () => rateOk),
      getIdempotencyKey: jest.fn().mockResolvedValueOnce(null).mockResolvedValueOnce('raw-1').mockResolvedValue(null),
      setIdempotencyKey: jest.fn(),
    };
    const svc = new IngestService(prisma, redis);
    svc.penalty = new PenaltyBox({ threshold404: 20, threshold401: 99, banMs: 600_000, maxEntries: 1000, windowMs: 60_000 });

    expect((await svc.ingestWebhook(req(sign(SECRET), 'x'))).status).toBe(200); // ACCEPTED
    expect((await svc.ingestWebhook(req(sign(SECRET), 'x'))).status).toBe(200); // DUPLICATE (Redis)
    expect((await svc.ingestWebhook(req(sign('sai')))).status).toBe(401); // REJECTED, mẫu ≤ 4KB đã lưu
    rateOk = false;
    expect((await svc.ingestWebhook(req())).status).toBe(429); // RATE_LIMITED
    rateOk = true;
    const pub = Buffer.from(JSON.stringify({ type: 'order.created', idempotencyKey: 'k-1', data: { a: 1 } }));
    const r = await svc.publishFromService('tenant-a', 'src-api', {
      provider: 'api', sourceKey: 'api_x', headers: {}, rawBody: pub, body: JSON.parse(pub.toString()), contentType: 'application/json', ip: '2.2.2.2',
    } as any);
    expect(r.status).toBeLessThan(300);
    expect(add).not.toHaveBeenCalled(); // đường nóng: +0 truy vấn

    await svc.traffic.flush();
    const rows = add.mock.calls.flatMap((c) => c[0]);
    const by = (sourceId: string, outcome: string) => rows.find((x: any) => x.sourceId === sourceId && x.outcome === outcome);
    expect(stored).toHaveLength(3); // ACCEPTED + mẫu REJECTED + publish
    expect(by('src-a', 'ACCEPTED')).toMatchObject({ count: 1, bytes: Buffer.byteLength(body) });
    expect(by('src-a', 'DUPLICATE')).toMatchObject({ count: 1, bytes: 0 });
    expect(by('src-a', 'RATE_LIMITED')).toMatchObject({ count: 1, bytes: 0 });
    expect(by('src-a', 'REJECTED')).toMatchObject({ count: 1, bytes: stored[1].length });
    expect(stored[1].length).toBeLessThanOrEqual(4096);
    expect(by('src-api', 'ACCEPTED')).toMatchObject({ count: 1, bytes: pub.length });
  });

  it('[QT:T31] (phần c) bộ gộp: bytes cộng theo ô, ghi lỗi thì giữ lại cả bytes cho lượt sau; dòng thiếu bytes coi như 0', async () => {
    let fail = true;
    const got: any[] = [];
    const rec = new TrafficRecorder(async (_t, rows) => {
      if (fail) throw new Error('db down');
      got.push(...rows);
    }, { flushMs: 0, clock: () => 120_000 });
    rec.record('t', 's', 'ACCEPTED', '1.1.1.1', 100);
    rec.record('t', 's', 'ACCEPTED', '1.1.1.1', 50);
    rec.record('t', 's', 'DUPLICATE', '1.1.1.1');
    rec.record('t', 's', 'ACCEPTED', '1.1.1.1', NaN);
    await rec.flush(); // lỗi -> giữ
    rec.record('t', 's', 'ACCEPTED', '1.1.1.1', 25);
    fail = false;
    await rec.flush();
    expect(got.map((r) => [r.outcome, r.count, r.bytes])).toEqual([
      ['ACCEPTED', 4, 175],
      ['DUPLICATE', 1, 0],
    ]);
  });
});
