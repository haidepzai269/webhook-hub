import { FlowService } from '../src/modules/flow/flow.service';

/**
 * L-A1 (REVIEW-KQ1-FLOWUI): hành trình console của event probe (ADR-159) phải nói lý do CỐ Ý `provider_probe`,
 * không phải `no_subscription` — dù subscription `*` đang bật. FlowService chỉ chuyển cờ chung `events.probe`
 * (không biết provider nào, BB-1). Repo giả: chỉ kiểm phần ghép input, không chạm DB.
 */
describe('FlowService.getEventFlow — event probe', () => {
  const EVENT_ID = '01JPROBE000000000000000000';
  function serviceWith(probe: boolean | undefined) {
    const svc = new FlowService({} as never);
    const event = {
      id: EVENT_ID,
      type: 'payos.webhook_test',
      source: 'payos',
      subject: null,
      normalized: false,
      origin: 'webhook',
      correlationId: 'corr-probe',
      receivedAt: new Date('2026-10-12T00:00:00Z'),
      createdAt: new Date('2026-10-12T00:00:00Z'),
      occurredAt: null,
      data: { raw: {} },
      rawEventId: null,
      sourceId: 'src-1',
      deliveries: [],
      ...(probe === undefined ? {} : { probe }),
    };
    const repo = {
      findRawEventForFlow: jest.fn().mockResolvedValue(null),
      findEventForFlow: jest.fn().mockResolvedValue(event),
      // Subscription `*` đang bật, endpoint đã xác minh — với event thường đây sẽ là no_subscription (không lý do bỏ qua).
      findSubscriptionsMatching: jest
        .fn()
        .mockResolvedValue([{ id: 'sub-all', name: 'Mọi sự kiện', eventTypes: ['*'], isActive: true, sourceIds: [], destination: { verification: 'VERIFIED' } }]),
    };
    jest.spyOn(svc, 'repo').mockReturnValue(repo as never);
    return svc;
  }
  const routed = (f: { flow?: { stages: { key: string; reason?: { code: string } }[] }; stages?: { key: string; reason?: { code: string } }[] }) =>
    (f.flow?.stages ?? f.stages ?? []).find((s) => s.key === 'routed');

  it('[KN:U16] probe=true → routed.reason = provider_probe', async () => {
    const f: any = await serviceWith(true).getEventFlow('t-1', EVENT_ID);
    expect(routed(f)?.reason?.code).toBe('provider_probe');
  });

  it('event thường (probe=false) → vẫn no_subscription như cũ', async () => {
    const f: any = await serviceWith(false).getEventFlow('t-1', EVENT_ID);
    expect(routed(f)?.reason?.code).toBe('no_subscription');
  });
});
