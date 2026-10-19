import { randomUUID } from 'crypto';
import { PrismaService } from '@hub/database';
import { describeDb, newTestPrisma } from '../../../libs/database/test/support/test-db';

/**
 * ADR-269 trên Postgres THẬT (RUN_DB_TESTS=1): badge sidebar đếm kẹp 10, theo mốc last-seen, DLQ theo updated_at
 * (KHÔNG created_at), bản DEAD đã bị replay (superseded) không tính, và tenant khác không lọt vào.
 */
describeDb('GET /badges — badgeSnapshot (Postgres, ADR-269)', () => {
  const raw = newTestPrisma('owner');
  const svc = new PrismaService();
  const A = randomUUID();
  const B = randomUUID();
  const run = randomUUID().slice(0, 8);
  const old = new Date(Date.now() - 3 * 3600_000);
  const mark = new Date(Date.now() - 3600_000).toISOString();
  const ids = { srcA: '', srcB: '', rawA: '', rawB: '', subA: '', subB: '', seqBefore: '0' };

  async function mkTenant(t: string, tag: string) {
    const source = await raw.source.create({ data: { tenantId: t, provider: 'payos', name: `b-${tag}-${run}`, sourceKey: `src_b_${tag}_${run}` } });
    const rawEv = await raw.rawEvent.create({
      data: { sourceId: source.id, idempotencyKey: `b:${tag}:${run}`, headers: {}, body: {}, bodyRaw: Buffer.from('{}'), signatureValid: true },
    });
    const dest = await raw.destination.create({ data: { tenantId: t, name: `Dest-${tag}-${run}`, type: 'webhook', configEncrypted: 'x' } });
    const sub = await raw.subscription.create({ data: { tenantId: t, destinationId: dest.id, name: 'b', eventTypes: ['*'] } });
    return { source: source.id, raw: rawEv.id, sub: sub.id };
  }
  // events.raw_event_id UNIQUE (1 raw : 1 event) -> mỗi event một raw_event riêng.
  const mkEvent = async (t: string, sourceId: string, n: number) => {
    const rawEv = await raw.rawEvent.create({
      data: { sourceId, idempotencyKey: `b:raw:${t}:${n}`, headers: {}, body: {}, bodyRaw: Buffer.from('{}'), signatureValid: true },
    });
    return raw.event.create({
      data: { id: `EVB${t === A ? 'A' : 'B'}${run}${n}`, tenantId: t, rawEventId: rawEv.id, idempotencyKey: `bevt:${t}:${n}`, correlationId: randomUUID(), type: 'payment.received', source: 'payos', subject: 's', data: {} },
    });
  };

  beforeAll(async () => {
    const a = await mkTenant(A, 'a');
    const b = await mkTenant(B, 'b');
    ids.srcA = a.source; ids.srcB = b.source; ids.rawA = a.raw; ids.rawB = b.raw; ids.subA = a.sub; ids.subB = b.sub;
    const first = await mkEvent(A, a.source, 0);
    ids.seqBefore = first.seq.toString();
    for (let i = 1; i <= 12; i++) await mkEvent(A, a.source, i); // 12 mới hơn mốc
    await mkEvent(B, b.source, 1); // tenant khác: không được lọt
    const evA = first.id;
    // deliveries: 1 DEAD cũ về created_at nhưng MỚI về updated_at (DLQ phải thấy), 1 DEAD đã bị replay, 1 SUCCEEDED mới
    await raw.delivery.create({ data: { tenantId: A, eventId: evA, subscriptionId: ids.subA, attemptGeneration: 1, status: 'DEAD', attemptCount: 5, createdAt: old, updatedAt: new Date() } });
    await raw.delivery.create({ data: { tenantId: A, eventId: evA, subscriptionId: ids.subA, attemptGeneration: 2, status: 'SUCCEEDED', attemptCount: 1 } });
    // DEAD KHÔNG bị thay thế: created_at = now-3h (trước mốc), updated_at = now (sau mốc). Nếu SQL đổi sang lọc created_at thì test đỏ.
    await raw.delivery.create({ data: { tenantId: A, eventId: `EVBA${run}1`, subscriptionId: ids.subA, attemptGeneration: 1, status: 'DEAD', attemptCount: 4, createdAt: old, updatedAt: new Date() } });
    await raw.delivery.create({ data: { tenantId: B, eventId: `EVBB${run}1`, subscriptionId: ids.subB, status: 'DEAD', attemptCount: 3 } });
  });

  afterAll(async () => {
    for (const t of [A, B]) {
      await raw.delivery.deleteMany({ where: { tenantId: t } });
      await raw.event.deleteMany({ where: { tenantId: t } });
      await raw.subscription.deleteMany({ where: { tenantId: t } });
      await raw.destination.deleteMany({ where: { tenantId: t } });
      await raw.source.deleteMany({ where: { tenantId: t } });
    }
    await raw.$disconnect();
    await svc.$disconnect();
  });

  it('events: kẹp 10, latest là bản mới nhất, cursor = seq lớn nhất; tenant khác không lọt', async () => {
    const r = await svc.forTenant(A).badgeSnapshot({ events: ids.seqBefore });
    expect(r.events.count).toBe(10);
    expect(r.events.latest?.type).toBe('payment.received');
    expect(BigInt(r.events.cursor as string) > BigInt(ids.seqBefore)).toBe(true);
    const again = await svc.forTenant(A).badgeSnapshot({ events: r.events.cursor });
    expect(again.events.count).toBe(0);
    expect(again.events.latest).toBeNull();
    const other = await svc.forTenant(B).badgeSnapshot({ events: ids.seqBefore });
    expect(other.events.count).toBe(1); // chỉ event của B (seq > mốc), không phải 12 của A
  });

  it("mốc 'head' (lần đầu): trả mốc hiện tại của server, không đếm; dùng làm mốc thì count 0", async () => {
    const h = await svc.forTenant(A).badgeSnapshot({ events: 'head', deliveries: 'head', dlq: 'head' });
    expect([h.events.count, h.deliveries.count, h.dlq.count]).toEqual([0, 0, 0]);
    expect(h.events.cursor).toMatch(/^\d+$/);
    expect(h.deliveries.cursor).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
    const next = await svc.forTenant(A).badgeSnapshot({ events: h.events.cursor, deliveries: h.deliveries.cursor, dlq: h.dlq.cursor });
    expect([next.events.count, next.deliveries.count, next.dlq.count]).toEqual([0, 0, 0]);
  });

  it('thiếu mốc = bỏ qua tab (không truy vấn, count 0)', async () => {
    const r = await svc.forTenant(A).badgeSnapshot({});
    expect([r.events.count, r.deliveries.count, r.dlq.count]).toEqual([0, 0, 0]);
  });

  it('dlq theo updated_at (không created_at), tên đích + attemptNo; superseded không tính; cursor đẩy mốc qua dòng đó', async () => {
    const r = await svc.forTenant(A).badgeSnapshot({ dlq: mark });
    // DEAD gen1 của evA đã bị gen2 (SUCCEEDED) thay thế -> không tính; DEAD của event 1 (created_at cũ, updated_at mới) -> đúng 1
    expect(r.dlq.count).toBe(1);
    expect(r.dlq.latest).toMatchObject({ destination: `Dest-a-${run}`, attemptNo: 4 });
    const rB = await svc.forTenant(B).badgeSnapshot({ dlq: mark });
    expect(rB.dlq.count).toBe(1);
    expect(rB.dlq.latest).toMatchObject({ destination: `Dest-b-${run}`, attemptNo: 3 });
    const after = await svc.forTenant(B).badgeSnapshot({ dlq: rB.dlq.cursor });
    expect(after.dlq.count).toBe(0);
  });

  it('deliveries: theo created_at, latest có tên đích + trạng thái, tenant khác không lọt', async () => {
    const r = await svc.forTenant(A).badgeSnapshot({ deliveries: mark });
    expect(r.deliveries.count).toBe(1); // dòng SUCCEEDED mới; dòng DEAD có created_at cũ
    expect(r.deliveries.latest).toMatchObject({ destination: `Dest-a-${run}`, status: 'SUCCEEDED' });
  });
});
