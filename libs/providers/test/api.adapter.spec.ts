import { ApiAdapter, ProviderRegistry } from '../src';

/** S4 (SPEC §4.4): ApiAdapter — nguồn `api` chỉ nhận qua POST /v1/p/:project/events (ApiKeyGuard lo xác thực). */
describe('ApiAdapter (S4)', () => {
  const a = new ApiAdapter();
  const req = (body: any) => ({ provider: 'api' as const, sourceKey: 'api_x', headers: {}, rawBody: Buffer.from(JSON.stringify(body)), body });

  it('[MS:U16] verify() luôn false với mọi input — không ai đẩy được vào /hooks/api/... từ ngoài', async () => {
    expect(await a.verify(req({ type: 'order.created', data: {}, idempotencyKey: 'x' }), ['s'])).toBe(false);
    expect(await a.verify(req({}), [])).toBe(false);
    expect(await a.verify({ ...req({}), headers: { authorization: 'Bearer hk_test_x' } }, ['hk_test_x'])).toBe(false);
  });

  it('extractIdempotencyKey = api:<idempotencyKey>; khoá dài vẫn vừa VARCHAR(255) và tất định', () => {
    expect(a.extractIdempotencyKey(req({ idempotencyKey: 'ord-1' }))).toBe('api:ord-1');
    const long = 'k'.repeat(255);
    const k1 = a.extractIdempotencyKey(req({ idempotencyKey: long }));
    expect(k1.length).toBeLessThanOrEqual(255);
    expect(a.extractIdempotencyKey(req({ idempotencyKey: long }))).toBe(k1);
    expect(a.extractIdempotencyKey(req({ idempotencyKey: long + 'x' }))).not.toBe(k1);
  });

  it('normalize: type/data/subject của service, source=api, normalized=true (hợp đồng của chính service)', () => {
    const [e] = a.normalize(req({ type: 'order.created', data: { total: 45000 }, subject: 'order:1', idempotencyKey: 'ord-1' }), {
      tenantId: 't', sourceId: 's', correlationId: 'c', rawEventId: 'r', receivedAt: '2026-10-10T00:00:00.000Z',
    });
    expect(e).toMatchObject({ type: 'order.created', data: { total: 45000 }, subject: 'order:1', source: 'api', sourceId: 's', normalized: true });
  });

  it('đăng ký trong registry dưới provider "api"', () => {
    expect(ProviderRegistry.get('api')).toBeInstanceOf(ApiAdapter);
  });

  it('MS-R6: event do service tự phát mang origin "api" (không phải webhook)', () => {
    const r: any = { provider: 'api', sourceKey: 'k', headers: {}, rawBody: Buffer.from('{}'), body: { type: 'order.created', data: {}, idempotencyKey: 'x' } };
    const [e] = new ApiAdapter().normalize(r, { tenantId: 't', sourceId: 's', correlationId: 'c', rawEventId: 'r' });
    expect(e.origin).toBe('api');
  });
});
