import { randomUUID } from 'crypto';
import { ConflictException } from '@nestjs/common';
import { PrismaService } from '@hub/database';
import { ApiController } from '../src/modules/api/api.controller';
import { describeDb, newTestPrisma } from '../../../libs/database/test/support/test-db';

/**
 * Review SPEC-2 #1 trên Postgres THẬT (RUN_DB_TESTS=1, ADR-054): xoá subscription/destination còn
 * lịch sử -> 409 và KHÔNG mất dòng nào; FK RESTRICT chặn cả khi xoá thẳng ngoài API.
 */

describeDb('DELETE subscription/destination giữ lịch sử gửi (Postgres, ADR-054)', () => {
  const raw = newTestPrisma('owner');
  const svc = new PrismaService();
  const controller = new ApiController(svc);
  const tenant = randomUUID();
  const runId = randomUUID().slice(0, 8);
  let destId = '';
  let subId = '';
  let deliveryId = '';

  const counts = async () => ({
    subscriptions: await raw.subscription.count({ where: { tenantId: tenant } }),
    destinations: await raw.destination.count({ where: { tenantId: tenant } }),
    deliveries: await raw.delivery.count({ where: { tenantId: tenant } }),
    attempts: await raw.deliveryAttempt.count({ where: { delivery: { tenantId: tenant } } }),
  });

  beforeAll(async () => {
    destId = (await raw.destination.create({ data: { tenantId: tenant, name: `del-${runId}`, type: 'webhook', configEncrypted: 'x' } })).id;
    subId = (await raw.subscription.create({ data: { tenantId: tenant, destinationId: destId, name: `del-${runId}`, eventTypes: ['t.del'] } })).id;
    const evt = await raw.event.create({
      data: { id: `DEL${runId}`, tenantId: tenant, idempotencyKey: `del:${runId}`, correlationId: randomUUID(), type: 't.del', source: 'test', data: {} },
    });
    deliveryId = (await raw.delivery.create({ data: { tenantId: tenant, eventId: evt.id, subscriptionId: subId, status: 'DEAD', attemptCount: 1 } })).id;
    await raw.deliveryAttempt.create({ data: { deliveryId, attemptNo: 1, responseStatus: 404, error: 'Non-retryable HTTP 404' } });
  }, 60_000);

  afterAll(async () => {
    await raw.auditLog.deleteMany({ where: { tenantId: tenant } });
    await raw.delivery.deleteMany({ where: { tenantId: tenant } });
    await raw.event.deleteMany({ where: { tenantId: tenant } });
    await raw.subscription.deleteMany({ where: { tenantId: tenant } });
    await raw.destination.deleteMany({ where: { tenantId: tenant } });
    await raw.$disconnect();
    await svc.$disconnect();
  });

  it('API: DELETE subscription có delivery DEAD -> 409 deliveryCount=1; không mất delivery/attempt; không audit', async () => {
    const before = await counts();
    const err = await controller.deleteSubscription(tenant, 'tester', subId).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toMatchObject({ deliveryCount: 1 });
    expect(await counts()).toEqual(before);
    expect(await raw.auditLog.count({ where: { tenantId: tenant, action: 'subscription.delete' } })).toBe(0);
  });

  it('API: DELETE destination còn subscription -> 409; không mất gì', async () => {
    const before = await counts();
    const err = await controller.deleteDestination(tenant, 'tester', destId).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toMatchObject({ subscriptionCount: 1, deliveryCount: 1 });
    expect(await counts()).toEqual(before);
  });

  it('DB: xoá thẳng ngoài API cũng bị FK RESTRICT chặn (P2003), lịch sử còn nguyên', async () => {
    const before = await counts();
    await expect(raw.subscription.delete({ where: { id: subId } })).rejects.toMatchObject({ code: 'P2003' });
    await expect(raw.destination.delete({ where: { id: destId } })).rejects.toMatchObject({ code: 'P2003' });
    expect(await counts()).toEqual(before);
  });

  it('tắt subscription (isActive=false) là đường đúng: lịch sử còn, subscription còn', async () => {
    await controller.updateSubscription(tenant, 'tester', subId, { isActive: false, reason: 'ngừng gửi' });
    expect((await raw.subscription.findUnique({ where: { id: subId } }))?.isActive).toBe(false);
    expect(await raw.delivery.count({ where: { id: deliveryId } })).toBe(1);
  });

  it('khi không còn delivery -> xoá subscription rồi destination được, có audit', async () => {
    await raw.delivery.deleteMany({ where: { tenantId: tenant } });
    await expect(controller.deleteSubscription(tenant, 'tester', subId)).resolves.toEqual({ deleted: true, id: subId });
    await expect(controller.deleteDestination(tenant, 'tester', destId)).resolves.toEqual({ deleted: true, id: destId });
    expect(await raw.auditLog.count({ where: { tenantId: tenant, action: { in: ['subscription.delete', 'destination.delete'] } } })).toBe(2);
  });
});
