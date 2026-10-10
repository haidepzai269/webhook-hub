import { aesGcmDecrypt } from '@hub/crypto';
import { DEMO_PROJECTS, disconnectSeedClient, seedDemoProjects } from '../src/seed';
import { getMasterKey } from '../src/constants';
import { describeDb, newTestPrisma } from './support/test-db';

/** S12 (X5, ADR-082) trên Postgres THẬT: seed demo cafe/bookstore idempotent, đúng một bộ tài nguyên mỗi project. */
describeDb('seedDemoProjects (S12)', () => {
  const raw = newTestPrisma('owner');
  const env = { ...process.env, DEMO_ENDPOINT_BASE_URL: 'http://sink:4100', SEED_DEMO_PROJECTS: 'true' };

  afterAll(async () => {
    await raw.$disconnect();
    await disconnectSeedClient();
  });

  it('[MS:T14] (phần a) chạy 2 lần -> lần 2 không tạo gì; mỗi project: 1 source mock + 1 source api gắn key, 1 key đủ scope (chỉ hash), 1 endpoint VERIFIED, 1 subscription payment.*', async () => {
    await seedDemoProjects(env);
    expect(await seedDemoProjects(env)).toEqual([]);
    for (const p of DEMO_PROJECTS) {
      const project = await raw.project.findUnique({ where: { slug: p.slug } });
      expect(project).toMatchObject({ environment: p.environment });
      const t = project!.id;
      // Project demo dùng chung (script demo thêm key/endpoint/source) -> kiểm ĐÚNG tài nguyên seed tạo, theo tên.
      const keys = await raw.apiKey.findMany({ where: { tenantId: t, serviceName: `${p.slug}-be` } });
      expect(keys).toHaveLength(1);
      expect(keys[0]).toMatchObject({ scopes: ['publish:events', 'read:events', 'manage:endpoints', 'manage:sources'], revokedAt: null });
      expect(keys[0].keyHash).toMatch(/^[0-9a-f]{64}$/);
      expect(keys[0].keyPrefix.startsWith(`hk_${p.environment}_`)).toBe(true);
      // source `api` gắn với key (publish:events, S4) + đúng 1 source thanh toán mock theo sourceKey
      const apiSrc = await raw.source.findUnique({ where: { id: keys[0].sourceId! } });
      expect(apiSrc).toMatchObject({ tenantId: t, provider: 'api', sourceKey: `api_${keys[0].id}` });
      expect(await raw.source.count({ where: { tenantId: t, sourceKey: p.sourceKey, provider: p.provider } })).toBe(1);
      const dests = await raw.destination.findMany({ where: { tenantId: t, name: `${p.slug}-endpoint` } });
      expect(dests).toHaveLength(1);
      expect(dests[0].verification).toBe('VERIFIED');
      // Endpoint tạo lúc project ra đời -> base URL lúc đó (sink hubv hoặc /mock/echo). Chỉ kiểm hậu tố.
      expect(JSON.parse(aesGcmDecrypt(dests[0].configEncrypted, getMasterKey())).url).toMatch(new RegExp(`/${p.slug}$`));
      expect(aesGcmDecrypt(dests[0].signingSecretEncrypted!, getMasterKey())).toMatch(/^whsec_/);
      const subs = await raw.subscription.findMany({ where: { tenantId: t, destinationId: dests[0].id } });
      expect(subs.map((x) => x.eventTypes)).toEqual([['payment.*']]);
    }
  });
});
