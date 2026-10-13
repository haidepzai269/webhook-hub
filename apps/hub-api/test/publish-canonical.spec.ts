import { HttpException } from '@nestjs/common';
import { ERROR_CATALOG, HUB_CLEANUP_SUGGESTED, validateCanonical } from '@hub/common';
import { ServiceApiController } from '../src/modules/service-api/service-api.controller';

/** S4 (SPEC §4.4, §4.14.1 luật 4): POST /v1/p/:project/events kiểm đầu vào + catalog ĐỒNG BỘ, trước persistAccepted. */
describe('POST /v1/p/:project/events (S4)', () => {
  const PA = '11111111-1111-1111-1111-111111111111';
  function setup() {
    const ingest = { publishFromService: jest.fn().mockResolvedValue({ status: 202, body: { eventId: null, rawEventId: 'r1', duplicate: false } }) };
    const ctrl = new ServiceApiController(ingest as any);
    const res: any = { statusCode: 0, body: undefined, status(c: number) { this.statusCode = c; return this; }, json(b: unknown) { this.body = b; return this; } };
    const req = (body: any): any => ({
      body,
      rawBody: Buffer.from(JSON.stringify(body)),
      headers: { 'content-type': 'application/json' },
      tenantId: PA,
      apiKey: { id: 'k', tenantId: PA, sourceId: 'src-api', scopes: ['publish:events'], project: { slug: 'cafe' } },
    });
    const call = async (body: any) => {
      try {
        await ctrl.publish(req(body), res);
        return { status: res.statusCode, body: res.body };
      } catch (e) {
        if (e instanceof HttpException) return { status: e.getStatus(), body: e.getResponse() as any };
        throw e;
      }
    };
    return { call, ingest };
  }

  it('[MS:U49] payment.received thiếu providerTxnId -> 422 schema_mismatch; order.created data bất kỳ -> 202', async () => {
    const { call, ingest } = setup();
    const data = { amount: 50000, currency: 'VND', method: 'bank_transfer', reference: null, memo: null, counterparty: null, account: null, raw: {}, paidAt: '2026-10-10T00:00:00.000Z' };
    const bad = await call({ type: 'payment.received', data, idempotencyKey: 'p1' });
    expect(bad).toEqual({ status: 422, body: { error: 'schema_mismatch', type: 'payment.received', field: 'providerTxnId' } });
    expect(ingest.publishFromService).not.toHaveBeenCalled();
    const ok = await call({ type: 'order.created', data: { anything: [1, 2] }, idempotencyKey: 'o1' });
    expect(ok.status).toBe(202);
    expect(ingest.publishFromService).toHaveBeenCalledWith(PA, 'src-api', expect.objectContaining({ provider: 'api', body: expect.objectContaining({ type: 'order.created' }) }));
  });

  it('[QT:T24] (phần f) review QT-S2 M1: publish hub.project.cleanup_suggested với data ĐÚNG khuôn -> 422 reserved_type (chỉ hub nội bộ phát); không ghi', async () => {
    const { call, ingest } = setup();
    const data = { level: 'WARN_85', usedBytes: 1, quotaBytes: 2, forecastHours: null, suggestions: [] };
    expect(validateCanonical(HUB_CLEANUP_SUGGESTED, data)).toEqual({ ok: true }); // khuôn đúng — vẫn bị chặn theo namespace
    for (const type of [HUB_CLEANUP_SUGGESTED, 'hub.anything.else']) {
      expect(await call({ type, data, idempotencyKey: 'h1' })).toEqual({ status: 422, body: { error: 'reserved_type', type, field: 'type' } });
    }
    expect(ingest.publishFromService).not.toHaveBeenCalled();
    expect(ERROR_CATALOG.reserved_type.status).toBe(422);
    // namespace khác bắt đầu bằng "hub" nhưng không phải hub.* -> của service, cho qua
    expect((await call({ type: 'hubspot.contact', data: {}, idempotencyKey: 'h2' })).status).toBe(202);
  });

  it('kiểm đầu vào -> 422 có tên trường: type sai, thiếu idempotencyKey, data không phải object', async () => {
    const { call } = setup();
    expect(await call({ type: 'Order', data: {}, idempotencyKey: 'a' })).toMatchObject({ status: 422, body: { field: 'type' } });
    expect(await call({ type: 'order', data: {}, idempotencyKey: 'a' })).toMatchObject({ status: 422, body: { field: 'type' } });
    expect(await call({ type: 'order.created', data: {} })).toMatchObject({ status: 422, body: { field: 'idempotencyKey' } });
    expect(await call({ type: 'order.created', data: {}, idempotencyKey: 'x'.repeat(256) })).toMatchObject({ status: 422, body: { field: 'idempotencyKey' } });
    expect(await call({ type: 'order.created', data: [1], idempotencyKey: 'a' })).toMatchObject({ status: 422, body: { field: 'data' } });
  });
});
