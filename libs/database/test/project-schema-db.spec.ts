import { randomUUID } from 'crypto';
import { DEFAULT_TENANT_ID } from '../src/constants';
import { PrismaService } from '../src/prisma.service';
import { TenantScopedRepository } from '../src/tenant-scoped.repository';
import { describeDb, newTestPrisma } from './support/test-db';

/**
 * S1 (SPEC §4.1) trên Postgres THẬT: khoá ngoại ghép là LƯỚI CUỐI chống subscription trỏ sang đích của
 * project khác (kể cả khi code quên kiểm), `events.seq` tăng dần, project default có sẵn, api_keys không lộ hash.
 */
describeDb('S1 schema đa service (Postgres)', () => {
  const raw = newTestPrisma();
  const prismaSvc = PrismaService.getInstance();
  const tA = randomUUID();
  const tB = randomUUID();
  const run = randomUUID().slice(0, 8);
  let destB = '';

  beforeAll(async () => {
    await raw.project.createMany({
      data: [
        { id: tA, slug: `s1a-${run}`, name: 'A' },
        { id: tB, slug: `s1b-${run}`, name: 'B', environment: 'live' },
      ],
    });
    destB = (await raw.destination.create({ data: { tenantId: tB, name: `b-${run}`, type: 'webhook', configEncrypted: 'x' } })).id;
  }, 60_000);

  afterAll(async () => {
    await raw.subscription.deleteMany({ where: { tenantId: { in: [tA, tB] } } });
    await raw.destination.deleteMany({ where: { tenantId: { in: [tA, tB] } } });
    await raw.event.deleteMany({ where: { tenantId: { in: [tA, tB] } } });
    await raw.project.deleteMany({ where: { id: { in: [tA, tB] } } }); // cascade api_keys
    await raw.$disconnect();
    await prismaSvc.$disconnect();
  });

  it('[BB:5] khoá ngoại ghép: subscription của project A trỏ đích project B -> DB từ chối (P2003)', async () => {
    await expect(
      raw.subscription.create({ data: { tenantId: tA, destinationId: destB, name: 'lach', eventTypes: ['order.*'] } }),
    ).rejects.toMatchObject({ code: 'P2003' });
    // cùng project thì được, sourceIds mặc định rỗng
    const ok = await raw.subscription.create({ data: { tenantId: tB, destinationId: destB, name: 'ok', eventTypes: ['order.*'] } });
    expect(ok.sourceIds).toEqual([]);
  });

  it('khoá ngoại ghép giữ RESTRICT (ADR-054): đích còn subscription thì không xoá được', async () => {
    await expect(raw.destination.delete({ where: { id: destB } })).rejects.toMatchObject({ code: 'P2003' });
  });

  it('events.seq tăng theo thứ tự INSERT; destination mới mặc định VERIFIED', async () => {
    const mk = (i: number) =>
      raw.event.create({
        data: { id: `evt_s1_${run}_${i}`, tenantId: tA, idempotencyKey: `s1-${run}-${i}`, correlationId: randomUUID(), type: 'order.created', source: 'api', data: {} },
      });
    const a = await mk(1);
    const b = await mk(2);
    expect(typeof a.seq).toBe('bigint');
    expect(b.seq > a.seq).toBe(true);
    const d = await raw.destination.findUniqueOrThrow({ where: { id: destB } });
    expect(d.verification).toBe('VERIFIED');
  });

  it('project default (= DEFAULT_TENANT_ID) tồn tại sau migration', async () => {
    const p = await prismaSvc.findProjectById(DEFAULT_TENANT_ID);
    expect(p?.slug).toBe('default');
  });

  it('api_keys: findApiKeyByHash kèm project; findApiKeys KHÔNG trả keyHash; repo project khác không thấy', async () => {
    const hash = randomUUID().replace(/-/g, '').padEnd(64, '0');
    await new TenantScopedRepository(raw, tB).createApiKey({ serviceName: 'svc', keyPrefix: 'hk_live_abcd', keyHash: hash, scopes: ['read:events'] });
    const found = await prismaSvc.findApiKeyByHash(hash);
    expect(found?.project.slug).toBe(`s1b-${run}`);
    const list = await new TenantScopedRepository(raw, tB).findApiKeys();
    expect(list).toHaveLength(1);
    expect(list[0]).not.toHaveProperty('keyHash');
    expect(await new TenantScopedRepository(raw, tA).findApiKeys()).toEqual([]);
  });

  it('MS-R6: api_keys.scopes NOT NULL (dữ liệu tay NULL làm key.scopes.includes ném 500) — DB từ chối, mặc định mảng rỗng', async () => {
    await expect(
      raw.$executeRawUnsafe(`INSERT INTO hub.api_keys (id, tenant_id, service_name, key_hash, key_prefix, scopes) VALUES (gen_random_uuid(), '${tA}', 'x', md5(random()::text) || md5(random()::text), 'hk_test_xxxx', NULL)`),
    ).rejects.toThrow(/23502/); // not_null_violation
    const r: any[] = await raw.$queryRawUnsafe(`SELECT column_default FROM information_schema.columns WHERE table_schema='hub' AND table_name='api_keys' AND column_name='scopes'`);
    expect(String(r[0].column_default)).toMatch(/ARRAY\[\]/);
  });
});
