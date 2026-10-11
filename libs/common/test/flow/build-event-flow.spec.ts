import {
  attemptReason,
  buildEventFlow,
  classifySkippedSubscriptions,
  EventFlowInput,
  FlowDeliveryInput,
  FlowRawInput,
  FlowEventInput,
  limitBody,
  FLOW_BODY_MAX_BYTES,
  REASON_CODES,
  STAGE_STATUSES,
} from '../../src/flow';

const T0 = new Date('2026-10-10T10:02:37.120Z');
const at = (msAfter: number) => new Date(T0.getTime() + msAfter);

function raw(over: Partial<FlowRawInput> = {}): FlowRawInput {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    status: 'ACCEPTED',
    signatureValid: true,
    receivedAt: T0,
    provider: 'payos',
    sourceId: 'src-1',
    sourceName: 'PayOS chính',
    contentType: 'application/json',
    idempotencyKey: 'payos:123:abc',
    headers: { 'content-type': 'application/json', authorization: '[REDACTED]' },
    body: { code: '00', data: { orderCode: 123 } },
    bodyBytes: 40,
    normalizeProcessed: true,
    ...over,
  };
}

function event(over: Partial<FlowEventInput> = {}): FlowEventInput {
  return {
    id: '01JEVENT0000000000000000AA',
    type: 'payment.received',
    source: 'payos',
    subject: 'order/123',
    normalized: true,
    origin: 'webhook',
    correlationId: 'corr-1',
    receivedAt: at(40),
    data: { amount: 10000 },
    ...over,
  };
}

let seq = 0;
function delivery(over: Partial<FlowDeliveryInput> & { dest?: string; circuit?: 'CLOSED' | 'OPEN' | 'HALF_OPEN'; sub?: string } = {}): FlowDeliveryInput {
  seq++;
  const dest = over.dest ?? 'Shop';
  const { dest: _d, circuit, sub, ...rest } = over;
  return {
    id: `dlv-${seq}`,
    attemptGeneration: 1,
    status: 'SUCCEEDED',
    attemptCount: 1,
    nextAttemptAt: null,
    lastError: null,
    createdAt: at(45),
    updatedAt: at(140),
    subscription: { id: sub ?? `sub-${dest}`, name: `→ ${dest}`, eventTypes: ['payment.*'] },
    destination: { id: `dst-${dest}`, name: dest, type: 'webhook', circuitState: circuit ?? 'CLOSED', rateLimitRps: 0 },
    attempts: [{ attemptNo: 1, responseStatus: 200, durationMs: 84, error: null, responseBody: 'ok', createdAt: at(140) }],
    ...rest,
  };
}

const NOW = at(5 * 60_000);
const flow = (i: Partial<EventFlowInput>) => buildEventFlow({ raw: raw(), event: event(), deliveries: [], now: NOW, ...i });
const statusOf = (f: ReturnType<typeof flow>, key: string) => f.stages.find((s) => s.key === key)?.status;

