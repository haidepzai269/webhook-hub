import { randomUUID } from 'crypto';
import { importanceOf } from '@hub/common';
import { PrismaService } from '../src/prisma.service';
import { describeDb, newTestPrisma } from './support/test-db';

/**
 * QT4 (SPEC-han-muc-dung-luong §5.1–§5.5 + E2, ADR-184) trên Postgres THẬT (repo chạy bằng hub_app -> RLS có hiệu lực):
 * "Dọn" giữ chống trùng (BB-2), "Xoá hẳn" mất chống trùng, không đụng delivery đang chạy / dữ liệu trong cửa sổ retry /
 * source "Giữ lâu" / audit_logs, byte giải phóng trừ vào usage và hạ nấc NGAY, polling trả `trimmed`.
 */
describeDb('QT4: lệnh dọn (Postgres)', () => {
  const owner = newTestPrisma('owner');
  const svc = new PrismaService();
  const A = randomUUID();
  const run = randomUUID().slice(0, 8);
  const DAY = 86_400_000;
  const ago = (d: number) => new Date(Date.now() - d * DAY);
  const FLOOR = new Date(Date.now() - 3 * 3_600_000);
  let sourceId = '';
  let keepId = '';
  let subId = '';
  let n = 0;

  beforeAll(async () => {
    await owner.project.create({ data: { id: A, slug: `qt4-${run}`, name: 'qt4' } });
    sourceId = (await owner.source.create({ data: { tenantId: A, provider: 'github', name: 'qt4', sourceKey: `qt4_${run}` } })).id;
    keepId = (await owner.source.create({ data: { tenantId: A, provider: 'payos', name: 'qt4k', sourceKey: `qt4k_${run}`, keepLonger: true } })).id;
    const dest = await owner.destination.create({ data: { tenantId: A, name: `d-${run}`, type: 'webhook', configEncrypted: 'x' } });
    subId = (await owner.subscription.create({ data: { tenantId: A, destinationId: dest.id, name: `s-${run}`, eventTypes: ['*'] } })).id;
    await owner.projectUsage.create({ data: { tenantId: A, usedBytes: 0n, calibratedAt: new Date(), level: 'OK' } });
  }, 60_000);

  afterAll(async () => {
    await owner.delivery.deleteMany({ where: { tenantId: A } });
    await owner.event.deleteMany({ where: { tenantId: A } });
    await owner.rawEvent.deleteMany({ where: { source: { tenantId: A } } });
    await owner.subscription.deleteMany({ where: { tenantId: A } });
    await owner.destination.deleteMany({ where: { tenantId: A } });
    await owner.auditLog.deleteMany({ where: { tenantId: A } });
    await owner.source.deleteMany({ where: { tenantId: A } });
    await owner.project.deleteMany({ where: { id: A } });
    await owner.$disconnect();
    await svc.$disconnect();
  });

  /** Event + raw (ACCEPTED, body_raw `kb` KB) + delivery theo `status` (null = không có delivery). */
  async function ev(o: { days: number; status?: 'SUCCEEDED' | 'DEAD' | 'PENDING' | 'RETRYING' | null; src?: string; kb?: number }) {
    const k = `${run}:${++n}`;
    const src = o.src ?? sourceId;
    const r = await owner.rawEvent.create({
      data: { sourceId: src, idempotencyKey: k, headers: { h: 'x' }, body: { a: 1 }, bodyRaw: Buffer.alloc((o.kb ?? 10) * 1024, 97), signatureValid: true, status: 'ACCEPTED', receivedAt: ago(o.days) },
    });
    const e = await owner.event.create({
      data: { id: `qt4_${run}_${n}`, tenantId: A, sourceId: src, rawEventId: r.id, idempotencyKey: `qt4:${k}`, correlationId: randomUUID(), type: 'order.x', source: 'github', data: { blob: 'y'.repeat(5000) }, receivedAt: ago(o.days) },
    });
    if (o.status) {
      const d = await owner.delivery.create({ data: { tenantId: A, eventId: e.id, subscriptionId: subId, status: o.status, lastError: 'e'.repeat(800) } });
      await owner.deliveryAttempt.create({ data: { deliveryId: d.id, attemptNo: 1, requestBody: { big: 'z'.repeat(3000) }, responseBody: 'r'.repeat(3000), error: 'x'.repeat(900) } });
    }
    return { raw: r, event: e, key: k };
  }

  const clean = (o: Partial<Parameters<ReturnType<PrismaService['forTenant']>['cleanStorageBatch']>[0]>) =>
    svc.forTenant(A).cleanStorageBatch({ action: 'trim', importance: ['low'], cutoff: ago(3), floor: FLOOR, limit: 1000, quotaBytes: 50 * 1024 * 1024, ...o });

  it('[QT:T15] "Dọn" giữ dòng events/raw_events (khoá chống trùng còn): gửi lại cùng khoá -> Postgres vẫn chặn (P2002); data null, trimmed_at có; byte giải phóng > 0', async () => {
    const x = await ev({ days: 5, status: 'SUCCEEDED' });
    const auditsBefore = await owner.auditLog.count({ where: { tenantId: A } });
    const r = await clean({ action: 'trim', importance: ['low'] });
    expect(r.events).toBeGreaterThanOrEqual(1);
    expect(r.freedBytes).toBeGreaterThan(10 * 1024);
    const e = await owner.event.findUnique({ where: { id: x.event.id } });
    expect(e).toMatchObject({ data: null });
    expect(e!.trimmedAt).toBeInstanceOf(Date);
    const raw = await owner.rawEvent.findUnique({ where: { id: x.raw.id } });
    expect(raw!.trimmedAt).toBeInstanceOf(Date);
    expect(Buffer.from(raw!.bodyRaw).length).toBe(0);
    const att = await owner.deliveryAttempt.findFirst({ where: { delivery: { eventId: x.event.id } } });
    expect(att).toMatchObject({ requestBody: null, responseBody: null });
    expect(att!.error!.length).toBeLessThanOrEqual(200);
    // BB-2: trọng tài chống trùng là unique của Postgres — gửi lại cùng (source, idempotency_key) bị chặn
    await expect(
      owner.rawEvent.create({ data: { sourceId, idempotencyKey: x.key, headers: {}, body: {}, bodyRaw: Buffer.from('{}'), signatureValid: true, status: 'ACCEPTED' } }),
    ).rejects.toMatchObject({ code: 'P2002' });
    await expect(
      owner.event.create({ data: { id: `dup_${run}`, tenantId: A, idempotencyKey: `qt4:${x.key}`, correlationId: randomUUID(), type: 'order.x', source: 'github', data: {} } }),
    ).rejects.toMatchObject({ code: 'P2002' });
    // audit_logs không bao giờ bị đụng bởi lô dọn
    expect(await owner.auditLog.count({ where: { tenantId: A } })).toBe(auditsBefore);
    // dọn lần nữa: event đã dọn không bị tính lại
    const again = await clean({ action: 'trim', importance: ['low'] });
    expect(again.events).toBe(0);
  });

  it('[QT:T16] "Xoá hẳn" mất chống trùng (đánh đổi có chủ đích): xoá rồi gửi lại cùng khoá -> được nhận lần nữa; delivery + attempt đi theo', async () => {
    const x = await ev({ days: 6, status: 'SUCCEEDED' });
    const r = await clean({ action: 'delete', importance: ['low'], cutoff: ago(5.5) });
    expect(r.events).toBeGreaterThanOrEqual(1);
    expect(await owner.event.findUnique({ where: { id: x.event.id } })).toBeNull();
    expect(await owner.rawEvent.findUnique({ where: { id: x.raw.id } })).toBeNull();
    expect(await owner.delivery.count({ where: { eventId: x.event.id } })).toBe(0);
    const again = await owner.rawEvent.create({
      data: { sourceId, idempotencyKey: x.key, headers: {}, body: {}, bodyRaw: Buffer.from('{}'), signatureValid: true, status: 'ACCEPTED' },
    });
    expect(again.id).not.toBe(x.raw.id);
  });

  it('[QT:T9] (phần c) KHÔNG đụng: delivery PENDING/RETRYING, dữ liệu trong cửa sổ retry (cutoff mới hơn sàn), source "Giữ lâu", mức không được nêu', async () => {
    const pending = await ev({ days: 10, status: 'PENDING' });
    const retrying = await ev({ days: 10, status: 'RETRYING' });
    const fresh = await ev({ days: 0.01, status: 'SUCCEEDED' }); // ~15 phút — trong cửa sổ retry
    const keep = await ev({ days: 10, status: 'SUCCEEDED', src: keepId });
    const dead = await ev({ days: 10, status: 'DEAD' });
    const medium = await ev({ days: 10, status: null });
    // cutoff = "bây giờ" (mới hơn sàn) — sàn vẫn thắng
    await clean({ action: 'delete', importance: ['low', 'medium', 'high'], cutoff: new Date() });
    for (const x of [pending, retrying, fresh, keep]) expect(await owner.event.findUnique({ where: { id: x.event.id } })).not.toBeNull();
    // mức nêu tên mới bị đụng (high/medium ở trên đã xoá DEAD + không delivery cũ)
    expect(await owner.event.findUnique({ where: { id: dead.event.id } })).toBeNull();
    expect(await owner.event.findUnique({ where: { id: medium.event.id } })).toBeNull();
  });

  it('[QT:T33] (phần b) byte giải phóng cộng vào freed_since_calibration CÙNG transaction, used_bytes giảm, nấc hạ NGAY (LOCKED -> dưới 90% mở khoá)', async () => {
    await ev({ days: 7, status: 'SUCCEEDED', kb: 200 });
    // quota 300KB, used 310KB -> LOCKED; dọn ~200KB -> ~110KB (< 90%) -> mở khoá
    await owner.projectUsage.update({ where: { tenantId: A }, data: { usedBytes: BigInt(310 * 1024), level: 'LOCKED', freedSinceCalibration: 0n } });
    const r = await clean({ action: 'trim', importance: ['low'], quotaBytes: 300 * 1024 });
    expect(r.freedBytes).toBeGreaterThan(190 * 1024);
    expect(r.level).toMatchObject({ from: 'LOCKED' });
    expect(['OK', 'WARN_70', 'WARN_85']).toContain(r.level!.to);
    const u = await owner.projectUsage.findUnique({ where: { tenantId: A } });
    expect(Number(u!.freedSinceCalibration)).toBe(r.freedBytes);
    expect(Number(u!.usedBytes)).toBe(310 * 1024 - r.freedBytes);
    expect(u!.level).toBe(r.level!.to);
  });

  it('mẫu REJECTED (junk) chỉ Xoá hẳn; source "Giữ lâu" giữ mẫu của nó', async () => {
    const mk = (src: string) =>
      owner.rawEvent.create({ data: { sourceId: src, idempotencyKey: `rj:${run}:${++n}`, headers: {}, body: {}, bodyRaw: Buffer.alloc(4096, 1), signatureValid: false, status: 'REJECTED', receivedAt: ago(2) } });
    const j = await mk(sourceId);
    const k = await mk(keepId);
    const r = await clean({ action: 'delete', importance: ['junk'], cutoff: ago(1) });
    expect(r.rejected).toBeGreaterThanOrEqual(1);
    expect(r.freedBytes).toBeGreaterThanOrEqual(4096);
    expect(await owner.rawEvent.findUnique({ where: { id: j.id } })).toBeNull();
    expect(await owner.rawEvent.findUnique({ where: { id: k.id } })).not.toBeNull();
  });

  it('[QT:T17] (phần b) mức quan trọng bằng SQL (by_bucket + lệnh dọn) khớp importanceOf thuần', async () => {
    const cases = [
      { status: 'SUCCEEDED' as const, src: sourceId, want: 'low' },
      { status: 'DEAD' as const, src: sourceId, want: 'high' },
      { status: null, src: sourceId, want: 'medium' },
      { status: 'SUCCEEDED' as const, src: keepId, want: 'keep' },
    ];
    for (const c of cases) {
      expect(importanceOf({ kind: 'event' }, c.status ? [{ status: c.status }] : [], { keepLonger: c.src === keepId })).toBe(c.want);
      await ev({ days: 20, status: c.status, src: c.src });
    }
    const buckets = await svc.forTenant(A).measureStorageBuckets();
    const old = buckets.filter((b) => b.ageDays >= 20);
    expect(new Set(old.map((b) => b.importance))).toEqual(new Set(['low', 'high', 'medium', 'keep']));
    expect(old.find((b) => b.importance === 'keep')!.sourceId).toBe(keepId);
  });

  it('[QT:T20] (phần b) polling trả event đã dọn với trimmed: true, data: null; event chưa dọn trimmed: false', async () => {
    const t = await ev({ days: 9, status: 'SUCCEEDED' });
    const keep = await ev({ days: 0.5, status: 'SUCCEEDED' });
    await clean({ action: 'trim', importance: ['low'] });
    const rows = await svc.forTenant(A).pollEvents({ after: 0n, limit: 100, readTypes: [] } as any);
    const a = rows.find((r) => r.id === t.event.id)!;
    const b = rows.find((r) => r.id === keep.event.id)!;
    expect(a).toMatchObject({ trimmed: true, data: null });
    expect(b).toMatchObject({ trimmed: false, data: { blob: expect.any(String) } });
  });

  it('nhận lệnh: hai worker song song nhận HAI lệnh khác nhau (SKIP LOCKED); lệnh hết lease được nhận lại; quá số lần -> FAILED', async () => {
    const repo = svc.forTenant(A);
    const mk = (id: string) => repo.createStorageCleanJob({ id, action: 'trim', importance: ['low'], olderThan: '3d', cutoff: ago(3), sourceId: null, origin: 'manual', requestedBy: 'u' });
    const j1 = randomUUID();
    const j2 = randomUUID();
    await mk(j1);
    await mk(j2);
    const svc2 = new PrismaService();
    try {
      const claims = await Promise.all([svc.storageClaimCleanJobAcrossTenants(60_000, 5), svc2.storageClaimCleanJobAcrossTenants(60_000, 5)]);
      const mine = claims.filter((c) => c && c.tenantId === A).map((c) => c!.id);
      // DB kiểm chứng dùng chung: có thể nhận lệnh của test khác, nhưng không bao giờ hai lần cùng một lệnh
      expect(new Set(mine).size).toBe(mine.length);
      await owner.storageCleanJob.updateMany({ where: { id: { in: [j1, j2] } }, data: { status: 'RUNNING', leaseUntil: ago(1), attempts: 5 } });
      await svc.storageClaimCleanJobAcrossTenants(60_000, 5);
      const after = await owner.storageCleanJob.findMany({ where: { id: { in: [j1, j2] } } });
      expect(after.every((j) => j.status === 'FAILED')).toBe(true);
    } finally {
      await svc2.$disconnect();
    }
  });
});
