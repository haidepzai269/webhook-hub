import { randomUUID } from 'crypto';
import { PrismaService, TenantScopedRepository } from '@hub/database';
import { describeDb, newTestPrisma } from '../../../libs/database/test/support/test-db';

/**
 * PK5 (SPEC-provider-khac §7.1 + E4/E5/E14, ADR-206) trên Postgres THẬT: cột của migration `20261014090000_unverified_sources`,
 * cờ project nạp CÙNG câu với source (escape hatch ingest), polling lọc `verified`, replay hàng loạt tôn trọng
 * `accept_unverified`, cảnh báo chữ ký không đếm nguồn unverified. Fixture bằng owner; repo (code đang test) bằng hub_app (RLS).
 */
describeDb('[PK5] nguồn unverified trên Postgres', () => {
  const raw = newTestPrisma('owner');
  const appDb = newTestPrisma('app');
  const svc = new PrismaService();
  const tenant = randomUUID();
  const run = randomUUID().slice(0, 8);
  const repo = () => new TenantScopedRepository(appDb, tenant);
  let sourceId = '';
  let sourceKey = '';
  let n = 0;
  const mkEvent = (verified: boolean) =>
    raw.event.create({
      data: { id: `ev_pk5_${run}_${++n}`, tenantId: tenant, idempotencyKey: `pk5:${run}:${n}`, correlationId: randomUUID(), type: 'momo.ipn', source: 'generic', sourceId, data: { n }, verified },
    });

  beforeAll(async () => {
    await raw.project.create({ data: { id: tenant, slug: `pk5-${run}`, name: 'pk5' } });
    sourceKey = `src_generic_pk5_${run}`;
    sourceId = (
      await raw.source.create({ data: { tenantId: tenant, provider: 'generic', name: 'momo', sourceKey, verificationConfig: { scheme: 'unverified', eventType: 'momo.ipn' } } })
    ).id;
  }, 60_000);

  afterAll(async () => {
    await raw.delivery.deleteMany({ where: { tenantId: tenant } });
    await raw.event.deleteMany({ where: { tenantId: tenant } });
    await raw.rawEvent.deleteMany({ where: { sourceId } });
    await raw.subscription.deleteMany({ where: { tenantId: tenant } });
    await raw.destination.deleteMany({ where: { tenantId: tenant } });
    await raw.source.deleteMany({ where: { tenantId: tenant } });
    await raw.project.deleteMany({ where: { id: tenant } });
    await raw.$disconnect();
    await appDb.$disconnect();
    await svc.$disconnect();
  });

  it('[PK:T14] (phần f) mặc định: project.allow_unverified_sources=false, raw/event.verified=true, subscription.accept_unverified=false; cờ project đi CÙNG câu nạp source của ingest', async () => {
    const p = await raw.project.findUniqueOrThrow({ where: { id: tenant } });
    expect(p.allowUnverifiedSources).toBe(false);
    expect((await svc.findSourceBySourceKeyForIngest(sourceKey))?.allowUnverified).toBe(false);
    await svc.setProjectAllowUnverified(tenant, true);
    expect((await svc.findSourceBySourceKeyForIngest(sourceKey))?.allowUnverified).toBe(true);
    const r = await raw.rawEvent.create({ data: { sourceId, idempotencyKey: `def-${run}`, headers: {}, body: {}, bodyRaw: Buffer.alloc(0), signatureValid: true } });
    expect(r.verified).toBe(true);
    expect((await mkEvent(true)).verified).toBe(true);
  });

  it('[PK:T36] (phần e) polling: key thường KHÔNG thấy event verified=false (cursor vẫn đi qua); includeUnverified thấy, kèm verified:false', async () => {
    const before = await repo().latestPollCursor();
    const v = await mkEvent(true);
    const u = await mkEvent(false);
    const plain = await repo().pollEvents({ after: before!, limit: 100 });
    expect(plain.map((e) => e.id)).toEqual([v.id]);
    expect(plain[0].verified).toBe(true);
    const all = await repo().pollEvents({ after: before!, limit: 100, includeUnverified: true });
    expect(all.map((e) => [e.id, e.verified])).toEqual([
      [v.id, true],
      [u.id, false],
    ]);
  });

  it('[PK:T36] (phần f) replay hàng loạt: DEAD của event chưa xác thực tới subscription TẮT accept_unverified bị loại (lý do riêng unverified_not_accepted — review PK5 T-7); bật thì vào tập', async () => {
    const dst = await raw.destination.create({ data: { tenantId: tenant, name: 'shop', type: 'webhook', configEncrypted: 'x', verification: 'VERIFIED' } as any });
    const subOff = await raw.subscription.create({ data: { tenantId: tenant, destinationId: dst.id, name: 'off', eventTypes: ['*'] } });
    const subOn = await raw.subscription.create({ data: { tenantId: tenant, destinationId: dst.id, name: 'on', eventTypes: ['*'], acceptUnverified: true } });
    const ev = await mkEvent(false);
    const dOff = await raw.delivery.create({ data: { tenantId: tenant, eventId: ev.id, subscriptionId: subOff.id, status: 'DEAD' } });
    const dOn = await raw.delivery.create({ data: { tenantId: tenant, eventId: ev.id, subscriptionId: subOn.id, status: 'DEAD' } });
    const refs = await repo().findDeadDeliveryRefs({ ids: [dOff.id, dOn.id], replayableOnly: true }, 100);
    expect(refs.map((r) => r.id)).toEqual([dOn.id]);
    expect(await repo().findReplaySkipReasons([dOff.id])).toEqual([{ id: dOff.id, reason: 'unverified_not_accepted' }]);
  });

  it('[PK:T37] (phần c) cảnh báo source.signature_failing: 20 raw ACCEPTED verified=false (signature_valid=true) -> invalid = 0', async () => {
    for (let i = 0; i < 20; i++) {
      await raw.rawEvent.create({ data: { sourceId, idempotencyKey: `unv-${run}-${i}`, headers: { __hub_meta: { method: 'POST' } }, body: {}, bodyRaw: Buffer.from('{}'), signatureValid: true, verified: false } });
    }
    const rows = await repo().countSignatureBySource(new Date(Date.now() - 3600_000));
    const mine = rows.find((r) => r.sourceId === sourceId)!;
    expect(mine.requests).toBeGreaterThanOrEqual(20);
    expect(mine.invalid).toBe(0);
  });
});
