import { HttpException } from '@nestjs/common';
import { ServiceResourcesController } from '../src/modules/service-api/service-resources.controller';

/** S7 (SPEC §4.5): tham số GET /v1/p/:project/events — sai -> 422 có tên trường; endpointId khác project -> 404. */
describe('GET /v1/p/:project/events — tham số (S7)', () => {
  const PA = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const EA = '11111111-1111-1111-1111-111111111111';
  function setup(rows: any[] = [], readTypes: string[] = []) {
    const pollEvents = jest.fn().mockResolvedValue(rows);
    const findDestinationById = jest.fn(async (id: string) => (id === EA ? { id: EA, type: 'webhook', createdByKeyId: 'k' } : null));
    const prisma: any = { forTenant: jest.fn(() => ({ pollEvents, findDestinationById })) };
    const ctrl = new ServiceResourcesController(prisma, {} as any);
    const req: any = { tenantId: PA, apiKey: { id: 'k', tenantId: PA, readTypes } };
    const res: any = { on: jest.fn(), writableEnded: false };
    const call = async (q: Record<string, string>) => {
      try {
        return { status: 200, body: await ctrl.pollEvents(req, res, q) };
      } catch (e) {
        if (e instanceof HttpException) return { status: e.getStatus(), body: e.getResponse() as any };
        throw e;
      }
    };
    return { call, pollEvents };
  }

  it('[MS:U25] (phần b) cursor ra JSON là CHUỖI, nextCursor = cursor cuối; rỗng -> giữ nguyên after', async () => {
    // R2-3 (ADR-099): trường là `cursor` (poll_seq, thứ tự COMMIT) — KHÔNG phải `seq` (events.seq của dashboard)
    const { call } = setup([{ id: 'e2', cursor: 2n }, { id: 'e3', cursor: 3n }]);
    const r = await call({ after: '1' });
    expect(r.body).toEqual({ events: [{ id: 'e2', cursor: '2' }, { id: 'e3', cursor: '3' }], nextCursor: '3' });
    expect(r.body.events[0]).not.toHaveProperty('seq');
    expect((await setup([]).call({ after: '42' })).body).toEqual({ events: [], nextCursor: '42' });
    expect((await setup([]).call({})).body).toEqual({ events: [], nextCursor: '0' });
  });

  it('R3-2: thông điệp 422 của after nói `cursor` (không phải seq của dashboard)', async () => {
    const r = await setup().call({ after: 'abc' });
    expect(r.body.message).toMatch(/cursor/);
    expect(r.body.message).not.toMatch(/seq/);
  });

  it('S7: tham số sai -> 422 field (after, limit, types, status, wait)', async () => {
    const { call } = setup();
    for (const [q, field] of [
      [{ after: '-1' }, 'after'],
      [{ after: 'abc' }, 'after'],
      [{ limit: '0' }, 'limit'],
      [{ limit: '101' }, 'limit'],
      [{ types: 'payment.*,*.paid' }, 'types'],
      [{ status: 'dead' }, 'status'],
      [{ wait: '21' }, 'wait'],
      [{ wait: '1.5' }, 'wait'],
    ] as [Record<string, string>, string][]) {
      const r = await call(q);
      expect([q, r.status, r.body.field]).toEqual([q, 422, field]);
    }
  });

  it('S7: types giao readTypes của key; status=failed + endpointId của mình -> truyền xuống repo; endpoint lạ -> 404', async () => {
    const { call, pollEvents } = setup([], ['payment.*']);
    await call({ after: '5', limit: '10', types: 'payment.*,repo.push', status: 'failed', endpointId: EA });
    expect(pollEvents).toHaveBeenCalledWith({ after: 5n, limit: 10, types: ['payment.*', 'repo.push'], readTypes: ['payment.*'], failedOnly: true, endpointId: EA });
    expect(await call({ status: 'failed', endpointId: '22222222-2222-2222-2222-222222222222' })).toEqual({ status: 404, body: { error: 'not_found' } });
    expect(await call({ endpointId: 'x' })).toEqual({ status: 404, body: { error: 'not_found' } });
  });
});

describe('GET /api/v1/events — before/after của dashboard (S7, X11, ADR-077)', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { ApiController } = require('../src/modules/api/api.controller');
  function setup() {
    const repo = {
      findEvents: jest.fn().mockResolvedValue([{ id: 'e9' }]),
      findEventsAfterSeq: jest.fn().mockResolvedValue([{ id: 'e2', seq: 2n }, { id: 'e3', seq: 3n }]),
    };
    return { ctrl: new ApiController({ forTenant: () => repo } as any), repo };
  }
  it('after=<seq> -> tăng dần theo seq, nextCursor = seq cuối (chuỗi)', async () => {
    const { ctrl, repo } = setup();
    expect(await ctrl.listEvents('t', '1', '50')).toMatchObject({ nextCursor: '3' });
    expect(repo.findEventsAfterSeq).toHaveBeenCalledWith(1n, 50);
  });
  it('before=<id> và after không phải số (client cũ) -> trang cũ hơn, giảm dần như trước', async () => {
    const { ctrl, repo } = setup();
    await ctrl.listEvents('t', undefined, '10', 'e5');
    await ctrl.listEvents('t', '01J9ZKABCDEF', '10');
    expect(repo.findEvents.mock.calls).toEqual([[{}, 10, 'e5'], [{}, 10, '01J9ZKABCDEF']]);
    expect(repo.findEventsAfterSeq).not.toHaveBeenCalled();
  });
});
