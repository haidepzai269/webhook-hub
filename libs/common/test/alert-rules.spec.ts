import {
  ALERT_RULES,
  ALERT_RULE_CODES,
  AUTH_REJECTED_MIN_STREAK,
  AUTH_REJECTED_WINDOW_MS,
  AttemptSample,
  BACKLOG_MIN,
  CALM_MIN_SPACING_MS,
  CONNECTION_PENDING_STUCK_MS,
  CLIENT_ERROR_MIN_STREAK,
  DEAD_SPIKE_MIN,
  DEFAULT_EMAIL_RULES,
  FAILING_MIN_ATTEMPTS,
  RuleContext,
  SIGNATURE_MIN_INVALID,
  SILENT_GAP_MULTIPLIER,
  SILENT_MIN_BASELINE_EVENTS,
  SILENT_MIN_GAP_MS,
  STREAK_QUIET_CLOSE_MS,
  SubjectLifecycle,
  countsTowardDeadSpike,
  evalAuthRejected,
  evalCircuitOpen,
  evalClientError,
  evalConnectionBroken,
  evalDeadSpike,
  evalDestinationFailing,
  evalNormalizeBacklog,
  evalSignatureFailing,
  evalSourceSilent,
  silenceThresholdMs,
} from '../src/alerts/rules';

/**
 * CB:T1 (SPEC-canh-bao-nhan-dinh §10): mỗi luật §4 — ngay dưới ngưỡng không mở; ngay trên ngưỡng mở; điều kiện đóng thì
 * đóng. Hàm thuần, `now` tiêm vào.
 */
