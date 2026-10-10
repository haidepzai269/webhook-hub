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

  it('[UI:F2-05] (BB-5) cô lập tenant: event/raw của tenant khác → 404', async () => {
    await expect(controller.getEventFlow(other, ids.event)).rejects.toThrow('Hành trình không tồn tại');
    await expect(controller.getEventFlow(other, ids.rawOk)).rejects.toThrow('Hành trình không tồn tại');
    await expect(controller.getEventFlow(other, ids.rawRejected)).rejects.toThrow('Hành trình không tồn tại');
    await expect(controller.getEventFlow(tenant, "x'; drop table--")).rejects.toThrow('Hành trình không tồn tại');
  });

  it('[UI:F4-01] executions: mỗi hành trình một dòng, summary 6 chấm, "Hỏng ở" có đích + lần thử', async () => {
    const res: any = await controller.listExecutions(tenant, {});
    const byId = new Map(res.items.map((i: any) => [i.id, i]));
    expect(res.items).toHaveLength(3);
    const ok: any = byId.get(ids.event);
    expect(ok.status).toBe('in_progress');
    expect(ok.summary).toHaveLength(6);
    expect(ok.summary[5]).toMatchObject({ okCount: 1, total: 2 });
    expect(ok.failedAt).toMatchObject({ stage: 'delivering', destinationName: `Discord-${run}`, attemptNo: 3 });
    expect((byId.get(ids.rawRejected) as any).status).toBe('rejected');
    expect((byId.get(ids.rawOrphan) as any).status).toBe('failed');
  });

  it('[UI:F4-02] bộ lọc status ở SQL khớp đúng executionStatus của buildEventFlow; lọc type/destination/source', async () => {
    const all: any = await controller.listExecutions(tenant, {});
    for (const st of ['failed', 'in_progress', 'succeeded', 'rejected']) {
      const filtered: any = await controller.listExecutions(tenant, { status: st });
      const expected = all.items.filter((i: any) => i.status === st).map((i: any) => i.id).sort();
      expect(filtered.items.map((i: any) => i.id).sort()).toEqual(expected);
    }
    expect((await controller.listExecutions(tenant, { type: 'payment.*' }) as any).items.map((i: any) => i.id)).toEqual([ids.event]);
    expect((await controller.listExecutions(tenant, { type: 'repo.*' }) as any).items).toHaveLength(0);
    expect((await controller.listExecutions(tenant, { destination: ids.destOk }) as any).items.map((i: any) => i.id)).toEqual([ids.event]);
    expect((await controller.listExecutions(tenant, { source: ids.source }) as any).items).toHaveLength(3);
    await expect(controller.listExecutions(tenant, { status: 'weird' })).rejects.toThrow();
  });

  it('[UI:F4-03] cursor: trang 1 + trang 2 = toàn bộ, không trùng, không sót', async () => {
    const p1: any = await controller.listExecutions(tenant, { limit: '2' });
    expect(p1.items).toHaveLength(2);
    expect(p1.nextCursor).toBeTruthy();
    const p2: any = await controller.listExecutions(tenant, { limit: '2', cursor: p1.nextCursor });
    expect(p2.items).toHaveLength(1);
    expect(p2.nextCursor).toBeNull();
    const ids3 = [...p1.items, ...p2.items].map((i: any) => i.id);
    expect(new Set(ids3).size).toBe(3);
    await expect(controller.listExecutions(tenant, { cursor: 'rác' })).rejects.toThrow('cursor');
  });

  it('[UI:F4-04] (BB-5) executions cô lập tenant: tenant khác không thấy dòng nào', async () => {
    const res: any = await controller.listExecutions(other, {});
    expect(res.items).toHaveLength(0);
  });

  it('[UI:F5-01] topology: node source/gate/normalize/subscription/destination có số + health do server tính', async () => {
    const topo: any = await controller.getTopology(tenant, '1h');
    const node = (id: string) => topo.nodes.find((n: any) => n.id === id);
    const src = node(`src:${ids.source}`);
    expect(src).toMatchObject({ accepted: 2, rejected: 1, kind: 'source' });
    expect(node('normalize')).toMatchObject({ events: 1, orphans: 1 });
    const dFail = node(`dst:${ids.destFail}`);
    expect(dFail).toMatchObject({ circuitState: 'OPEN', retrying: 1, health: 'crashed' });
    const dOk = node(`dst:${ids.destOk}`);
    expect(dOk).toMatchObject({ succeeded: 1, successPct: 100, health: 'healthy', p95Ms: 84 });
    expect(node(`sub:${ids.subOff}`).health).toBe('idle');
    for (const n of topo.nodes) expect(['healthy', 'warning', 'crashed', 'idle']).toContain(n.health);
    for (const e of topo.edges) expect(['healthy', 'warning', 'crashed', 'idle']).toContain(e.health);
    expect(topo.edges.find((e: any) => e.id === `e:sub:${ids.subFail}`)).toMatchObject({ count: 2, retrying: 1, health: "crashed" }); // gen 1 + gen 2 (replay) đều là lưu lượng
  });

  it('[UI:F5-02] (BB-5) topology cô lập tenant + không lộ secret', async () => {
    const topo: any = await controller.getTopology(other, '24h');
    expect(topo.nodes.filter((n: any) => n.kind !== 'gate' && n.kind !== 'normalize')).toHaveLength(0);
    const text = JSON.stringify(await controller.getTopology(tenant, '24h'));
    for (const m of SECRET_MARKERS) expect(text).not.toContain(m);
    expect(text).not.toMatch(/Encrypted|signingSecret|secret/i);
    await expect(controller.getTopology(tenant, '7d')).rejects.toThrow();
  });

  it('[UI:F7-02] cột đa service: subscription sourceIds → nhãn source; endpoint PENDING → warning; source_filtered/endpoint_unverified ở routed', async () => {
    const otherSrc = await raw.source.create({ data: { tenantId: tenant, provider: 'sepay', name: `khác-${run}`, sourceKey: `src_flow_other_${run}` } });
    const pend = await raw.destination.create({
      data: { tenantId: tenant, name: `Pending-${run}`, type: 'webhook', configEncrypted: 'x', verification: 'PENDING' },
    });
    // createdAt lùi về trước event: R-6 chỉ xét subscription đã tồn tại lúc event được định tuyến.
    const before = new Date(Date.now() - 60 * 60_000);
    const subFiltered = await raw.subscription.create({
      data: { tenantId: tenant, destinationId: ids.destOk, name: 'chỉ từ source khác', eventTypes: ['payment.*'], sourceIds: [otherSrc.id], createdAt: before },
    });
    const subPending = await raw.subscription.create({
      data: { tenantId: tenant, destinationId: pend.id, name: 'chờ xác minh', eventTypes: ['payment.*'], createdAt: before },
    });
    const subLater = await raw.subscription.create({
      data: { tenantId: tenant, destinationId: pend.id, name: 'tạo SAU event', eventTypes: ['payment.*'], isActive: false },
    });
    try {
      const topo: any = await controller.getTopology(tenant, '1h');
      const subNode = topo.nodes.find((n: any) => n.id === `sub:${subFiltered.id}`);
      expect(subNode.sourceIds).toEqual([otherSrc.id]);
      expect(subNode.sourceLabels).toEqual(["SePay"]); // provider duy nhất trong project → nhãn gọn
      const pendNode = topo.nodes.find((n: any) => n.id === `dst:${pend.id}`);
      expect(pendNode).toMatchObject({ verification: 'PENDING', health: 'warning' });

      const f: any = await controller.getEventFlow(tenant, ids.event);
      const skipped = f.stages.find((s: any) => s.key === 'routed').detail.skipped.map((s: any) => [s.id, s.reason.code]);
      expect(skipped).toEqual(
        expect.arrayContaining([
          [subFiltered.id, 'source_filtered'],
          [subPending.id, 'endpoint_unverified'],
          [ids.subOff, 'subscription_inactive'],
        ]),
      );
      // [UI:R6-01] subscription tạo SAU event không bao giờ là lý do bỏ qua event đó.
      expect(skipped.map((x: string[]) => x[0])).not.toContain(subLater.id);
    } finally {
      await raw.subscription.deleteMany({ where: { id: { in: [subFiltered.id, subPending.id, subLater.id] } } });
      await raw.destination.delete({ where: { id: pend.id } });
      await raw.source.delete({ where: { id: otherSrc.id } });
    }
  });

  it('[UI:F7-03] (BB-5) phạm vi project đi qua ProjectScopeGuard: thành viên + ?projectId= hợp lệ đổi tenant, lạ / không là thành viên → 404, không có → project đầu tiên của mình (AU1)', async () => {
    const { FlowProjectScopeGuard } = await import('../src/modules/flow/flow-scope');
    const guard = new FlowProjectScopeGuard(flow);
    await raw.project.create({ data: { id: tenant, slug: `flow-${run}`, name: `flow ${run}` } });
    const member = await raw.user.create({ data: { email: `flow-m-${run}@t.vn`, name: 'M' } });
    const outsider = await raw.user.create({ data: { email: `flow-o-${run}@t.vn`, name: 'O' } });
    await raw.projectMember.create({ data: { tenantId: tenant, userId: member.id, role: 'viewer' } });
    const who = (u: { id: string }) => ({ kind: 'user', id: u.id, sessionId: 's', email: 'x', name: 'x', isOperator: false, emailVerified: true });
    const ctx = (query: Record<string, string>, u: { id: string } = member) => {
      const req: any = { query, principal: who(u) };
      return { req, ctx: { switchToHttp: () => ({ getRequest: () => req }) } as any };
    };
    try {
      const a = ctx({ projectId: tenant });
      await expect(guard.canActivate(a.ctx)).resolves.toBe(true);
      expect(a.req.tenantId).toBe(tenant);
      const items: any = await controller.listExecutions(a.req.tenantId, {});
      expect(items.items.length).toBe(3);
      await expect(guard.canActivate(ctx({ projectId: randomUUID() }).ctx)).rejects.toThrow();
      await expect(guard.canActivate(ctx({ projectId: tenant }, outsider).ctx)).rejects.toMatchObject({ status: 404 });
      const none = ctx({});
      await expect(guard.canActivate(none.ctx)).resolves.toBe(true);
      expect(none.req.tenantId).toBe(tenant);
    } finally {
      await raw.user.deleteMany({ where: { id: { in: [member.id, outsider.id] } } });
      await raw.project.delete({ where: { id: tenant } });
    }
  });

  it('[UI:R9-01] repo flow dựng qua TenantScopedRepository.extend: cùng tenant, là TenantScopedRepository, không ép kiểu', async () => {
    const { flowRepoFor, FlowScopedRepository } = await import('../src/modules/flow/flow.repository');
    const { TenantScopedRepository } = await import('@hub/database');
    const repo = flowRepoFor(svc, tenant);
    expect(repo).toBeInstanceOf(FlowScopedRepository);
    expect(repo).toBeInstanceOf(TenantScopedRepository);
    expect(repo.tenantId).toBe(tenant);
    expect((await repo.findRawEventForFlow(ids.rawOk))?.id).toBe(ids.rawOk);
    expect(await flowRepoFor(svc, other).findRawEventForFlow(ids.rawOk)).toBeNull();
  });

  it('[UI:F2-06] che bí mật: không ciphertext, signingSecret, token hay authorization thô trong response', async () => {
    for (const id of [ids.event, ids.rawRejected]) {
      const text = JSON.stringify(await controller.getEventFlow(tenant, id));
      for (const m of SECRET_MARKERS) expect(text).not.toContain(m);
      expect(text).not.toMatch(/Encrypted|signingSecret|botToken|body_raw|bodyRaw/);
    }
  });
});
