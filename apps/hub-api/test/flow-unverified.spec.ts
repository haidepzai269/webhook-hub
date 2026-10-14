import { FlowService } from '../src/modules/flow/flow.service';

/**
 * REVIEW-PK5 TB-1 (khoá 2 + khoá 4, ADR-206): FlowService chuyển cờ `verified` của raw/event vào `buildEventFlow` và vào
 * khuôn trả về — console không bao giờ ghi "hợp lệ" cho sự kiện của nguồn `unverified`, và subscription bị router bỏ qua
 * vì chưa bật `acceptUnverified` có lý do riêng. Repo giả: chỉ kiểm phần ghép input, không chạm DB.
 */
const EVENT_ID = '01JUNVER00000000000000000A';
const RAW_ID = '44444444-4444-4444-8444-444444444444';

function serviceWith(verified: boolean) {
  const svc = new FlowService({} as never);
  const raw = {
    id: RAW_ID,
    status: 'ACCEPTED',
    signatureValid: true,
    receivedAt: new Date('2026-10-14T00:00:00Z'),
    contentType: 'application/json',
    idempotencyKey: 'generic:abc',
    headers: {},
    body: {},
    bodyBytes: 2,
    sourceId: 'src-momo',
    sourceName: 'MoMo',
    provider: 'generic',
    normalizeProcessed: true,
    verified,
  };
  const event = {
    id: EVENT_ID,
    type: 'momo.ipn',
    source: 'generic',
    subject: null,
    normalized: true,
    origin: 'webhook',
    correlationId: 'corr-1',
    receivedAt: raw.receivedAt,
    createdAt: raw.receivedAt,
    occurredAt: null,
    data: { raw: 'e30=' },
    rawEventId: RAW_ID,
    sourceId: 'src-momo',
    verified,
    deliveries: [],
  };
  const repo = {
    findRawEventForFlow: jest.fn().mockResolvedValue(raw),
    findEventForFlow: jest.fn().mockResolvedValue(event),
    findSubscriptionsMatching: jest
      .fn()
      .mockResolvedValue([
        { id: 'sub-shop', name: 'Shop', eventTypes: ['*'], isActive: true, sourceIds: [], acceptUnverified: false, destination: { verification: 'VERIFIED', isActive: true } },
      ]),
  };
  jest.spyOn(svc, 'repo').mockReturnValue(repo as never);
  return svc;
}

const stage = (f: { stages: { key: string; status: string; title: string; reason?: { code: string } }[] }, key: string) =>
  f.stages.find((s) => s.key === key)!;

describe('FlowService — sự kiện chưa xác thực (REVIEW-PK5 TB-1)', () => {
  it('[PK:T16] (phần g) chi tiết: chặng Xác thực warning "Chưa xác thực", event/raw mang verified=false, routed = unverified_not_accepted', async () => {
    const f: any = await serviceWith(false).getEventFlow('t-1', RAW_ID);
    const v = stage(f, 'verified');
    expect(v.status).toBe('warning');
    expect(v.title).not.toMatch(/hợp lệ/);
    expect(v.reason?.code).toBe('unverified_source');
    expect(f.event.verified).toBe(false);
    expect(f.raw.verified).toBe(false);
    expect(stage(f, 'routed').reason?.code).toBe('unverified_not_accepted');
  });

  it('[PK:T16] (phần h) event đã xác thực: như cũ — "hợp lệ", verified=true, không có lý do unverified_not_accepted', async () => {
    const f: any = await serviceWith(true).getEventFlow('t-1', RAW_ID);
    expect(stage(f, 'verified').status).toBe('ok');
    expect(f.event.verified).toBe(true);
    expect(stage(f, 'routed').reason?.code).toBe('no_subscription');
  });

  it('[PK:T16] (phần i) danh sách: chấm Xác thực của đường ống mini là warning, dòng mang verified=false', async () => {
    const r = {
      cursorAt: '2026-10-14T00:00:00.000000',
      cursorKey: 'k1',
      at: new Date('2026-10-14T00:00:00Z'),
      rawId: RAW_ID,
      rawStatus: 'ACCEPTED',
      signatureValid: true,
      sourceId: 'src-momo',
      sourceName: 'MoMo',
      provider: 'generic',
      processed: true,
      eventId: EVENT_ID,
      type: 'momo.ipn',
      subject: null,
      normalized: true,
      origin: 'webhook',
      eventAt: new Date('2026-10-14T00:00:00Z'),
      probe: false,
      verified: false,
      deliveries: [],
    };
    const findExecutions = jest.fn(async () => [r]);
    const svc = new FlowService({ forTenant: () => ({ extend: () => ({ findExecutions }) }) } as never);
    const { items } = await svc.listExecutions('00000000-0000-0000-0000-0000000000bb', {});
    expect(items[0].verified).toBe(false);
    expect(items[0].summary.find((d) => d.stage === 'verified')?.status).toBe('warning');
  });
});
