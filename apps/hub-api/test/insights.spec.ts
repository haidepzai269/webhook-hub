import { HttpException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { ProjectScopeGuard } from '../src/modules/console/project-scope.guard';
import { SessionGuard } from '../src/modules/auth/session.guard';
import { REQUIRE_SCOPE_KEY } from '../src/modules/service-api/require-scope.decorator';
import { InsightsController } from '../src/modules/insights/insights.controller';
import { DuplicateCounter } from '../src/modules/ingest/duplicate-counter';
import { getInsights, parseInsightCodes } from '../src/modules/insights/insights-api';


describe('CB6 bộ đếm bản trùng (ADR-171) — trong bộ nhớ, ghi theo lô', () => {
  it('record() không I/O; flush gom theo (project, source, giờ) thành MỘT lời gọi mỗi project', async () => {
    const sink = jest.fn().mockResolvedValue(1);
    let t = Date.parse('2026-10-12T08:59:59.000Z');
    const c = new DuplicateCounter(sink, 0, () => t);
    c.record('A', 's1');
    c.record('A', 's1');
    c.record('B', 's9');
    t += 2000; // sang giờ mới -> bucket khác
    c.record('A', 's1');
    expect(sink).not.toHaveBeenCalled();
    expect(c.pendingCount()).toBe(4);
    await c.flush();
    expect(sink).toHaveBeenCalledTimes(2);
    const a = sink.mock.calls.find((x) => x[0] === 'A')![1];
    expect(a).toEqual([
      { sourceId: 's1', bucket: new Date('2026-10-12T08:00:00.000Z'), n: 2 },
      { sourceId: 's1', bucket: new Date('2026-10-12T09:00:00.000Z'), n: 1 },
    ]);
    expect(sink.mock.calls.find((x) => x[0] === 'B')![1]).toEqual([{ sourceId: 's9', bucket: new Date('2026-10-12T08:00:00.000Z'), n: 1 }]);
    expect(c.pendingCount()).toBe(0);
  });

  it('ghi lỗi (Postgres chết) -> giữ số lại, lượt sau cộng dồn; ACK không bao giờ chờ bộ đếm', async () => {
    const sink = jest.fn().mockRejectedValueOnce(new Error('db down')).mockResolvedValue(1);
    const c = new DuplicateCounter(sink, 0, () => Date.parse('2026-10-12T08:10:00.000Z'));
    c.record('A', 's1');
    await c.flush();
    expect(c.pendingCount()).toBe(1);
    c.record('A', 's1');
    await c.close();
    expect(sink).toHaveBeenLastCalledWith('A', [{ sourceId: 's1', bucket: new Date('2026-10-12T08:00:00.000Z'), n: 2 }]);
    expect(c.pendingCount()).toBe(0);
  });

  it('timer: một bản trùng hẹn MỘT lượt ghi sau chu kỳ; không có bản trùng thì không có timer', async () => {
    jest.useFakeTimers();
    try {
      const sink = jest.fn().mockResolvedValue(1);
      const c = new DuplicateCounter(sink, 5000);
      jest.advanceTimersByTime(60_000);
      expect(sink).not.toHaveBeenCalled();
      c.record('A', 's1');
      c.record('A', 's1');
      jest.advanceTimersByTime(4999);
      expect(sink).not.toHaveBeenCalled();
      jest.advanceTimersByTime(1);
      await Promise.resolve();
      expect(sink).toHaveBeenCalledTimes(1);
      expect(sink.mock.calls[0][1][0].n).toBe(2);
      await c.close();
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('CB6 GET /projects/:p/insights — logic (store giả)', () => {
  it('codes: mặc định cả bốn; lọc + bỏ trùng; mã lạ / mảng -> 400 khuôn lỗi', () => {
    expect(parseInsightCodes(undefined)).toEqual(['I-dest', 'I-dup', 'I-silent', 'I-dead']);
    expect(parseInsightCodes({ codes: 'I-dead, I-dup,I-dead' })).toEqual(['I-dead', 'I-dup']);
    expect(() => parseInsightCodes({ codes: 'I-latency' })).toThrow(HttpException);
    expect(() => parseInsightCodes({ codes: ['I-dup', 'I-dead'] as any })).toThrow(HttpException);
  });

  it('chỉ chạy truy vấn của mã được xin, mọi truy vấn qua forTenant(projectId của path); Ngắt/lưu trữ không có nhận định', async () => {
    const repo = {
      countIngestDuplicatesToday: jest.fn().mockResolvedValue({ since: new Date('2026-10-11T17:00:00Z'), byProvider: [{ provider: 'payos', n: 3 }] }),
      countDlqForInsight: jest.fn().mockResolvedValue({ total: 5, recent: 2, capped: false }),
      findAlertDestinations: jest.fn().mockResolvedValue([
        { id: 'd-live', isActive: true, archivedAt: null, circuitState: 'CLOSED' },
        { id: 'd-off', isActive: false, archivedAt: null, circuitState: 'CLOSED' },
      ]),
      countAttemptStatusesByDestination: jest.fn().mockResolvedValue([{ destinationId: 'd-live', status: 401, n: 3 }]),
      findRecentAttemptsByDestination: jest.fn().mockResolvedValue([{ destinationId: 'd-live', status: 401, at: new Date() }]),
      findAlertSources: jest.fn().mockResolvedValue([]),
      findSourceActivity: jest.fn(),
    };
    const store = { forTenant: jest.fn().mockReturnValue(repo) };
    const P = '11111111-1111-4111-8111-111111111111';

    const overview = await getInsights(store as any, P, { codes: 'I-dup,I-dead' });
    expect(store.forTenant).toHaveBeenCalledWith(P);
    expect(overview.map((i) => i.code)).toEqual(['I-dup', 'I-dead']);
    expect(overview[1]).toMatchObject({ facts: { total: 5, recent: 2 }, actions: [{ code: 'open_dlq' }] });
    expect(repo.findAlertDestinations).not.toHaveBeenCalled();

    const dests = await getInsights(store as any, P, { codes: 'I-dest,I-silent' });
    expect(dests).toHaveLength(1);
    expect(dests[0]).toMatchObject({ code: 'I-dest', subjectId: 'd-live', level: 'critical', facts: { health: 'auth_rejected', total: 3 } });
    expect(repo.findSourceActivity).not.toHaveBeenCalled(); // không source nào còn dùng -> không truy vấn nhịp
    expect(repo.countIngestDuplicatesToday).toHaveBeenCalledTimes(1);
  });
});

describe('CB6 phạm vi project của /api/v1/projects/:projectId/insights', () => {
  const A = '0a6b5c1e-1111-4111-8111-aaaaaaaaaaaa';
  const B = '0b6b5c1e-2222-4222-8222-bbbbbbbbbbbb';

  it('SessionGuard + ProjectScopeGuard, scope read:project (thành viên thường xem được — không chỉ operator)', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, InsightsController)).toEqual([SessionGuard, ProjectScopeGuard]);
    expect(Reflect.getMetadata(REQUIRE_SCOPE_KEY, InsightsController.prototype.list)).toBe('read:project');
  });

  it('thành viên của A gọi insights của B -> 404 (cùng body "không tồn tại"), handler không chạy; gọi A -> qua, handler đọc đúng A', async () => {
    const prisma: any = {
      findProjectById: async (id: string) => ({ id }),
      identity: () => ({ findMembershipRole: async (_u: string, p: string) => (p === A ? 'viewer' : null) }),
    };
    const guard = new ProjectScopeGuard(prisma, new Reflector());
    const ctx = (projectId: string, req: any) =>
      ({ switchToHttp: () => ({ getRequest: () => req }), getHandler: () => InsightsController.prototype.list, getClass: () => InsightsController }) as any;
    const user = { kind: 'user', id: 'u1', sessionId: 's', email: 'a@b.vn', name: 'A', isOperator: false, emailVerified: true };

    const reqB: any = { params: { projectId: B }, query: {}, principal: { ...user } };
    await expect(guard.canActivate(ctx(B, reqB))).rejects.toMatchObject({ status: 404, response: { error: 'not_found' } });

    const reqA: any = { params: { projectId: A }, query: {}, principal: { ...user } };
    await expect(guard.canActivate(ctx(A, reqA))).resolves.toBe(true);
    expect(reqA.tenantId).toBe(A);

    const repo = { countIngestDuplicatesToday: jest.fn().mockResolvedValue({ since: new Date(), byProvider: [] }) };
    const forTenant = jest.fn().mockReturnValue(repo);
    const out = await new InsightsController({ forTenant } as any).list(A, { codes: 'I-dup' });
    expect(forTenant.mock.calls).toEqual([[A]]);
    expect(out[0]).toMatchObject({ code: 'I-dup', subjectId: A });
  });
});
