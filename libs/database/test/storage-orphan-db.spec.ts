import { randomUUID } from 'crypto';
import { RuleAdvisor, TRIM_FREE_RATIO, guardSuggestions, levelFor, parseOlderThan } from '@hub/common';
import { PrismaService } from '../src/prisma.service';
import { describeDb, newTestPrisma } from './support/test-db';

/**
 * Review QT-S2 H1 (bổ sung ADR-184) trên Postgres THẬT (repo chạy bằng hub_app -> RLS): raw ACCEPTED MỒ CÔI (event đã bị
 * retention xoá, raw giữ theo ADR-045) được `measureStorage` đếm thì PHẢI nằm trong `by_bucket` và lệnh dọn với tới được.
 * Project LOCKED chỉ có raw mồ côi -> gợi ý `rules@1` -> dọn theo gợi ý -> xuống < 90% (mở khoá), khoá chống trùng còn.
 */
describeDb('QT4: raw ACCEPTED mồ côi dọn được (Postgres)', () => {
  const owner = newTestPrisma('owner');
  const svc = new PrismaService();
  const A = randomUUID();
  const run = randomUUID().slice(0, 8);
  const DAY = 86_400_000;
  const KB = 1024;
  const ago = (d: number) => new Date(Date.now() - d * DAY);
  const FLOOR = new Date(Date.now() - 3 * 3_600_000);
  let sourceId = '';
  let keepId = '';
  let n = 0;

  beforeAll(async () => {
    await owner.project.create({ data: { id: A, slug: `qto-${run}`, name: 'qto' } });
    sourceId = (await owner.source.create({ data: { tenantId: A, provider: 'github', name: 'qto', sourceKey: `qto_${run}` } })).id;
    keepId = (await owner.source.create({ data: { tenantId: A, provider: 'payos', name: 'qtok', sourceKey: `qtok_${run}`, keepLonger: true } })).id;
  }, 60_000);

  afterAll(async () => {
    await owner.rawEvent.deleteMany({ where: { source: { tenantId: A } } });
    await owner.projectUsage.deleteMany({ where: { tenantId: A } });
    await owner.auditLog.deleteMany({ where: { tenantId: A } });
    await owner.source.deleteMany({ where: { tenantId: A } });
    await owner.project.deleteMany({ where: { id: A } });
    await owner.$disconnect();
    await svc.$disconnect();
  });

  /** raw ACCEPTED KHÔNG có event (mồ côi). */
  const orphan = (o: { days: number; kb: number; src?: string }) =>
    owner.rawEvent.create({
      data: { sourceId: o.src ?? sourceId, idempotencyKey: `qto:${run}:${++n}`, headers: { h: 'x' }, body: { a: 1 }, bodyRaw: Buffer.alloc(o.kb * KB, 97), signatureValid: true, status: 'ACCEPTED', receivedAt: ago(o.days) },
    });

  it('[QT:T33] (phần f) LOCKED chỉ có raw mồ côi: by_bucket đếm chúng (Thấp; ứng viên renormalize = Cao; Giữ lâu = Giữ) -> dọn theo gợi ý -> < 90%, khoá chống trùng còn', async () => {
    const old1 = await orphan({ days: 10, kb: 300 }); // event đã bị retention 7 ngày xoá -> Thấp
    const old2 = await orphan({ days: 9, kb: 300 });
    const recent = await orphan({ days: 2, kb: 20 }); // chưa normalize xong, còn trong hạn -> ứng viên renormalize (ADR-045) -> Cao
    const keep = await orphan({ days: 10, kb: 50, src: keepId });

    const repo = svc.forTenant(A);
    const m = await repo.measureStorage();
    const buckets = await repo.measureStorageBuckets();
    // mọi byte measureStorage đếm đều nằm trong một ô by_bucket (không còn phần "đếm được nhưng không dọn được")
    expect(buckets.reduce((s, b) => s + b.bytes, 0)).toBe(m.totalBytes);
    const by = (imp: string) => buckets.filter((b) => b.importance === imp).reduce((s, b) => s + b.bytes, 0);
    expect(by('low')).toBe(600 * KB);
    expect(by('high')).toBe(20 * KB);
    expect(by('keep')).toBe(50 * KB);

    // quota sao cho đang LOCKED (≥ 100%)
    const quotaBytes = 640 * KB; // < 670KB đang dùng
    expect(levelFor(m.totalBytes, quotaBytes)).toBe('LOCKED');
    await owner.projectUsage.create({ data: { tenantId: A, usedBytes: BigInt(m.totalBytes), calibratedAt: new Date(), level: 'LOCKED' } });

    // gợi ý rules@1 trên by_bucket thật + hàng rào an toàn -> chọn gợi ý mức Thấp
    const now = Date.now();
    const raw = await new RuleAdvisor(() => now).suggest({
      usedBytes: m.totalBytes, quotaBytes, level: 'LOCKED', growthPerDay: 0, buckets: buckets as any, policies: [], keepLongerSourceIds: [keepId],
    });
    const { accepted } = guardSuggestions(raw, { buckets: buckets as any, keepLongerSourceIds: [keepId], floorMs: 3 * 3_600_000, now });
    const low = accepted.find((s) => s.importance.includes('low'))!;
    // Review QT-S2 R2 F1: "Dọn" ước ~90% (TRIM_FREE_RATIO, estimateClean) — số đo thật (freedBytes dưới) là 100% body_raw.
    expect(low).toMatchObject({ action: 'trim', estimatedBytes: Math.round(600 * KB * TRIM_FREE_RATIO), estimatedEvents: 2 });

    const r = await repo.cleanStorageBatch({
      action: low.action, importance: low.importance as string[], cutoff: parseOlderThan(low.olderThan, now)!.cutoff, floor: FLOOR, sourceId: low.sourceId, limit: 1000, quotaBytes,
    });
    expect(r.events).toBe(2);
    expect(r.freedBytes).toBe(600 * KB);
    expect(r.level).toMatchObject({ from: 'LOCKED' });
    expect(['OK', 'WARN_70', 'WARN_85']).toContain(r.level!.to);
    expect(r.level!.usedBytes / quotaBytes).toBeLessThan(0.9);

    // "Dọn" giữ dòng: body rỗng, trimmed_at có -> gửi lại cùng khoá vẫn bị Postgres chặn (BB-2)
    for (const x of [old1, old2]) {
      const row = await owner.rawEvent.findUnique({ where: { id: x.id } });
      expect(Buffer.from(row!.bodyRaw).length).toBe(0);
      expect(row!.trimmedAt).toBeInstanceOf(Date);
    }
    await expect(
      owner.rawEvent.create({ data: { sourceId, idempotencyKey: old1.idempotencyKey, headers: {}, body: {}, bodyRaw: Buffer.from('{}'), signatureValid: true, status: 'ACCEPTED' } }),
    ).rejects.toMatchObject({ code: 'P2002' });
    // ứng viên renormalize (Cao) và source Giữ lâu không bị đụng
    expect(Buffer.from((await owner.rawEvent.findUnique({ where: { id: recent.id } }))!.bodyRaw).length).toBe(20 * KB);
    expect(Buffer.from((await owner.rawEvent.findUnique({ where: { id: keep.id } }))!.bodyRaw).length).toBe(50 * KB);
    // đã dọn -> rời by_bucket, lần dọn sau không tính lại
    expect((await repo.measureStorageBuckets()).filter((b) => b.importance === 'low')).toHaveLength(0);
    expect((await repo.cleanStorageBatch({ action: 'trim', importance: ['low'], cutoff: ago(3), floor: FLOOR, limit: 1000, quotaBytes })).events).toBe(0);
  });

  it('[QT:T33] (phần g) review R2 N1: raw mồ côi mức Cao đã "Dọn" KHÔNG còn là ứng viên chuẩn hoá lại (findOrphanRawEvents = 0) — không banner, không normalize.backlog, Chuẩn hoá lại không bắn body rỗng', async () => {
    const repo = svc.forTenant(A);
    const cand = await orphan({ days: 1, kb: 5 }); // còn trong hạn, chưa normalize -> ứng viên renormalize (Cao)
    const before = await repo.findOrphanRawEvents({ limit: 100, ids: [cand.id], olderThanSeconds: 60 });
    expect(before.total).toBe(1);
    const r = await repo.cleanStorageBatch({ action: 'trim', importance: ['high'], cutoff: ago(0.5), floor: FLOOR, limit: 1000, quotaBytes: 50 * 1024 * 1024 });
    expect(r.events).toBeGreaterThanOrEqual(1);
    expect((await owner.rawEvent.findUnique({ where: { id: cand.id } }))!.trimmedAt).toBeInstanceOf(Date);
    const after = await repo.findOrphanRawEvents({ limit: 100, ids: [cand.id], olderThanSeconds: 60 });
    expect(after.total).toBe(0);
    expect(after.items ?? []).toEqual([]);
  });

  it('raw mồ côi: "Xoá hẳn" xoá dòng; ứng viên renormalize chỉ dọn khi nêu mức Cao; raw đã normalize ra 0 event (có processed_messages) = Thấp', async () => {
    const del = await orphan({ days: 8, kb: 10 });
    const zero = await orphan({ days: 1, kb: 10 }); // adapter cố ý ra 0 event -> không phải ứng viên renormalize
    await owner.processedMessage.create({ data: { consumer: 'normalize', messageId: zero.id } });
    const recent = await orphan({ days: 1, kb: 10 });
    const repo = svc.forTenant(A);
    const quotaBytes = 50 * 1024 * 1024;
    const r = await repo.cleanStorageBatch({ action: 'delete', importance: ['low'], cutoff: ago(0.5), floor: FLOOR, limit: 1000, quotaBytes });
    expect(r.events).toBeGreaterThanOrEqual(2);
    expect(await owner.rawEvent.findUnique({ where: { id: del.id } })).toBeNull();
    expect(await owner.rawEvent.findUnique({ where: { id: zero.id } })).toBeNull();
    expect(await owner.rawEvent.findUnique({ where: { id: recent.id } })).not.toBeNull();
    await repo.cleanStorageBatch({ action: 'delete', importance: ['high'], cutoff: ago(0.5), floor: FLOOR, limit: 1000, quotaBytes });
    expect(await owner.rawEvent.findUnique({ where: { id: recent.id } })).toBeNull();
    await owner.processedMessage.deleteMany({ where: { consumer: 'normalize', messageId: zero.id } });
  });
});