describe('buildEventFlow — ánh xạ trạng thái DB → chặng', () => {
  it('[UI:F1-01] REJECTED: dừng ở verified (failed, signature_invalid), không có chặng sau, executionStatus=rejected', () => {
    const f = flow({ raw: raw({ status: 'REJECTED', signatureValid: false, normalizeProcessed: false }), event: null });
    expect(f.stages.map((s) => s.key)).toEqual(['received', 'verified']);
    expect(statusOf(f, 'verified')).toBe('failed');
    expect(f.stages[1].reason?.code).toBe('signature_invalid');
    expect(f.executionStatus).toBe('rejected');
    expect(f.failedAt).toEqual({ stage: 'verified', reason: f.stages[1].reason });
    expect(f.summary.map((d) => d.status)).toEqual(['ok', 'failed', 'skipped', 'skipped', 'skipped', 'skipped']);
  });

  it('[UI:F1-02] DUPLICATE: persisted = skipped (duplicate), dừng ở đó', () => {
    const f = flow({ raw: raw({ status: 'DUPLICATE' }), event: null });
    expect(f.stages.map((s) => s.key)).toEqual(['received', 'verified', 'persisted']);
    expect(statusOf(f, 'persisted')).toBe('skipped');
    expect(f.stages[2].reason?.code).toBe('duplicate');
    expect(f.summary[3].status).toBe('skipped');
  });

  it('[UI:F1-03] lỗi schema / DLQ normalize: ACCEPTED, không event, chưa processed, quá 120s → normalized failed + renormalize/open_dlq', () => {
    const f = flow({ raw: raw({ normalizeProcessed: false }), event: null, now: at(121_000) });
    const n = f.stages.find((s) => s.key === 'normalized')!;
    expect(n.status).toBe('failed');
    expect(n.reason?.code).toBe('normalize_dlq');
    expect(n.actions).toEqual(['renormalize', 'open_dlq']);
    expect(f.executionStatus).toBe('failed');
    expect(f.failedAt?.stage).toBe('normalized');
  });

  it('[UI:F1-04] ACCEPTED mới (< 120s) chưa có event → normalized in_progress, chặng sau pending', () => {
    const f = flow({ raw: raw({ normalizeProcessed: false }), event: null, now: at(3_000) });
    expect(statusOf(f, 'normalized')).toBe('in_progress');
    expect(f.executionStatus).toBe('in_progress');
    expect(f.summary.slice(4).map((d) => d.status)).toEqual(['pending', 'pending']);
  });

  it('[UI:F1-05] adapter chạy xong nhưng sinh 0 event → normalized skipped', () => {
    const f = flow({ raw: raw({ normalizeProcessed: true }), event: null });
    expect(statusOf(f, 'normalized')).toBe('skipped');
    expect(f.stages.find((s) => s.key === 'normalized')?.reason?.code).toBe('normalize_skipped');
  });

  it('[UI:F1-06] kiểu chưa ánh xạ (normalized=false) → warning unmapped_type', () => {
    const f = flow({ event: event({ normalized: false, type: 'github.ping' }), deliveries: [delivery()] });
    expect(statusOf(f, 'normalized')).toBe('warning');
    expect(f.stages.find((s) => s.key === 'normalized')?.reason?.code).toBe('unmapped_type');
  });

  it('[UI:F1-07] không subscription nào khớp → routed skipped (no_subscription), journey succeeded, dot giao skipped', () => {
    const f = flow({ deliveries: [] });
    const r = f.stages.find((s) => s.key === 'routed')!;
    expect(r.status).toBe('skipped');
    expect(r.reason?.code).toBe('no_subscription');
    expect(r.actions).toEqual(['open_config']);
    expect(f.executionStatus).toBe('succeeded');
    expect(f.summary[5]).toEqual({ stage: 'delivering', status: 'skipped', okCount: 0, total: 0 });
  });

  it('[KN:U16] (phần k) L-A1: event probe của provider → routed skipped với lý do provider_probe (cố ý, không phải no_subscription), không gợi ý sửa cấu hình', () => {
    const f = flow({ event: event({ type: 'payos.webhook_test', normalized: false, probe: true }), deliveries: [] });
    const r = f.stages.find((s) => s.key === 'routed')!;
    expect(r.status).toBe('skipped');
    expect(r.reason?.code).toBe('provider_probe');
    expect(r.reason?.message).toBe(REASON_CODES.provider_probe);
    expect(r.actions).toBeUndefined();
    expect(f.executionStatus).toBe('succeeded');
    expect(f.failedAt).toBeNull();
  });

  it('[KN:U16] (phần l) L-A1: probe thắng cả lý do subscription tắt (subscription bị bỏ vì là probe, không vì cấu hình)', () => {
    const f = flow({
      event: event({ type: 'payos.webhook_test', normalized: false, probe: true }),
      deliveries: [],
      skippedSubscriptions: [{ id: 's9', name: 'Tắt', eventTypes: ['*'], reason: 'subscription_inactive' }],
    });
    expect(f.stages.find((s) => s.key === 'routed')!.reason?.code).toBe('provider_probe');
  });

  it('L-A1: probe:false/undefined giữ hành vi cũ (no_subscription)', () => {
    const f = flow({ event: event({ probe: false }), deliveries: [] });
    expect(f.stages.find((s) => s.key === 'routed')!.reason?.code).toBe('no_subscription');
  });

  it('[UI:F1-08] subscription khớp nhưng tắt → routed skipped kèm subscription_inactive', () => {
    const f = flow({ skippedSubscriptions: [{ id: 's9', name: 'Tắt', eventTypes: ['payment.*'], reason: 'subscription_inactive' }] });
    const r = f.stages.find((s) => s.key === 'routed')!;
    expect(r.reason?.code).toBe('subscription_inactive');
    expect((r.detail?.skipped as unknown[]).length).toBe(1);
  });

  it('[UI:F1-09] 1 đích ok + 1 đích DEAD: hai nhánh, summary 1/2 failed, failedAt chỉ đích hỏng', () => {
    const ok = delivery({ dest: 'Shop' });
    const dead = delivery({
      dest: 'Discord',
      status: 'DEAD',
      attemptCount: 6,
      lastError: 'Hết 5 lần retry: 500',
      attempts: [1, 2, 3, 4, 5, 6].map((n) => ({ attemptNo: n, responseStatus: 500, durationMs: 12, error: null, createdAt: at(1000 * n) })),
    });
    const f = flow({ deliveries: [ok, dead] });
    expect(f.branches.map((b) => [b.destination.name, b.status])).toEqual([
      ['Discord', 'failed'],
      ['Shop', 'ok'],
    ]);
    expect(f.summary[5]).toEqual({ stage: 'delivering', status: 'failed', okCount: 1, total: 2 });
    expect(f.executionStatus).toBe('failed');
    expect(f.failedAt).toMatchObject({ stage: 'delivering', destinationName: 'Discord', attemptNo: 6, maxAttempts: 6, httpStatus: 500 });
    expect(f.failedAt?.reason.code).toBe('http_5xx');
    const done = f.branches[0].stages.at(-1)!;
    expect(done.reason?.code).toBe('max_attempts');
    expect(done.actions).toEqual(['replay_delivery', 'open_dlq']);
  });

  it('[UI:F1-10] RETRYING có next_attempt_at: done = warning, tầng 5m sau lần 3, giữ nextAttemptAt', () => {
    const next = at(6 * 60_000);
    const d = delivery({
      dest: 'Discord',
      status: 'RETRYING',
      attemptCount: 3,
      nextAttemptAt: next,
      attempts: [1, 2, 3].map((n) => ({ attemptNo: n, responseStatus: 500, durationMs: 9, error: null, createdAt: at(1000 * n) })),
    });
    const f = flow({ deliveries: [d] });
    const done = f.branches[0].stages.at(-1)!;
    expect(done.status).toBe('warning');
    expect(done.title).toBe('Chờ thử lại lần 4/6');
    expect(done.detail).toMatchObject({ tier: '5m', nextAttemptAt: next.toISOString(), overdue: false });
    expect(f.branches[0].stages.filter((s) => s.id.includes(':attempt:')).map((s) => s.status)).toEqual(['failed', 'failed', 'failed']);
    expect(f.branches[0].stages[3].detail?.nextTier).toBe('5m');
    expect(f.executionStatus).toBe('in_progress');
    expect(f.failedAt).toMatchObject({ stage: 'delivering', destinationName: 'Discord', attemptNo: 3 });
  });

  it('[UI:F1-11] DEAD vì 4xx non-retryable → lý do http_4xx, không phải max_attempts', () => {
    const d = delivery({
      status: 'DEAD',
      attemptCount: 1,
      attempts: [{ attemptNo: 1, responseStatus: 404, durationMs: 5, error: null, createdAt: at(100) }],
    });
    const done = flow({ deliveries: [d] }).branches[0].stages.at(-1)!;
    expect(done.reason?.code).toBe('http_4xx');
    expect(done.subtitle).toContain('4xx');
  });

  it('[UI:F1-12] circuit DEFERRED: PENDING có next_attempt_at → warning circuit_open; RETRYING + circuit OPEN cũng vậy', () => {
    const p = delivery({ status: 'PENDING', attemptCount: 0, attempts: [], nextAttemptAt: at(60_000), circuit: 'OPEN' });
    const done = flow({ deliveries: [p] }).branches[0].stages.at(-1)!;
    expect(done.status).toBe('warning');
    expect(done.reason?.code).toBe('circuit_open');
    const r = delivery({
      status: 'RETRYING',
      attemptCount: 1,
      nextAttemptAt: at(60_000),
      circuit: 'HALF_OPEN',
      attempts: [{ attemptNo: 1, responseStatus: 503, durationMs: 4, error: null, createdAt: at(100) }],
    });
    const f = flow({ deliveries: [r] });
    expect(f.branches[0].stages.at(-1)!.reason?.code).toBe('circuit_open');
    expect(f.failedAt?.reason.code).toBe('circuit_open');
  });

  it('[UI:F1-13] PENDING không hoãn → in_progress; DELIVERING → node attempt kế đang chạy', () => {
    const p = flow({ deliveries: [delivery({ status: 'PENDING', attemptCount: 0, attempts: [] })] });
    expect(p.branches[0].stages.at(-1)!.status).toBe('in_progress');
    const d = flow({ deliveries: [delivery({ status: 'DELIVERING', attemptCount: 1, attempts: [{ attemptNo: 1, responseStatus: 500, durationMs: 3, error: null, createdAt: at(50) }] })] });
    const ids = d.branches[0].stages.map((s) => `${s.id.split(':').slice(1).join(':')}=${s.status}`);
    expect(ids).toEqual(['queued=ok', 'attempt:1=failed', 'attempt:2=in_progress', 'done=in_progress']);
  });

  it('[UI:F1-14] replay: nhánh hiện generation mới nhất, generation cũ gập vào history', () => {
    const g1 = delivery({ id: 'g1', sub: 'S', status: 'DEAD', attemptGeneration: 1, attemptCount: 6 });
    const g3 = delivery({ id: 'g3', sub: 'S', status: 'SUCCEEDED', attemptGeneration: 3 });
    const g2 = delivery({ id: 'g2', sub: 'S', status: 'DEAD', attemptGeneration: 2, attemptCount: 1 });
    const f = flow({ deliveries: [g1, g3, g2] });
    expect(f.branches).toHaveLength(1);
    expect(f.branches[0].deliveryId).toBe('g3');
    expect(f.branches[0].generation).toBe(3);
    expect(f.branches[0].history.map((h) => h.generation)).toEqual([2, 1]);
    expect(f.executionStatus).toBe('succeeded');
  });

  it('[UI:F1-15] thành công trọn vẹn: mọi chặng ok, offset +ms tính từ lúc nhận', () => {
    const f = flow({ deliveries: [delivery()] });
    expect(f.stages.map((s) => `${s.key}=${s.status}`)).toEqual([
      'received=ok',
      'verified=ok',
      'persisted=ok',
      'normalized=ok',
      'routed=ok',
    ]);
    expect(f.stages.find((s) => s.key === 'normalized')?.offsetMs).toBe(45); // = created_at delivery đầu (cùng tx normalize+route)
    expect(f.stages.find((s) => s.key === 'routed')?.offsetMs).toBe(45);
    const attempt = f.branches[0].stages[1];
    expect(attempt).toMatchObject({ offsetMs: 140, durationMs: 84, status: 'ok' });
    expect(attempt.startedAt).toBe(at(56).toISOString());
    expect(f.executionStatus).toBe('succeeded');
    expect(f.failedAt).toBeNull();
    expect(f.summary.every((d) => d.status === 'ok')).toBe(true);
  });

  it('[UI:F1-16] header meta mẫu rejected tách khỏi headers; body > 16KB bị cắt kèm cờ truncated', () => {
    const big = { blob: 'x'.repeat(FLOW_BODY_MAX_BYTES + 100) };
    const f = flow({ raw: raw({ headers: { a: '1', __hub_meta: { bodyTruncated: true } }, body: big }) });
    const d = f.stages[0].detail!;
    expect(d.headers).toEqual({ a: '1' });
    expect(d.rejectedSample).toEqual({ bodyTruncated: true });
    expect(d.bodyTruncated).toBe(true);
    expect(typeof d.body).toBe('string');
    expect(Buffer.byteLength(d.body as string)).toBeLessThanOrEqual(FLOW_BODY_MAX_BYTES);
    expect(limitBody({ a: 1 })).toEqual({ value: { a: 1 }, truncated: false, bytes: 7 });
    expect(limitBody('ứ'.repeat(10_000)).truncated).toBe(true);
  });

  it('[UI:F1-17] attemptReason: mỗi kiểu lỗi ra đúng một mã', () => {
    const code = (responseStatus: number | null, error: string | null = null) => attemptReason({ responseStatus, error })?.code ?? null;
    expect(code(200)).toBeNull();
    expect(code(204)).toBeNull();
    expect(code(500)).toBe('http_5xx');
    expect(code(503)).toBe('http_5xx');
    expect(code(404)).toBe('http_4xx');
    expect(code(408)).toBe('http_408');
    expect(code(429)).toBe('http_429');
    expect(code(0, 'The operation was aborted due to timeout')).toBe('timeout');
    expect(code(0, 'ECONNREFUSED')).toBe('network_error');
    expect(code(0, 'circuit OPEN quá lâu: đã hoãn 30 lần')).toBe('circuit_open');
  });

  it('[UI:F1-18] mọi reason/status dùng trong kết quả thuộc catalog (không có chuỗi tự do)', () => {
    const cases: Partial<EventFlowInput>[] = [
      { raw: raw({ status: 'REJECTED', signatureValid: false }), event: null },
      { raw: raw({ normalizeProcessed: false }), event: null, now: at(500_000) },
      { deliveries: [delivery({ status: 'DEAD', attemptCount: 1, attempts: [{ attemptNo: 1, responseStatus: 400, durationMs: 1, error: null, createdAt: at(9) }] })] },
      { deliveries: [delivery({ status: 'RETRYING', attemptCount: 1, nextAttemptAt: at(1), attempts: [{ attemptNo: 1, responseStatus: 0, durationMs: 1, error: 'ECONNRESET', createdAt: at(9) }] })] },
    ];
    for (const c of cases) {
      const f = flow(c);
      for (const s of [...f.stages, ...f.branches.flatMap((b) => b.stages)]) {
        expect(STAGE_STATUSES).toContain(s.status);
        if (s.reason) expect(Object.keys(REASON_CODES)).toContain(s.reason.code);
      }
    }
  });

  it('[UI:F1-25] routed tính lúc đọc (§6A): khớp type mà không có delivery → lý do tắt / chưa xác minh / lọc source', () => {
    const candidates = [
      { id: 'delivered', name: 'đã gửi', eventTypes: ['payment.*'], isActive: true },
      { id: 'off', name: 'tắt', eventTypes: ['payment.*'], isActive: false, destinationVerification: 'PENDING' as const },
      { id: 'unverified', name: 'chưa xác minh', eventTypes: ['payment.*'], isActive: true, destinationVerification: 'FAILED' as const },
      { id: 'filtered', name: 'lọc', eventTypes: ['*'], isActive: true, sourceIds: ['src-other'], destinationVerification: 'VERIFIED' as const },
      { id: 'mine', name: 'đúng source', eventTypes: ['*'], isActive: true, sourceIds: ['src-1'] },
      { id: 'legacy', name: 'chưa có cột đa service', eventTypes: ['*'], isActive: true },
    ];
    const skipped = classifySkippedSubscriptions(candidates, ['delivered'], 'src-1');
    expect(skipped.map((s) => [s.id, s.reason])).toEqual([
      ['off', 'subscription_inactive'],
      ['unverified', 'endpoint_unverified'],
      ['filtered', 'source_filtered'],
    ]);
    const f = flow({ deliveries: [], skippedSubscriptions: skipped });
    const r = f.stages.find((s) => s.key === 'routed')!;
    expect(r.status).toBe('skipped');
    expect(r.detail?.skippedBasis).toBe('trạng thái hiện tại');
    expect((r.detail?.skipped as { reason: { code: string } }[]).map((s) => s.reason.code)).toEqual([
      'subscription_inactive',
      'endpoint_unverified',
      'source_filtered',
    ]);
  });

  it('[UI:F1-26] nguồn api (đa service) xác thực bằng API key — tiêu đề không ghi "chữ ký"', () => {
    const f = flow({ raw: raw({ provider: 'api' }) });
    expect(f.stages[1].title).toBe('API key hợp lệ');
    expect(f.stages[0].title).toContain('/events');
    expect(flow({}).stages[1].title).toBe('Chữ ký PayOS hợp lệ');
  });

  it('[UI:F1-19] event không có raw (origin khác webhook): vẫn dựng normalize → routed', () => {
    const f = buildEventFlow({ raw: null, event: event({ origin: 'reconciliation' }), deliveries: [delivery()], now: NOW });
    expect(f.stages.map((s) => s.key)).toEqual(['normalized', 'routed']);
    expect(f.summary.slice(0, 3).map((d) => d.status)).toEqual(['pending', 'pending', 'pending']);
  });
});
