import { HttpException } from '@nestjs/common';
import { TenantScopedRepository, getMasterKey } from '@hub/database';
import { aesGcmEncrypt } from '@hub/crypto';
import { ServiceResourcesController } from '../src/modules/service-api/service-resources.controller';

// Tự đủ: không dựa vào test khác trong cùng worker đặt MASTER_KEY (thứ tự jest không cố định).
process.env.MASTER_KEY = process.env.MASTER_KEY || 'test-master-key-at-least-32-characters!!';

/**
 * S5 (SPEC §4.3B, §4.6): endpoint + subscription cho service qua `/v1/p/:project`. Repo THẬT trên Prisma giả
 * trong bộ nhớ — kiểm đúng lớp lọc project. Lỗi theo bảng `/v1/p`: 422 có tên trường, tài nguyên khác project 404.
 */
describe('Service API — endpoint + subscription (S5)', () => {
  const PA = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const PB = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  const EA = '11111111-1111-1111-1111-111111111111';
  const EB = '22222222-2222-2222-2222-222222222222';
  const SA = '33333333-3333-3333-3333-333333333333';
  const SB = '44444444-4444-4444-4444-444444444444';
  const ETG = '88888888-8888-8888-8888-888888888888';

  function build() {
    const destinations: any[] = [
      { id: EA, tenantId: PA, name: 'A', type: 'webhook', configEncrypted: aesGcmEncrypt(JSON.stringify({ url: 'https://a.example/h' }), getMasterKey()), signingSecretEncrypted: aesGcmEncrypt('whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw', getMasterKey()), verification: 'VERIFIED', createdByKeyId: 'key-1' },
      { id: EB, tenantId: PB, name: 'B', type: 'webhook', configEncrypted: 'enc', signingSecretEncrypted: null, verification: 'VERIFIED', createdByKeyId: 'key-b' },
      { id: ETG, tenantId: PA, name: 'Telegram Ops', type: 'telegram', configEncrypted: 'enc', signingSecretEncrypted: null, verification: 'VERIFIED' },
    ];
    const sources = [
      { id: SA, tenantId: PA, sourceKey: 'src_sepay_main' },
      { id: SB, tenantId: PB, sourceKey: 'src_sepay_other' },
    ];
    const subs: any[] = [];
    const audits: any[] = [];
    // R2-2: key cũ của service (đã revoke) + key còn sống của service khác
    const apiKeys: any[] = [
      { id: 'key-old', tenantId: PA, serviceName: 'cafe-be', revokedAt: new Date(0) },
      { id: 'key-live-other', tenantId: PA, serviceName: 'cafe-be', revokedAt: null },
      { id: 'key-shop-old', tenantId: PA, serviceName: 'shop', revokedAt: new Date(0) },
    ];
    const match = (row: any, where: any) =>
      Object.entries(where).every(([k, v]: [string, any]) =>
        v && typeof v === 'object' && 'in' in v ? v.in.includes(row[k]) : row[k] === v,
      );
    const client: any = {
      destination: {
        findFirst: jest.fn(async ({ where }: any) => destinations.find((d) => match(d, where)) ?? null),
        findMany: jest.fn(async ({ where }: any) => destinations.filter((d) => match(d, where))),
        create: jest.fn(async ({ data }: any) => {
          const row = { id: `dest-${destinations.length}`, createdAt: new Date(0), ...data };
          destinations.push(row);
          return row;
        }),
        updateMany: jest.fn(async ({ where, data }: any) => {
          const rows = destinations.filter((d) => match(d, where));
          rows.forEach((r) => Object.assign(r, data));
          return { count: rows.length };
        }),
      },
      source: { findMany: jest.fn(async ({ where }: any) => sources.filter((s) => match(s, where))) },
      subscription: {
        updateMany: jest.fn(async ({ where, data }: any) => {
          const rows = subs.filter((x) => x.id === where.id && x.tenantId === where.tenantId);
          rows.forEach((r) => Object.assign(r, data));
          return { count: rows.length };
        }),
        findFirst: jest.fn(async ({ where }: any) => {
          const r = subs.find((x) => x.id === where.id && x.tenantId === where.tenantId);
          return r ? { ...r, destination: destinations.find((d) => d.id === r.destinationId) } : null;
        }),
        create: jest.fn(async ({ data }: any) => {
          const row = { id: `00000000-0000-4000-8000-${String(subs.length).padStart(12, "0")}`, createdAt: new Date(0), ...data };
          subs.push(row);
          return { ...row, destination: destinations.find((d) => d.id === data.destinationId) };
        }),
        findMany: jest.fn(async ({ where }: any) =>
          subs
            .filter((s) => s.tenantId === where.tenantId)
            .filter((s) => !where.destination || match(destinations.find((d) => d.id === s.destinationId) ?? {}, where.destination)),
        ),
      },
      auditLog: { create: jest.fn(async ({ data }: any) => audits.push(data)) },
      apiKey: { findMany: jest.fn(async ({ where }: any) => apiKeys.filter((k) => k.tenantId === where.tenantId)) },
    };
    const prisma: any = {
      forTenant: (tenantId: string, c?: any) => new TenantScopedRepository(c ?? client, tenantId),
      $transaction: async (fn: any) => fn(client),
    };
    const req = (tenantId: string, readTypes: string[] = [], keyId = 'key-1') => ({ tenantId, apiKey: { id: keyId, tenantId, serviceName: 'cafe-be', readTypes } }) as any;
    const verifier = { challenge: jest.fn(async (): Promise<any> => verdict.next) };
    const verdict: { next: any } = { next: { verification: 'VERIFIED', verificationError: null } };
    return { controller: new ServiceResourcesController(prisma, verifier as any), destinations, subs, audits, req, verifier, verdict, apiKeys };
  }

  async function status(p: Promise<unknown>): Promise<{ status: number; body: any }> {
    try {
      await p;
      return { status: 0, body: null };
    } catch (e) {
      if (e instanceof HttpException) return { status: e.getStatus(), body: e.getResponse() };
      throw e;
    }
  }

  it('[MS:T5] (phần a) subscription trỏ endpoint của project khác -> 404 not_found, không tạo gì', async () => {
    const { controller, subs, req } = build();
    const r = await status(controller.createSubscription(req(PA), { endpointId: EB, name: 'x', eventTypes: ['order.*'] }));
    expect(r).toEqual({ status: 404, body: { error: 'not_found' } });
    expect(subs).toHaveLength(0);
  });

  it('[MS:T5] (phần b) sourceIds có id không thuộc project -> 422 unknown_source kèm ids', async () => {
    const { controller, subs, req } = build();
    const r = await status(controller.createSubscription(req(PA), { endpointId: EA, name: 'x', eventTypes: ['order.*'], sourceIds: [SA, SB] }));
    expect(r).toEqual({ status: 422, body: { error: 'unknown_source', ids: [SB] } });
    expect(subs).toHaveLength(0);
  });

  it('[MS:U19] (phần b) eventTypes sai ngữ pháp (*.paid, payment.*.x, Payment.*) -> 422 field eventTypes; `*` hợp lệ (X1)', async () => {
    const { controller, req } = build();
    for (const bad of ['*.paid', 'payment.*.x', 'Payment.*']) {
      const r = await status(controller.createSubscription(req(PA), { endpointId: EA, name: 'x', eventTypes: [bad] }));
      expect(r.status).toBe(422);
      expect(r.body).toMatchObject({ error: 'validation_failed', field: 'eventTypes' });
    }
    const ok = await controller.createSubscription(req(PA), { endpointId: EA, name: 'all', eventTypes: ['*'] });
    expect(ok).toMatchObject({ endpointId: EA, eventTypes: ['*'], sourceIds: [] });
  });

  it('[MS:T5] (phần c) tạo subscription hợp lệ -> trả endpointId/sourceIds, ghi audit subscription.create với actor là key', async () => {
    const { controller, subs, audits, req } = build();
    const created = await controller.createSubscription(req(PA), { endpointId: EA, name: 'orders', eventTypes: ['order.*'], sourceIds: [SA] });
    expect(created).toMatchObject({ name: 'orders', endpointId: EA, eventTypes: ['order.*'], sourceIds: [SA], isActive: true });
    expect(subs[0]).toMatchObject({ tenantId: PA, destinationId: EA, sourceIds: [SA] });
    expect(audits[0]).toMatchObject({ action: 'subscription.create', actor: 'key:key-1', tenantId: PA });
  });

  it('[MS:T4] (phần d) tạo endpoint không truyền secret -> hub sinh whsec_ (trả ĐÚNG lần này), challenge VERIFIED, audit endpoint.verified', async () => {
    const { controller, destinations, audits, req, verifier } = build();
    const created: any = await controller.createEndpoint(req(PA), { name: 'echo', url: 'https://example.com/hook' });
    expect(created).toMatchObject({ name: 'echo', url: 'https://example.com/hook', verification: 'VERIFIED', verificationError: null });
    expect(created.signingSecret).toMatch(/^whsec_/);
    expect(verifier.challenge).toHaveBeenCalledWith('https://example.com/hook', created.signingSecret);
    expect(JSON.stringify(created)).not.toMatch(/Encrypted/);
    const row = destinations.find((d) => d.id === created.id);
    expect(row).toMatchObject({ tenantId: PA, type: 'webhook', verification: 'VERIFIED' });
    expect(row.verifiedAt).toBeInstanceOf(Date);
    expect(row.configEncrypted).not.toContain('example.com');
    expect(row.signingSecretEncrypted).not.toContain('whsec_');
    expect(audits.map((a) => a.action)).toEqual(['endpoint.create', 'endpoint.verified']);
    // danh sách không bao giờ trả secret
    expect(JSON.stringify(await controller.listEndpoints(req(PA)))).not.toMatch(/whsec_|signingSecret/);
  });

  it('[MS:T4] (phần e) challenge FAILED -> vẫn trả endpoint (201), verification FAILED + lý do, audit endpoint.verification_failed; secret tự truyền thì KHÔNG trả lại', async () => {
    const { controller, destinations, audits, req, verdict } = build();
    verdict.next = { verification: 'FAILED', verificationError: 'http_500' };
    const created: any = await controller.createEndpoint(req(PA), { name: 'hong', url: 'https://example.com/fail', signingSecret: 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw' });
    expect(created).toMatchObject({ verification: 'FAILED', verificationError: 'http_500' });
    expect(created.signingSecret).toBeUndefined();
    expect(destinations.find((d) => d.id === created.id)).toMatchObject({ verification: 'FAILED', verificationError: 'http_500', verifiedAt: null });
    expect(audits.map((a) => a.action)).toEqual(['endpoint.create', 'endpoint.verification_failed']);
  });

  it('[MS:T2] (phần b) POST /endpoints/:id/verify: endpoint project khác -> 404 not_found; của mình -> chạy lại challenge', async () => {
    const { controller, req, verdict, destinations } = build();
    expect(await status(controller.verifyEndpoint(req(PA), EB))).toEqual({ status: 404, body: { error: 'not_found' } });
    expect(await status(controller.verifyEndpoint(req(PA), 'khong-phai-uuid'))).toEqual({ status: 404, body: { error: 'not_found' } });
    verdict.next = { verification: 'FAILED', verificationError: 'timeout' };
    await expect(controller.verifyEndpoint(req(PA), EA)).resolves.toEqual({ verification: 'FAILED', verificationError: 'timeout' });
    expect(destinations.find((d) => d.id === EA)).toMatchObject({ verification: 'FAILED', verificationError: 'timeout' });
  });

  it('S5: url không phải http(s) / thiếu name -> 422 có tên trường', async () => {
    const { controller, req } = build();
    expect((await status(controller.createEndpoint(req(PA), { name: 'x', url: 'ftp://a/b' }))).body).toMatchObject({ field: 'url' });
    expect((await status(controller.createEndpoint(req(PA), { name: 'x', url: 'không phải url' }))).body).toMatchObject({ field: 'url' });
    expect((await status(controller.createEndpoint(req(PA), { url: 'https://a.b/c' }))).body).toMatchObject({ field: 'name' });
  });

  it('S5: GET endpoints chỉ thấy webhook của project mình, không lộ secret', async () => {
    const { controller, req } = build();
    const list: any[] = await controller.listEndpoints(req(PA));
    expect(list.map((e) => e.id)).toEqual([EA]);
    expect(JSON.stringify(list)).not.toMatch(/Encrypted/);
  });

  it('MS-R1 (phần b): /verify giới hạn 5 lần/phút/endpoint trong bộ nhớ (0 Redis) -> lần 6: 429, không gọi challenge', async () => {
    const { controller, req, verifier } = build();
    for (let i = 0; i < 5; i++) await controller.verifyEndpoint(req(PA), EA);
    const before = verifier.challenge.mock.calls.length;
    expect(await status(controller.verifyEndpoint(req(PA), EA))).toMatchObject({ status: 429, body: { error: 'rate_limited' } });
    expect(verifier.challenge.mock.calls.length).toBe(before);
  });

  it('MS-R3: subscription trỏ đích telegram/discord của operator (cùng project) -> 404 như không tồn tại; GET chỉ trả subscription tới webhook', async () => {
    const { controller, subs, req } = build();
    expect(await status(controller.createSubscription(req(PA), { endpointId: ETG, name: 'spam', eventTypes: ['*'] }))).toEqual({ status: 404, body: { error: 'not_found' } });
    expect(subs).toHaveLength(0);
    subs.push({ id: 'sub-admin', tenantId: PA, destinationId: ETG, name: 'admin tg', eventTypes: ['payment.*'], sourceIds: [], isActive: true });
    await controller.createSubscription(req(PA), { endpointId: EA, name: 'ok', eventTypes: ['order.*'] });
    const list: any[] = await controller.listSubscriptions(req(PA));
    expect(list.map((x) => x.endpointId)).toEqual([EA]);
  });

  it('MS-R3: key có readTypes -> eventTypes phải nằm trong readTypes (push không rộng hơn polling)', async () => {
    const { controller, req } = build();
    const k = req(PA, ['order.*', 'payment.received']);
    expect(await status(controller.createSubscription(k, { endpointId: EA, name: 'x', eventTypes: ['payment.*'] }))).toMatchObject({ status: 422, body: { error: 'outside_read_types', field: 'eventTypes', invalid: ['payment.*'] } });
    expect(await status(controller.createSubscription(k, { endpointId: EA, name: 'x', eventTypes: ['*'] }))).toMatchObject({ status: 422 });
    await expect(controller.createSubscription(k, { endpointId: EA, name: 'ok', eventTypes: ['order.created', 'order.refund.*', 'payment.received'] })).resolves.toMatchObject({ eventTypes: ['order.created', 'order.refund.*', 'payment.received'] });
    await expect(controller.createSubscription(req(PA, ['*']), { endpointId: EA, name: 'all', eventTypes: ['*'] })).resolves.toBeTruthy();
  });

  it('MS-R4: /verify kèm signingSecret -> challenge ký bằng secret MỚI; VERIFIED thì lưu secret mới, FAILED thì GIỮ secret + trạng thái cũ', async () => {
    const { controller, req, verifier, verdict, destinations } = build();
    const NEW = 'whsec_bmV3LXNlY3JldC1mb3ItbXMtcjQtdGVzdA==';
    const before = destinations.find((d) => d.id === EA).signingSecretEncrypted;
    verdict.next = { verification: 'FAILED', verificationError: 'http_401' };
    expect(await controller.verifyEndpoint(req(PA), EA, { signingSecret: NEW })).toEqual({ verification: 'FAILED', verificationError: 'http_401', secretRotated: false });
    expect(verifier.challenge).toHaveBeenLastCalledWith('https://a.example/h', NEW);
    expect(destinations.find((d) => d.id === EA)).toMatchObject({ signingSecretEncrypted: before, verification: 'VERIFIED' });
    verdict.next = { verification: 'VERIFIED', verificationError: null };
    expect(await controller.verifyEndpoint(req(PA), EA, { signingSecret: NEW })).toEqual({ verification: 'VERIFIED', verificationError: null, secretRotated: true });
    const after = destinations.find((d) => d.id === EA).signingSecretEncrypted;
    expect(after).not.toBe(before);
    expect(require('@hub/crypto').aesGcmDecrypt(after, getMasterKey())).toBe(NEW);
    expect(await status(controller.verifyEndpoint(req(PA), EA, { signingSecret: 'ngan' }))).toMatchObject({ status: 422, body: { field: 'signingSecret' } });
  });

  it('MS-P2-1: subscription ghim source theo sourceKey (không cần manage:sources); key lạ/khác project -> 422; response trả sourceKeys', async () => {
    const { controller, req, subs } = build();
    const c: any = await controller.createSubscription(req(PA), { endpointId: EA, name: 'pay', eventTypes: ['payment.received'], sourceKeys: ['src_sepay_main'] });
    expect(subs[0].sourceIds).toEqual([SA]);
    expect(c).toMatchObject({ sourceIds: [SA], sourceKeys: ['src_sepay_main'] });
    expect(await status(controller.createSubscription(req(PA), { endpointId: EA, name: 'x', eventTypes: ['payment.received'], sourceKeys: ['src_sepay_other'] }))).toMatchObject({ status: 422, body: { error: 'unknown_source', keys: ['src_sepay_other'] } });
    const list: any[] = await controller.listSubscriptions(req(PA));
    expect(list[0].sourceKeys).toEqual(['src_sepay_main']);
  });

  it('MS-P2-1: PATCH subscription {isActive:false} (tắt subscription cũ không lọc nguồn); khác project / đích không phải webhook -> 404', async () => {
    const { controller, req, subs, audits } = build();
    await controller.createSubscription(req(PA), { endpointId: EA, name: 'old', eventTypes: ['payment.received'] });
    await expect(controller.updateSubscription(req(PA), subs[0].id, { isActive: false })).resolves.toMatchObject({ isActive: false });
    expect(subs[0].isActive).toBe(false);
    expect(audits.map((a) => a.action)).toContain('subscription.update');
    expect(await status(controller.updateSubscription(req(PB), subs[0].id, { isActive: true }))).toMatchObject({ status: 404 });
    expect(await status(controller.updateSubscription(req(PA), subs[0].id, { isActive: 'x' }))).toMatchObject({ status: 422 });
  });

  it('R-1: endpoint có chủ — key KHÁC cùng project không thấy, không gắn subscription, không /verify endpoint của key khác (404 như không tồn tại)', async () => {
    const { controller, req, subs, verifier } = build();
    const other = req(PA, [], 'key-attacker');
    expect(await status(controller.createSubscription(other, { endpointId: EA, name: 'x', eventTypes: ['payment.received'] }))).toEqual({ status: 404, body: { error: 'not_found' } });
    expect(subs).toHaveLength(0);
    expect(await status(controller.verifyEndpoint(other, EA))).toMatchObject({ status: 404 });
    expect(verifier.challenge).not.toHaveBeenCalled();
    expect((await controller.listEndpoints(other)).map((e: any) => e.id)).toEqual([]);
    expect((await controller.listEndpoints(req(PA))).map((e: any) => e.id)).toEqual([EA]);
    const created: any = await controller.createEndpoint(other, { name: 'own', url: 'https://own.example/h' });
    expect((await controller.listEndpoints(other)).map((e: any) => e.id)).toEqual([created.id]);
  });


  it('R-2: key khác KHÔNG tắt được (PATCH) / không thấy subscription của endpoint không phải của mình', async () => {
    const { controller, req, subs } = build();
    await controller.createSubscription(req(PA), { endpointId: EA, name: 'pinned', eventTypes: ['payment.received'] });
    const other = req(PA, [], 'key-attacker');
    expect(await status(controller.updateSubscription(other, subs[0].id, { isActive: false }))).toMatchObject({ status: 404 });
    expect(subs[0].isActive).toBe(true);
    expect(await controller.listSubscriptions(other)).toEqual([]);
    expect((await controller.listSubscriptions(req(PA))).map((x: any) => x.id)).toEqual([subs[0].id]);
  });

  it('R2-2: xoay key — endpoint cùng url của key CŨ (đã revoke, CÙNG serviceName) được key mới nhận lại, không tạo endpoint thứ hai', async () => {
    const { controller, req, destinations, audits, verifier } = build();
    const url = 'https://a.example/old';
    const enc = (o: any) => aesGcmEncrypt(JSON.stringify(o), getMasterKey());
    destinations.push({ id: '99999999-9999-4999-8999-999999999999', tenantId: PA, name: 'old', type: 'webhook', configEncrypted: enc({ url }), signingSecretEncrypted: aesGcmEncrypt('whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw', getMasterKey()), verification: 'VERIFIED', createdByKeyId: 'key-old' });
    const before = destinations.length;
    const r: any = await controller.createEndpoint(req(PA), { name: 'cafe', url, signingSecret: 'whsec_bmV3LXNlY3JldC1mb3ItbXMtcjQtdGVzdA==' });
    expect(r).toMatchObject({ id: '99999999-9999-4999-8999-999999999999', adopted: true, verification: 'VERIFIED' });
    expect(destinations).toHaveLength(before);
    expect(destinations.find((d) => d.id === r.id)!.createdByKeyId).toBe('key-1');
    expect(verifier.challenge).toHaveBeenLastCalledWith(url, 'whsec_bmV3LXNlY3JldC1mb3ItbXMtcjQtdGVzdA==');
    expect(audits.map((a) => a.action)).toContain('endpoint.adopted');
  });

  it('R2-2: KHÔNG nhận endpoint của key còn sống, của service khác (serviceName khác) hay của operator (NULL) -> tạo mới', async () => {
    const { controller, req, destinations } = build();
    const enc = (o: any) => aesGcmEncrypt(JSON.stringify(o), getMasterKey());
    const mk = (id: string, url: string, owner: string | null) =>
      destinations.push({ id, tenantId: PA, name: 'x', type: 'webhook', configEncrypted: enc({ url }), signingSecretEncrypted: null, verification: 'VERIFIED', createdByKeyId: owner });
    mk('aaaaaaaa-0000-4000-8000-000000000001', 'https://a.example/live', 'key-live-other');
    mk('aaaaaaaa-0000-4000-8000-000000000002', 'https://a.example/shop', 'key-shop-old');
    mk('aaaaaaaa-0000-4000-8000-000000000003', 'https://a.example/op', null);
    for (const url of ['https://a.example/live', 'https://a.example/shop', 'https://a.example/op']) {
      const r: any = await controller.createEndpoint(req(PA), { name: 'n', url });
      expect(r.adopted).toBeUndefined();
      expect(r.id).not.toMatch(/^aaaaaaaa/);
    }
  });

  it('R3-1: nhận lại endpoint mà challenge FAILED (secret sai) -> 409, GIỮ NGUYÊN chủ, secret, trạng thái; không audit adopted', async () => {
    const { controller, req, destinations, audits, verdict } = build();
    const url = 'https://a.example/old';
    const oldSecret = aesGcmEncrypt('whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw', getMasterKey());
    destinations.push({ id: '99999999-9999-4999-8999-999999999998', tenantId: PA, name: 'old', type: 'webhook', configEncrypted: aesGcmEncrypt(JSON.stringify({ url }), getMasterKey()), signingSecretEncrypted: oldSecret, verification: 'VERIFIED', verificationError: null, createdByKeyId: 'key-old' });
    const before = destinations.length;
    verdict.next = { verification: 'FAILED', verificationError: 'http_401' };
    const r = await status(controller.createEndpoint(req(PA), { name: 'cafe', url, signingSecret: 'whsec_c2FpLXNlY3JldC1jdWEta2V5LW1vaS10ZXN0' }));
    expect(r).toMatchObject({ status: 409, body: { error: 'adoption_not_verified', verificationError: 'http_401' } });
    const row = destinations.find((d) => d.id === '99999999-9999-4999-8999-999999999998')!;
    expect(row).toMatchObject({ createdByKeyId: 'key-old', signingSecretEncrypted: oldSecret, verification: 'VERIFIED', verificationError: null });
    expect(destinations).toHaveLength(before);
    expect(audits.map((a) => a.action)).not.toContain('endpoint.adopted');
  });
});

