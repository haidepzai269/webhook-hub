import { randomUUID } from 'crypto';
import { PrismaService } from '@hub/database';
import { FlowController } from '../src/modules/flow/flow.controller';
import { FlowService } from '../src/modules/flow/flow.service';
import { describeDb, newTestPrisma } from '../../../libs/database/test/support/test-db';

/**
 * SPEC-event-flow-ui F2/F4/F5 trên Postgres THẬT (RUN_DB_TESTS=1): hành trình dựng từ dòng DB thật,
 * cô lập tenant (tenant khác → 404 / không thấy), không lộ bí mật trong response.
 */
describeDb('flow API (Postgres, SPEC-event-flow-ui)', () => {
  const raw = newTestPrisma();
  const svc = new PrismaService();
  const flow = new FlowService(svc);
  const controller = new FlowController(flow);
  const tenant = randomUUID();
  const other = randomUUID();
  const run = randomUUID().slice(0, 8);
  const SECRET_MARKERS = ['SIGNING-SECRET-' + run, 'BOT-TOKEN-' + run, 'Bearer RAW-' + run];

  const ids = {
    source: '',
    rawOk: '',
    rawRejected: '',
    rawOrphan: '',
    event: `EVF${run}OK`.toUpperCase(),
    destOk: '',
    destFail: '',
    subOk: '',
    subFail: '',
    subOff: '',
    dOk: '',
    dFailG1: '',
    dFailG2: '',
  };

  beforeAll(async () => {
    const t0 = new Date(Date.now() - 10 * 60_000);
    const at = (ms: number) => new Date(t0.getTime() + ms);
    ids.source = (
      await raw.source.create({ data: { tenantId: tenant, provider: 'payos', name: `flow-${run}`, sourceKey: `src_flow_${run}` } })
    ).id;
    // secret của source nằm trong bảng con — không được phép xuất hiện
    await raw.sourceSecret.create({ data: { sourceId: ids.source, secretEncrypted: SECRET_MARKERS[0] } });
    ids.rawOk = (
      await raw.rawEvent.create({
        data: {
          sourceId: ids.source,
          idempotencyKey: `flow:${run}:ok`,
          headers: { 'content-type': 'application/json', authorization: '[REDACTED]' },
          body: { code: '00', data: { orderCode: 1 } },
          bodyRaw: Buffer.from('{"code":"00"}'),
          signatureValid: true,
          status: 'ACCEPTED',
          receivedAt: t0,
        },
      })
    ).id;
    ids.rawRejected = (
      await raw.rawEvent.create({
        data: {
          sourceId: ids.source,
          idempotencyKey: `rejected_${run}`,
          headers: { authorization: '[REDACTED]', __hub_meta: { bodyTruncated: false, originalBytes: 5 } },
          body: {},
          bodyRaw: Buffer.from('hello'),
          signatureValid: false,
          status: 'REJECTED',
          receivedAt: at(1000),
        },
      })
    ).id;
    ids.rawOrphan = (
      await raw.rawEvent.create({
        data: { sourceId: ids.source, idempotencyKey: `flow:${run}:orphan`, headers: {}, body: {}, bodyRaw: Buffer.from('{}'), signatureValid: true, receivedAt: at(2000) },
      })
    ).id;

    ids.destOk = (
      await raw.destination.create({ data: { tenantId: tenant, name: `Shop-${run}`, type: 'webhook', configEncrypted: SECRET_MARKERS[1], signingSecretEncrypted: SECRET_MARKERS[0] } })
    ).id;
    ids.destFail = (
      await raw.destination.create({ data: { tenantId: tenant, name: `Discord-${run}`, type: 'discord', configEncrypted: SECRET_MARKERS[1], circuitState: 'OPEN' } })
    ).id;
    ids.subOk = (await raw.subscription.create({ data: { tenantId: tenant, destinationId: ids.destOk, name: 'shop', eventTypes: ['payment.received'] } })).id;
    ids.subFail = (await raw.subscription.create({ data: { tenantId: tenant, destinationId: ids.destFail, name: 'discord', eventTypes: ['payment.*'] } })).id;
    ids.subOff = (
      await raw.subscription.create({ data: { tenantId: tenant, destinationId: ids.destFail, name: 'tắt', eventTypes: ['payment.*'], isActive: false } })
    ).id;

    await raw.event.create({
      data: {
        id: ids.event,
        tenantId: tenant,
        rawEventId: ids.rawOk,
        idempotencyKey: `evt:${run}`,
        correlationId: randomUUID(),
        type: 'payment.received',
        source: 'payos',
        subject: 'order/1',
        data: { amount: 1000 },
        receivedAt: at(40),
      },
    });
    ids.dOk = (
      await raw.delivery.create({
        data: { tenantId: tenant, eventId: ids.event, subscriptionId: ids.subOk, status: 'SUCCEEDED', attemptCount: 1, createdAt: at(45), updatedAt: at(140) },
      })
    ).id;
    await raw.deliveryAttempt.create({ data: { deliveryId: ids.dOk, attemptNo: 1, responseStatus: 200, durationMs: 84, responseBody: 'ok', createdAt: at(140) } });
    ids.dFailG1 = (
      await raw.delivery.create({
        data: { tenantId: tenant, eventId: ids.event, subscriptionId: ids.subFail, status: 'DEAD', attemptCount: 1, lastError: 'Non-retryable HTTP 404', createdAt: at(45) },
      })
    ).id;
    ids.dFailG2 = (
      await raw.delivery.create({
        data: {
          tenantId: tenant,
          eventId: ids.event,
          subscriptionId: ids.subFail,
          attemptGeneration: 2,
          status: 'RETRYING',
          attemptCount: 3,
          nextAttemptAt: new Date(Date.now() + 120_000),
          lastError: 'Lần 3 thất bại (500)',
          createdAt: at(5000),
        },
      })
    ).id;
    for (const n of [1, 2, 3]) {
      await raw.deliveryAttempt.create({ data: { deliveryId: ids.dFailG2, attemptNo: n, responseStatus: 500, durationMs: 12, responseBody: 'boom', createdAt: at(5000 + n * 1000) } });
    }
  }, 60_000);

  afterAll(async () => {
    await raw.delivery.deleteMany({ where: { tenantId: tenant } });
    await raw.event.deleteMany({ where: { tenantId: tenant } });
    await raw.subscription.deleteMany({ where: { tenantId: tenant } });
    await raw.destination.deleteMany({ where: { tenantId: tenant } });
    await raw.source.deleteMany({ where: { tenantId: tenant } }); // cascade raw_events + secrets
    await raw.$disconnect();
    await svc.$disconnect();
  });

  it('[UI:F2-01] event id → hành trình đủ chặng, nhánh theo generation mới nhất, lịch sử gập', async () => {
    const f: any = await controller.getEventFlow(tenant, ids.event);
    expect(f.stages.map((s: any) => `${s.key}=${s.status}`)).toEqual([
      'received=ok',
      'verified=ok',
      'persisted=ok',
      'normalized=ok',
      'routed=ok',
    ]);
    expect(f.branches).toHaveLength(2);
    const fail = f.branches.find((b: any) => b.destination.id === ids.destFail);
    expect(fail.deliveryId).toBe(ids.dFailG2);
    expect(fail.history.map((h: any) => h.deliveryId)).toEqual([ids.dFailG1]);
    expect(fail.stages.at(-1).reason.code).toBe('circuit_open'); // RETRYING + circuit OPEN = hoãn
    const routed = f.stages.find((s: any) => s.key === 'routed');
    expect(routed.detail.skipped.map((s: any) => s.id)).toEqual([ids.subOff]);
    expect(f.summary[5]).toMatchObject({ okCount: 1, total: 2 });
    expect(f.executionStatus).toBe('in_progress');
  });

  it('[UI:F2-02] raw_event id của event → cùng hành trình', async () => {
    const f: any = await controller.getEventFlow(tenant, ids.rawOk);
    expect(f.event.id).toBe(ids.event);
    expect(f.branches).toHaveLength(2);
  });

  it('[UI:F2-03] raw REJECTED → dừng ở verified, không có event; header meta tách riêng', async () => {
    const f: any = await controller.getEventFlow(tenant, ids.rawRejected);
    expect(f.event).toBeNull();
    expect(f.stages.map((s: any) => s.key)).toEqual(['received', 'verified']);
    expect(f.stages[1].reason.code).toBe('signature_invalid');
    expect(f.stages[0].detail.headers).toEqual({ authorization: '[REDACTED]' });
    expect(f.executionStatus).toBe('rejected');
  });

  it('[UI:F2-04] raw ACCEPTED mồ côi > 120s → normalized failed (normalize_dlq) + renormalize', async () => {
    const f: any = await controller.getEventFlow(tenant, ids.rawOrphan);
    const n = f.stages.find((s: any) => s.key === 'normalized');
    expect(n.status).toBe('failed');
    expect(n.actions).toContain('renormalize');
  });

  it('[UI:F2-05][BB:5] cô lập tenant: event/raw của tenant khác → 404', async () => {
    await expect(controller.getEventFlow(other, ids.event)).rejects.toThrow('Hành trình không tồn tại');
    await expect(controller.getEventFlow(other, ids.rawOk)).rejects.toThrow('Hành trình không tồn tại');
    await expect(controller.getEventFlow(other, ids.rawRejected)).rejects.toThrow('Hành trình không tồn tại');
    await expect(controller.getEventFlow(tenant, "x'; drop table--")).rejects.toThrow('Hành trình không tồn tại');
  });

  it('[UI:F2-06] che bí mật: không ciphertext, signingSecret, token hay authorization thô trong response', async () => {
    for (const id of [ids.event, ids.rawRejected]) {
      const text = JSON.stringify(await controller.getEventFlow(tenant, id));
      for (const m of SECRET_MARKERS) expect(text).not.toContain(m);
      expect(text).not.toMatch(/Encrypted|signingSecret|botToken|body_raw|bodyRaw/);
    }
  });
});
