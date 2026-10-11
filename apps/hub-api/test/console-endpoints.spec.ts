import { HttpException } from '@nestjs/common';
import { catalogCoversPattern } from '@hub/common';
import { ApiController } from '../src/modules/api/api.controller';
import { parseConsoleEventTypes } from '../src/modules/console/endpoints.controller';
import { toErrorBody } from '../src/modules/errors/service-exception.filter';

/** KN1 (SPEC-ket-noi §3.1) — phần không cần DB. */
describe('[KN1] console endpoints — L0', () => {
  it('[KN:U5] POST /destinations với type:"webhook" -> 422 use_endpoints_route có fix; không chạm DB', async () => {
    const prisma: any = new Proxy({}, { get: () => { throw new Error('không được chạm DB'); } });
    const c = new ApiController(prisma);
    const e = await c.createDestination('t', 'u', { name: 'x', type: 'webhook', config: { url: 'https://a.example/h' } }).then(() => null, (x) => x);
    expect(e).toBeInstanceOf(HttpException);
    expect(e.getStatus()).toBe(422);
    const body = toErrorBody(e, 'req-1').body;
    expect(body).toMatchObject({ error: 'use_endpoints_route', requestId: 'req-1' });
    expect(body.fix).toContain('/api/v1/endpoints');
  });

  it('[KN1] eventTypes theo catalog: payment.*/repo.* phải có trong catalog, kiểu riêng của service thì tự do', () => {
    for (const ok of ['payment.*', 'payment.received', 'repo.*', 'repo.push', 'repo.pull_request.*', 'repo.issue.opened', 'order.*', 'order.paid', '*']) {
      expect([ok, catalogCoversPattern(ok)]).toEqual([ok, true]);
    }
    for (const bad of ['payment.recieved', 'payment.received.*', 'repo.release', 'payment', 'repo.tag.*']) {
      expect([bad, catalogCoversPattern(bad)]).toEqual([bad, false]);
    }
    expect(parseConsoleEventTypes(['payment.*', 'order.*'])).toEqual(['payment.*', 'order.*']);
    const e = (() => { try { parseConsoleEventTypes(['payment.recieved']); return null; } catch (x) { return x as HttpException; } })();
    expect(e?.getStatus()).toBe(422);
    expect(e?.getResponse()).toMatchObject({ error: 'validation_failed', field: 'eventTypes', invalid: ['payment.recieved'] });
  });
});
