import { randomUUID } from 'crypto';
import { HttpException } from '@nestjs/common';
import { PrismaService, getMasterKey } from '@hub/database';
import { aesGcmDecrypt } from '@hub/crypto';
import { ConsoleEndpointsController } from '../src/modules/console/endpoints.controller';
import { redactSecrets } from '../src/modules/api/redact-secrets.interceptor';
import { describeDb, newTestPrisma } from '../../../libs/database/test/support/test-db';

/**
 * KN1 (SPEC-ket-noi §3, §8.1) trên Postgres THẬT, code chạy bằng role của DATABASE_URL (hub_app — RLS), fixture bằng
 * owner. Challenge là verifier giả (không gọi mạng) — thứ cần chứng minh ở đây là transaction, không phải HTTP.
 */
describeDb('[KN1] console tạo endpoint: whsec_ một lần, endpoint + subscription cùng tx, challenge ngoài tx (Postgres)', () => {
  const raw = newTestPrisma('owner');
  const svc = new PrismaService();
  const tenant = randomUUID();
  const other = randomUUID();
  const userId = randomUUID();
  let hang: ((url: string) => Promise<void>) | null = null;
  const verifier: any = {
    challenge: jest.fn(async (url: string) => {
      if (hang) await hang(url);
      return { verification: 'VERIFIED', verificationError: null };
    }),
  };
  const controller = new ConsoleEndpointsController(svc, verifier);
  let otherSourceId = '';
  let ownSourceId = '';

  const counts = async () => ({
    destinations: await raw.destination.count({ where: { tenantId: tenant } }),
    subscriptions: await raw.subscription.count({ where: { tenantId: tenant } }),
    audits: await raw.auditLog.count({ where: { tenantId: tenant } }),
  });
  const errOf = async (p: Promise<unknown>) => {
    const e = await p.then(() => null, (x) => x);
    expect(e).toBeInstanceOf(HttpException);
    return { status: (e as HttpException).getStatus(), body: JSON.stringify((e as HttpException).getResponse()) };
  };

  beforeAll(async () => {
    const run = randomUUID().slice(0, 8);
    ownSourceId = (await raw.source.create({ data: { tenantId: tenant, provider: 'sepay', name: 'own', sourceKey: `src_kn1_own_${run}` } })).id;
    otherSourceId = (await raw.source.create({ data: { tenantId: other, provider: 'sepay', name: 'other', sourceKey: `src_kn1_other_${run}` } })).id;
  }, 60_000);

  afterAll(async () => {
    for (const t of [tenant, other]) {
      await raw.auditLog.deleteMany({ where: { tenantId: t } });
      await raw.subscription.deleteMany({ where: { tenantId: t } });
      await raw.destination.deleteMany({ where: { tenantId: t } });
      await raw.source.deleteMany({ where: { tenantId: t } });
    }
    await raw.$disconnect();
    await svc.$disconnect();
  });

  it('[KN:U1] không gửi signingSecret -> response có whsec_ đúng một lần; GET chi tiết sau đó không có secret (cả ciphertext)', async () => {
    const r: any = await controller.create(tenant, userId, { name: 'shop', url: 'https://shop.example.com/webhooks', eventTypes: ['payment.*'], sourceIds: [ownSourceId] });
    expect(r.signingSecret).toMatch(/^whsec_[A-Za-z0-9+/=]{20,}$/);
    expect(r).toMatchObject({ verification: 'VERIFIED', verificationFix: null, endpoint: { verification: 'VERIFIED', url: 'https://shop.example.com/webhooks' } });
    expect(r.subscription).toMatchObject({ endpointId: r.endpoint.id, eventTypes: ['payment.*'], sourceIds: [ownSourceId] });
    // Secret lưu MÃ HOÁ, đúng giá trị đã trả, và challenge được ký bằng chính nó.
    const row = await raw.destination.findUniqueOrThrow({ where: { id: r.endpoint.id } });
    expect(aesGcmDecrypt(row.signingSecretEncrypted!, getMasterKey())).toBe(r.signingSecret);
    expect(verifier.challenge).toHaveBeenLastCalledWith('https://shop.example.com/webhooks', r.signingSecret);
    const detail = JSON.stringify(redactSecrets(await controller.detail(tenant, r.endpoint.id)));
    expect(detail).not.toContain(r.signingSecret);
    expect(detail).not.toContain(row.signingSecretEncrypted!);
    expect(detail).not.toMatch(/signingSecret"/);
    // Secret do dev tự đưa -> response KHÔNG lặp lại nó.
    const own: any = await controller.create(tenant, userId, { name: 'own', url: 'https://own.example.com/h', eventTypes: ['order.*'], signingSecret: 'my-own-secret-0123456789' });
    expect(own.signingSecret).toBeUndefined();
    // Audit: không chứa secret, actor = user:<id>.
    const audits = await raw.auditLog.findMany({ where: { tenantId: tenant } });
    expect(audits.map((a) => a.actor)).toEqual(expect.arrayContaining([`user:${userId}`]));
    expect(JSON.stringify(audits.map((a) => [a.action, a.metadata]))).not.toContain(r.signingSecret);
  });

  it('[KN:U2] subscription lỗi (sourceId lạ) -> rollback cả endpoint: không endpoint mồ côi, không audit, không gọi challenge', async () => {
    const before = await counts();
    const calls = verifier.challenge.mock.calls.length;
    const e = await errOf(controller.create(tenant, userId, { name: 'orphan?', url: 'https://x.example.com/h', eventTypes: ['payment.*'], sourceIds: [randomUUID()] }));
    expect(e.status).toBe(404);
    expect(await counts()).toEqual(before);
    expect(verifier.challenge.mock.calls.length).toBe(calls);
  });

  it('[KN:U3] sourceIds của project khác -> 404 GIỐNG HỆT byte với id không tồn tại (và id sai khuôn)', async () => {
    const foreign = await errOf(controller.create(tenant, userId, { name: 'a', url: 'https://a.example.com/h', eventTypes: ['payment.*'], sourceIds: [otherSourceId] }));
    const missing = await errOf(controller.create(tenant, userId, { name: 'a', url: 'https://a.example.com/h', eventTypes: ['payment.*'], sourceIds: [randomUUID()] }));
    const garbage = await errOf(controller.create(tenant, userId, { name: 'a', url: 'https://a.example.com/h', eventTypes: ['payment.*'], sourceIds: ["x' or 1=1"] }));
    expect(foreign).toEqual({ status: 404, body: expect.any(String) });
    expect(missing).toEqual(foreign);
    expect(garbage).toEqual(foreign);
    expect(foreign.body).not.toContain(otherSourceId);
    // Endpoint của project khác cũng 404 giống hệt id lạ.
    const own: any = await controller.create(tenant, userId, { name: 'iso', url: 'https://iso.example.com/h', eventTypes: ['payment.*'] });
    const cross = await errOf(controller.detail(other, own.endpoint.id));
    const none = await errOf(controller.detail(other, randomUUID()));
    expect(cross).toEqual(none);
  });

  it('[KN:U4] challenge chạy NGOÀI tx: trong lúc challenge treo 3s, kết nối khác đã THẤY endpoint + subscription + audit (tx đã COMMIT, không giữ kết nối)', async () => {
    let seenDuring: any = null;
    hang = async () => {
      // Kết nối KHÁC (owner): chỉ thấy dòng đã COMMIT. Còn trong tx (giữ kết nối pool) thì không thấy gì.
      const d = await raw.destination.findFirst({ where: { tenantId: tenant, name: 'slow' } });
      seenDuring = {
        destination: d?.verification ?? null,
        subscriptions: d ? await raw.subscription.count({ where: { destinationId: d.id } }) : 0,
        audit: d ? await raw.auditLog.count({ where: { entityId: d.id, action: 'endpoint.create' } }) : 0,
      };
      await new Promise((r) => setTimeout(r, 3_000));
    };
    try {
      const r: any = await controller.create(tenant, userId, { name: 'slow', url: 'https://slow.example.com/h', eventTypes: ['payment.*'] });
      expect(r.verification).toBe('VERIFIED');
    } finally {
      hang = null;
    }
    expect(seenDuring).toEqual({ destination: 'PENDING', subscriptions: 1, audit: 1 });
  }, 30_000);

  it('[KN1] verify lại + xoay secret: console-owned -> whsec_ mới (một lần, lưu mã hoá, audit không có secret); endpoint của service -> 409', async () => {
    const r: any = await controller.create(tenant, userId, { name: 'rot', url: 'https://rot.example.com/h', eventTypes: ['payment.*'] });
    const v: any = await controller.verify(tenant, userId, r.endpoint.id);
    expect(v).toEqual({ verification: 'VERIFIED', verificationError: null, verificationFix: null });
    const rot: any = await controller.rotateSecret(tenant, userId, r.endpoint.id);
    expect(rot.signingSecret).toMatch(/^whsec_/);
    expect(rot.signingSecret).not.toBe(r.signingSecret);
    const row = await raw.destination.findUniqueOrThrow({ where: { id: r.endpoint.id } });
    expect(aesGcmDecrypt(row.signingSecretEncrypted!, getMasterKey())).toBe(rot.signingSecret);
    expect(row.verification).toBe('VERIFIED'); // không challenge lại bằng secret service chưa biết
    const a = await raw.auditLog.findFirstOrThrow({ where: { entityId: r.endpoint.id, action: 'endpoint.secret_rotated' } });
    expect(JSON.stringify(a.metadata)).not.toContain(rot.signingSecret);
    const svcOwned = await raw.destination.create({ data: { tenantId: tenant, name: 'svc', type: 'webhook', configEncrypted: 'x', createdByKeyId: randomUUID() } });
    expect((await errOf(controller.rotateSecret(tenant, userId, svcOwned.id))).status).toBe(409);
  });
});