const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = new Date('2026-10-12T07:00:00.000Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const LIVE: SubjectLifecycle = { isActive: true, archivedAt: null };
const fresh: RuleContext = { now: NOW, current: null };
const openWith = (facts: Record<string, unknown> = {}, openedAt = ago(HOUR), now = NOW): RuleContext => ({ now, current: { openedAt, facts } });
const LATER = new Date(NOW.getTime() + CALM_MIN_SPACING_MS);
/** n attempt cùng status, mới nhất trước, cách nhau 1 phút, mới nhất cách now 1 phút. */
const attempts = (statuses: (number | null)[]): AttemptSample[] => statuses.map((status, i) => ({ status, at: ago((i + 1) * MIN) }));

describe('CB1 luật cảnh báo (libs/common/src/alerts/rules.ts)', () => {
  it('danh mục: 9 luật §4, mức + loại đối tượng; email mặc định = mọi critical', () => {
    expect(ALERT_RULE_CODES).toHaveLength(9);
    expect(ALERT_RULES['destination.auth_rejected']).toEqual({ severity: 'critical', subjectType: 'destination' });
    expect(ALERT_RULES['delivery.dead_spike'].subjectType).toBe('project');
    expect(DEFAULT_EMAIL_RULES.sort()).toEqual(['delivery.dead_spike', 'destination.auth_rejected', 'source.connection_broken', 'source.signature_failing']);
  });

  it('[CB:T1] (phần a) destination.auth_rejected: 2×401 không mở, 3× (401/403 trộn) mở kèm facts; ngoài 30 phút / bị chuỗi cắt không tính; đóng khi 2xx hoặc 30 phút im', () => {
    expect(AUTH_REJECTED_MIN_STREAK).toBe(3);
    expect(evalAuthRejected({ destination: LIVE, attempts: attempts([401, 401]), dead: 2 }, fresh).open).toBe(false);
    expect(evalAuthRejected({ destination: LIVE, attempts: attempts([401, 401, 200, 401]), dead: 2 }, fresh).open).toBe(false);
    const d = evalAuthRejected({ destination: LIVE, attempts: attempts([401, 403, 401, 500]), dead: 3 }, fresh);
    expect(d.open).toBe(true);
    expect(d.facts).toMatchObject({ count: 3, httpStatus: 401, dead: 3, sinceAt: ago(3 * MIN).toISOString(), lastAttemptAt: ago(MIN).toISOString() });
    // attempt thứ 3 nằm NGOÀI cửa sổ 30 phút -> chỉ 2 trong cửa sổ
    const old: AttemptSample[] = [{ status: 401, at: ago(MIN) }, { status: 401, at: ago(2 * MIN) }, { status: 401, at: ago(AUTH_REJECTED_WINDOW_MS + MIN) }];
    expect(evalAuthRejected({ destination: LIVE, attempts: old, dead: 0 }, fresh).open).toBe(false);
    // 404/408/429/500 không phải auth
    expect(evalAuthRejected({ destination: LIVE, attempts: attempts([404, 404, 404]), dead: 3 }, fresh).open).toBe(false);

    // đang mở: 500 xen giữa -> giữ mở; 2xx -> đóng; 30 phút không attempt mới -> đóng; ngay dưới 30 phút -> giữ
    const cur = openWith({ count: 3, httpStatus: 401 });
    expect(evalAuthRejected({ destination: LIVE, attempts: attempts([500, 401, 401]), dead: 3 }, cur).open).toBe(true);
    expect(evalAuthRejected({ destination: LIVE, attempts: attempts([200, 401, 401]), dead: 3 }, cur).open).toBe(false);
    expect(evalAuthRejected({ destination: LIVE, attempts: [{ status: 401, at: ago(STREAK_QUIET_CLOSE_MS) }], dead: 3 }, cur).open).toBe(false);
    expect(evalAuthRejected({ destination: LIVE, attempts: [{ status: 401, at: ago(STREAK_QUIET_CLOSE_MS - 1) }], dead: 3 }, cur).open).toBe(true);
    expect(evalAuthRejected({ destination: LIVE, attempts: [], dead: 0 }, cur).open).toBe(false);

    // TB1: 401×3 → 200 → 500 ĐÓNG (có 2xx mới hơn mốc lastAttemptAt), dù attempt mới nhất là 500
    const opened = evalAuthRejected({ destination: LIVE, attempts: attempts([401, 401, 401]), dead: 3 }, fresh);
    const seq: AttemptSample[] = [{ status: 500, at: ago(MIN / 4) }, { status: 200, at: ago(MIN / 2) }, ...attempts([401, 401, 401])];
    expect(evalAuthRejected({ destination: LIVE, attempts: seq, dead: 3 }, openWith(opened.facts))).toMatchObject({ open: false, facts: { httpStatus: 200 } });
    // Re-review: 200 → 401×3 (mới nhất là 401) GIỮ MỞ — chuỗi đủ ngưỡng đến sau 2xx, không đóng rồi mở lại (flapping)
    const okThenStreak: AttemptSample[] = [...attempts([401, 401, 401]), { status: 200, at: ago(4 * MIN) }];
    expect(evalAuthRejected({ destination: LIVE, attempts: okThenStreak, dead: 3 }, openWith({ lastAttemptAt: ago(5 * MIN).toISOString() })).open).toBe(true);
    // 2xx CŨ hơn mốc đã xét không đóng lại lần nữa
    const oldOk: AttemptSample[] = [{ status: 500, at: ago(MIN / 4) }, { status: 401, at: ago(MIN / 2) }, { status: 200, at: ago(40 * MIN) }];
    expect(evalAuthRejected({ destination: LIVE, attempts: oldOk, dead: 3 }, openWith({ lastAttemptAt: ago(MIN / 2).toISOString() })).open).toBe(true);
    // TB1: im = 30 phút không có attempt CÙNG LOẠI — 500 liên tục không giữ mở cảnh báo 401 cũ
    const only500: AttemptSample[] = [{ status: 500, at: ago(MIN) }, { status: 500, at: ago(5 * MIN) }];
    expect(evalAuthRejected({ destination: LIVE, attempts: only500, dead: 3 }, openWith({ lastMatchAt: ago(STREAK_QUIET_CLOSE_MS).toISOString() })).open).toBe(false);
    expect(evalAuthRejected({ destination: LIVE, attempts: only500, dead: 3 }, openWith({ lastMatchAt: ago(10 * MIN).toISOString() }))).toMatchObject({
      open: true,
      facts: { lastMatchAt: ago(10 * MIN).toISOString(), lastAttemptAt: ago(MIN).toISOString() },
    });
  });

  it('[CB:T1] (phần b) destination.client_error: 3× 4xx khác (404/422) mở; 401/403/408/429 không tính; đóng khi 2xx', () => {
    expect(CLIENT_ERROR_MIN_STREAK).toBe(3);
    expect(evalClientError({ destination: LIVE, attempts: attempts([404, 422]), dead: 0 }, fresh).open).toBe(false);
    expect(evalClientError({ destination: LIVE, attempts: attempts([404, 422, 400]), dead: 3 }, fresh)).toMatchObject({ open: true, facts: { count: 3, httpStatus: 404 } });
    for (const s of [401, 403, 408, 429, 500]) expect(evalClientError({ destination: LIVE, attempts: attempts([s, s, s]), dead: 0 }, fresh).open).toBe(false);
    expect(evalClientError({ destination: LIVE, attempts: attempts([204, 404, 404, 404]), dead: 3 }, openWith({ count: 3 })).open).toBe(false);
  });

  it('[CB:T1] (phần c) destination.failing: 9 attempt 100% lỗi không mở; 10 attempt 50% (5xx/mạng/429) mở, 49% không; đóng sau 2 lượt < 20%', () => {
    expect(FAILING_MIN_ATTEMPTS).toBe(10);
    const nine = Array(9).fill(503);
    expect(evalDestinationFailing({ destination: LIVE, statuses: nine }, fresh).open).toBe(false);
    const half = [500, 0, null, 429, 408, 200, 200, 200, 200, 200];
    expect(evalDestinationFailing({ destination: LIVE, statuses: half }, fresh)).toMatchObject({ open: true, facts: { total: 10, failed: 5, pct: 50 } });
    // 4xx non-retryable KHÔNG phải "đang retry" -> không tính vào failing
    const withAuth = [500, 500, 500, 500, 401, 401, 200, 200, 200, 200];
    expect(evalDestinationFailing({ destination: LIVE, statuses: withAuth }, fresh).open).toBe(false);
    const almost = [...Array(49).fill(500), ...Array(51).fill(200)];
    expect(evalDestinationFailing({ destination: LIVE, statuses: almost }, fresh).open).toBe(false);

    // hysteresis: đang mở, 30% (giữa 20% và 50%) -> giữ mở, reset êm; < 20% lượt 1 -> giữ (calm 1); lượt 2 -> đóng
    const mid = [500, 500, 500, ...Array(7).fill(200)];
    expect(evalDestinationFailing({ destination: LIVE, statuses: mid }, openWith({ calmStreak: 1 }))).toMatchObject({ open: true, facts: { calmStreak: 0 } });
    const calm = [500, ...Array(9).fill(200)]; // 10% < 20%
    const first = evalDestinationFailing({ destination: LIVE, statuses: calm }, openWith({ calmStreak: 0 }));
    expect(first).toMatchObject({ open: true, facts: { calmStreak: 1, lastCalmAt: NOW.toISOString() } });
    // Thấp 3: evaluator thứ hai đếm ngay sau (chưa đủ một chu kỳ) -> KHÔNG tính lượt êm thứ hai
    expect(evalDestinationFailing({ destination: LIVE, statuses: calm }, openWith(first.facts, ago(HOUR), new Date(LATER.getTime() - 1)))).toMatchObject({
      open: true,
      facts: { calmStreak: 1, lastCalmAt: NOW.toISOString() },
    });
    expect(evalDestinationFailing({ destination: LIVE, statuses: calm }, openWith(first.facts, ago(HOUR), LATER)).open).toBe(false);
    // đúng 20% không phải "< 20%" -> không tính lượt êm
    const twenty = [500, 500, ...Array(8).fill(200)];
    expect(evalDestinationFailing({ destination: LIVE, statuses: twenty }, openWith({ calmStreak: 1 })).open).toBe(true);
    // không còn attempt nào (0%) cũng là êm
    expect(evalDestinationFailing({ destination: LIVE, statuses: [] }, openWith({ calmStreak: 1 })).open).toBe(false);
    // Thấp 4: mẫu < FAILING_MIN_ATTEMPTS (dù toàn lỗi) cũng là lượt êm -> 2 lượt thì đóng
    expect(evalDestinationFailing({ destination: LIVE, statuses: Array(9).fill(500) }, openWith({ calmStreak: 0 }))).toMatchObject({ open: true, facts: { calmStreak: 1 } });
    expect(evalDestinationFailing({ destination: LIVE, statuses: Array(9).fill(500) }, openWith({ calmStreak: 1 })).open).toBe(false);
    // Q2: tách theo loại
    expect(evalDestinationFailing({ destination: LIVE, statuses: half }, fresh).facts.byClass).toEqual({ server_error: 1, no_response: 2, throttled: 2, unexpected: 0 });
    expect(evalDestinationFailing({ destination: LIVE, statuses: [302, 302, 503, 200] }, fresh).facts.byClass).toEqual({ server_error: 1, no_response: 0, throttled: 0, unexpected: 2 });
  });

  it('[CB:T1] (phần d) destination.circuit_open: OPEN mở; HALF_OPEN không mở mới nhưng giữ cái đang mở; CLOSED đóng', () => {
    expect(evalCircuitOpen({ destination: LIVE, circuitState: 'CLOSED' }, fresh).open).toBe(false);
    expect(evalCircuitOpen({ destination: LIVE, circuitState: 'HALF_OPEN' }, fresh).open).toBe(false);
    const d = evalCircuitOpen({ destination: LIVE, circuitState: 'OPEN', halfOpenAt: ago(-MIN) }, fresh);
    expect(d).toMatchObject({ open: true, facts: { circuitState: 'OPEN', halfOpenAt: ago(-MIN).toISOString() } });
    expect(evalCircuitOpen({ destination: LIVE, circuitState: 'HALF_OPEN' }, openWith()).open).toBe(true);
    expect(evalCircuitOpen({ destination: LIVE, circuitState: 'CLOSED' }, openWith()).open).toBe(false);
  });

  it('[CB:T1] (phần e) delivery.dead_spike: 9 không mở, 10 mở, về 9 thì đóng; D9: DEAD vì đích/subscription lưu trữ không tính', () => {
    expect(DEAD_SPIKE_MIN).toBe(10);
    expect(evalDeadSpike({ dead: 9 }, fresh).open).toBe(false);
    expect(evalDeadSpike({ dead: 10 }, fresh)).toMatchObject({ open: true, facts: { count: 10, windowFrom: ago(HOUR).toISOString() } });
    expect(evalDeadSpike({ dead: 9 }, openWith({ count: 12 })).open).toBe(false);

    const base = { lastError: 'Non-retryable HTTP 401: x', destinationArchivedAt: null, subscriptionArchivedAt: null };
    expect(countsTowardDeadSpike(base)).toBe(true);
    expect(countsTowardDeadSpike({ ...base, lastError: null })).toBe(true);
    expect(countsTowardDeadSpike({ ...base, lastError: 'destination_archived: đích đã bị xoá khỏi luồng' })).toBe(false);
    expect(countsTowardDeadSpike({ ...base, destinationArchivedAt: NOW })).toBe(false);
    expect(countsTowardDeadSpike({ ...base, subscriptionArchivedAt: NOW })).toBe(false);
  });

  it('[CB:T1] (phần f) source.signature_failing: 4 sai không mở; 5/10 mở; 5/11 (45%) không; đóng sau 2 lượt < 20%', () => {
    expect(SIGNATURE_MIN_INVALID).toBe(5);
    expect(evalSignatureFailing({ source: LIVE, nonProbeRequests: 4, nonProbeInvalid: 4 }, fresh).open).toBe(false);
    expect(evalSignatureFailing({ source: LIVE, nonProbeRequests: 10, nonProbeInvalid: 5 }, fresh)).toMatchObject({ open: true, facts: { failed: 5, total: 10, pct: 50 } });
    expect(evalSignatureFailing({ source: LIVE, nonProbeRequests: 11, nonProbeInvalid: 5 }, fresh).open).toBe(false);
    const one = evalSignatureFailing({ source: LIVE, nonProbeRequests: 10, nonProbeInvalid: 1 }, openWith({ calmStreak: 0 }));
    expect(one.open).toBe(true);
    expect(evalSignatureFailing({ source: LIVE, nonProbeRequests: 10, nonProbeInvalid: 1 }, openWith(one.facts)).open).toBe(true); // cùng lượt
    expect(evalSignatureFailing({ source: LIVE, nonProbeRequests: 10, nonProbeInvalid: 1 }, openWith(one.facts, ago(HOUR), LATER)).open).toBe(false);
    expect(evalSignatureFailing({ source: LIVE, nonProbeRequests: 10, nonProbeInvalid: 3 }, openWith({ calmStreak: 1 })).open).toBe(true);
  });

  it('[CB:T1] (phần g) source.connection_broken: FAILED/DRIFTED mở (nhãn provider từ dữ liệu — D5); PENDING giữ; CONNECTED đóng; ngắt kết nối đóng có lý do', () => {
    const conn = (status: 'PENDING' | 'CONNECTED' | 'FAILED' | 'DRIFTED' | 'DISCONNECTED', updatedAt = ago(MIN)) => ({ status, lastError: 'e', lastFix: 'f', updatedAt });
    expect(evalConnectionBroken({ source: LIVE, connection: conn('CONNECTED'), providerLabel: 'X' }, fresh).open).toBe(false);
    expect(evalConnectionBroken({ source: LIVE, connection: conn('PENDING'), providerLabel: 'X' }, fresh).open).toBe(false);
    for (const s of ['FAILED', 'DRIFTED'] as const) {
      expect(evalConnectionBroken({ source: LIVE, connection: conn(s), providerLabel: 'Prov' }, fresh)).toMatchObject({
        open: true,
        facts: { status: s, providerLabel: 'Prov', lastError: 'e', lastFix: 'f' },
      });
    }
    expect(evalConnectionBroken({ source: LIVE, connection: conn('PENDING'), providerLabel: 'X' }, openWith({ status: 'DRIFTED' })).open).toBe(true);
    expect(evalConnectionBroken({ source: LIVE, connection: conn('CONNECTED'), providerLabel: 'X' }, openWith()).open).toBe(false);
    expect(evalConnectionBroken({ source: LIVE, connection: conn('DISCONNECTED'), providerLabel: 'X' }, openWith())).toMatchObject({ open: false, facts: { reason: 'disconnected' } });
    expect(evalConnectionBroken({ source: LIVE, connection: null, providerLabel: 'X' }, openWith())).toMatchObject({ open: false, facts: { reason: 'disconnected' } });
    // Q3: PENDING kẹt ≥ 15 phút = hỏng; ngay dưới thì chưa
    expect(CONNECTION_PENDING_STUCK_MS).toBe(15 * MIN);
    expect(evalConnectionBroken({ source: LIVE, connection: conn('PENDING', ago(15 * MIN - 1)), providerLabel: 'X' }, fresh).open).toBe(false);
    expect(evalConnectionBroken({ source: LIVE, connection: conn('PENDING', ago(15 * MIN)), providerLabel: 'X' }, fresh)).toMatchObject({
      open: true,
      facts: { status: 'PENDING', stuckSince: ago(15 * MIN).toISOString() },
    });
  });

  it('[CB:T1] (phần h) source.silent: < 20 sự kiện/7 ngày không có luật; ngưỡng = max(6h, 4×trung vị); có sự kiện mới thì đóng (baseline trượt không đóng)', () => {
    expect(SILENT_MIN_BASELINE_EVENTS).toBe(20);
    expect(silenceThresholdMs(10 * MIN)).toBe(SILENT_MIN_GAP_MS);
    expect(silenceThresholdMs(2 * HOUR)).toBe(SILENT_GAP_MULTIPLIER * 2 * HOUR);
    const base = { source: LIVE, nonProbeAccepted7d: 20, medianGapMs: 10 * MIN };
    // ngay dưới / đúng / ngay trên 6h
    expect(evalSourceSilent({ ...base, lastNonProbeEventAt: ago(6 * HOUR - 1) }, fresh).open).toBe(false);
    expect(evalSourceSilent({ ...base, lastNonProbeEventAt: ago(6 * HOUR) }, fresh).open).toBe(false);
    const d = evalSourceSilent({ ...base, lastNonProbeEventAt: ago(6 * HOUR + 1) }, fresh);
    expect(d).toMatchObject({ open: true, facts: { lastEventAt: ago(6 * HOUR + 1).toISOString(), thresholdMs: 6 * HOUR, baseline: 20 } });
    // 19 sự kiện: không có luật dù im 3 ngày
    expect(evalSourceSilent({ ...base, nonProbeAccepted7d: 19, lastNonProbeEventAt: ago(72 * HOUR) }, fresh).open).toBe(false);
    // nhịp thưa (trung vị 2h) -> ngưỡng 8h: im 7h chưa kêu
    expect(evalSourceSilent({ ...base, medianGapMs: 2 * HOUR, lastNonProbeEventAt: ago(7 * HOUR) }, fresh).open).toBe(false);
    expect(evalSourceSilent({ ...base, medianGapMs: 2 * HOUR, lastNonProbeEventAt: ago(8 * HOUR + 1) }, fresh).open).toBe(true);

    // đang mở: baseline tụt về 0 vì im quá lâu -> VẪN mở; có sự kiện mới hơn lần ghi -> đóng
    const cur = openWith({ lastEventAt: ago(10 * HOUR).toISOString() });
    expect(evalSourceSilent({ ...base, nonProbeAccepted7d: 0, lastNonProbeEventAt: ago(10 * HOUR) }, cur).open).toBe(true);
    expect(evalSourceSilent({ ...base, lastNonProbeEventAt: ago(MIN) }, cur)).toMatchObject({ open: false, facts: { lastEventAt: ago(MIN).toISOString() } });
  });

  it('[CB:T1] (phần i) normalize.backlog: 0 không mở, 1 mở, về 0 đóng', () => {
    expect(BACKLOG_MIN).toBe(1);
    expect(evalNormalizeBacklog({ stuck: 0 }, fresh).open).toBe(false);
    expect(evalNormalizeBacklog({ stuck: 1 }, fresh)).toMatchObject({ open: true, facts: { count: 1 } });
    expect(evalNormalizeBacklog({ stuck: 0 }, openWith({ count: 3 })).open).toBe(false);
  });

  it('[CB:T1] (phần j) đối tượng Ngắt/lưu trữ: không mở mới dù vượt ngưỡng, đang mở thì đóng với reason (lưu trữ thắng Ngắt)', () => {
    const archived = { isActive: false, archivedAt: ago(MIN) };
    const inactive = { isActive: false, archivedAt: null };
    const bad = attempts([401, 401, 401, 401]);
    expect(evalAuthRejected({ destination: inactive, attempts: bad, dead: 4 }, fresh)).toEqual({ open: false, facts: { reason: 'inactive' } });
    expect(evalAuthRejected({ destination: archived, attempts: bad, dead: 4 }, openWith())).toEqual({ open: false, facts: { reason: 'archived' } });
    expect(evalClientError({ destination: archived, attempts: attempts([404, 404, 404]), dead: 0 }, fresh).facts.reason).toBe('archived');
    expect(evalDestinationFailing({ destination: inactive, statuses: Array(20).fill(500) }, fresh).facts.reason).toBe('inactive');
    expect(evalCircuitOpen({ destination: inactive, circuitState: 'OPEN' }, openWith()).facts.reason).toBe('inactive');
    expect(evalSignatureFailing({ source: archived, nonProbeRequests: 10, nonProbeInvalid: 10 }, fresh).facts.reason).toBe('archived');
    expect(evalConnectionBroken({ source: inactive, connection: { status: 'FAILED', lastError: null, lastFix: null, updatedAt: NOW }, providerLabel: 'X' }, fresh).facts.reason).toBe('inactive');
    expect(evalSourceSilent({ source: archived, nonProbeAccepted7d: 50, medianGapMs: MIN, lastNonProbeEventAt: ago(48 * HOUR) }, openWith()).facts.reason).toBe('archived');
  });
});
