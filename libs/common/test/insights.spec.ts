import * as fs from 'fs';
import * as path from 'path';
import { classifyHttpOutcome, isNonRetryableHttpStatus, isRetryableFailure } from '../src/http-outcome';
import {
  buildDeadInsight,
  buildDestInsight,
  buildDupInsight,
  buildSilentInsight,
  DestHealth,
  INSIGHT_DEST_WINDOW_MS,
} from '../src/alerts/insights';
import { evalSourceSilent, SILENT_MIN_BASELINE_EVENTS, SILENT_MIN_GAP_MS, silenceThresholdMs } from '../src/alerts/rules';

const NOW = new Date('2026-10-12T08:00:00.000Z');
const MIN = 60_000;
const HOUR = 60 * MIN;
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const ROOT = path.join(__dirname, '../../..');

/** Một đích với đúng MỘT attempt `status` (mới nhất) trong cửa sổ. */
const oneAttempt = (status: number | null) =>
  buildDestInsight({ destinationId: 'd1', circuitState: 'CLOSED', statusCounts: [{ status, n: 1 }], latest: { status, at: ago(MIN) } }, NOW);

describe('CB6 nhận định — hàm thuần', () => {
  it('[CB:T16] I-dest dùng CÙNG bộ phân loại với delivery.consumer: bảng mọi status 0..599 — non-retryable (DEAD ngay) ⇔ nhãn từ chối; 2xx ⇔ Khoẻ; còn lại ⇔ đang retry', () => {
    // Đổi phân loại của delivery.consumer (http-outcome.ts) mà I-dest không theo -> bảng này đỏ: cả hai đọc CÙNG hàm.
    for (const s of [null, ...Array.from({ length: 600 }, (_, i) => i)]) {
      const h = oneAttempt(s).facts.health;
      const o = classifyHttpOutcome(s);
      const expected: DestHealth =
        o === 'success' ? 'healthy' : o === 'auth_rejected' ? 'auth_rejected' : o === 'client_error' ? 'client_error' : 'receiver_failing';
      expect([s, h]).toEqual([s, expected]);
      if (s !== null) expect([s, h === 'auth_rejected' || h === 'client_error']).toEqual([s, isNonRetryableHttpStatus(s)]);
      expect([s, h === 'receiver_failing']).toEqual([s, isRetryableFailure(s)]);
    }
    // Không có bản phân loại thứ hai: consumer và nhận định cùng import từ http-outcome, không tự so status.
    const consumer = fs.readFileSync(path.join(ROOT, 'apps/hub-worker/src/consumers/delivery.consumer.ts'), 'utf8');
    expect(consumer).toMatch(/isNonRetryableHttpStatus,?[\s\S]*from '@hub\/common'/);
    expect(consumer).not.toMatch(/status\s*>=\s*400\s*&&/);
    const insights = fs.readFileSync(path.join(ROOT, 'libs/common/src/alerts/insights.ts'), 'utf8');
    expect(insights).toMatch(/import \{[^}]*classifyHttpOutcome[^}]*\} from '\.\.\/http-outcome'/);
    expect(insights).not.toMatch(/status\s*[<>=]=?\s*\d{3}/);
  });

  it('I-dest: circuit thắng mọi thứ; không attempt = Chưa có lượt giao; 2xx sau chuỗi 401 = Khoẻ ngay; tỉ lệ retry ≥ 50% = đang retry dù attempt cuối 2xx', () => {
    const base = { destinationId: 'd1', statusCounts: [] as { status: number | null; n: number }[], latest: null };
    expect(buildDestInsight({ ...base, circuitState: 'OPEN' }, NOW)).toMatchObject({ level: 'warning', facts: { health: 'circuit_open' } });
    expect(buildDestInsight({ ...base, circuitState: 'HALF_OPEN', statusCounts: [{ status: 200, n: 3 }] }, NOW).facts.health).toBe('circuit_open');
    const none = buildDestInsight({ ...base, circuitState: 'CLOSED' }, NOW);
    expect(none).toMatchObject({ code: 'I-dest', level: 'info', subjectType: 'destination', subjectId: 'd1', facts: { health: 'no_deliveries', total: 0 } });
    expect(none.facts.windowFrom).toBe(ago(INSIGHT_DEST_WINDOW_MS).toISOString());
    expect(none.actions).toBeUndefined();

    const fixed = buildDestInsight(
      { destinationId: 'd1', circuitState: 'CLOSED', statusCounts: [{ status: 401, n: 3 }, { status: 200, n: 1 }], latest: { status: 200, at: ago(MIN) } },
      NOW,
    );
    expect(fixed).toMatchObject({ level: 'ok', facts: { health: 'healthy', total: 4, success: 1, lastStatus: 200 } });
    expect(fixed.facts.byOutcome).toMatchObject({ auth_rejected: 3, success: 1 });

    const auth = buildDestInsight(
      { destinationId: 'd1', circuitState: 'CLOSED', statusCounts: [{ status: 200, n: 9 }, { status: 403, n: 1 }], latest: { status: 403, at: ago(MIN) } },
      NOW,
    );
    expect(auth).toMatchObject({ level: 'critical', facts: { health: 'auth_rejected' } });
    expect(auth.actions?.map((a) => a.code)).toEqual(['view_deliveries', 'open_dlq']);

    const flaky = buildDestInsight(
      { destinationId: 'd1', circuitState: 'CLOSED', statusCounts: [{ status: 503, n: 5 }, { status: null, n: 1 }, { status: 200, n: 4 }], latest: { status: 200, at: ago(MIN) } },
      NOW,
    );
    expect(flaky.facts).toMatchObject({ health: 'receiver_failing', retrying: 6, total: 10 });
    const mostlyOk = buildDestInsight(
      { destinationId: 'd1', circuitState: 'CLOSED', statusCounts: [{ status: 503, n: 4 }, { status: 200, n: 6 }], latest: { status: 200, at: ago(MIN) } },
      NOW,
    );
    expect(mostlyOk.facts.health).toBe('healthy');
  });

  it('I-silent dùng CHÍNH luật source.silent (cùng baseline): quiet ⇔ evalSourceSilent mở; dưới 20 sự kiện = đang học nhịp; Ngắt/lưu trữ = không nhận định', () => {
    const live = { isActive: true, archivedAt: null };
    const mk = (n: number, lastAgoMs: number | null, gap: number | null) =>
      buildSilentInsight({ sourceId: 's1', source: live, activity: { n, lastAt: lastAgoMs === null ? null : ago(lastAgoMs), medianGapMs: gap } }, NOW)!;

    expect(buildSilentInsight({ sourceId: 's1', source: live, activity: null }, NOW)).toMatchObject({ level: 'info', facts: { state: 'no_events', lastEventAt: null } });
    expect(mk(SILENT_MIN_BASELINE_EVENTS - 1, 10 * HOUR, 5 * MIN).facts.state).toBe('learning');

    // nhịp 2 giờ -> ngưỡng max(6h, 8h) = 8h: 7h59 vẫn bình thường, 8h01 là im lặng bất thường
    expect(mk(40, 8 * HOUR - MIN, 2 * HOUR)).toMatchObject({ level: 'ok', facts: { state: 'normal', thresholdMs: 8 * HOUR, medianGapMs: 2 * HOUR } });
    const quiet = mk(40, 8 * HOUR + MIN, 2 * HOUR);
    expect(quiet).toMatchObject({ level: 'warning', facts: { state: 'quiet', baseline: 40 }, actions: [{ code: 'view_events', params: { sourceId: 's1' } }] });

    // bảng: trạng thái quiet trùng khớp quyết định của luật cảnh báo trên nhiều tổ hợp
    for (const gap of [null, MIN, 30 * MIN, 3 * HOUR]) {
      for (const silent of [MIN, 5 * HOUR, SILENT_MIN_GAP_MS + 1, 13 * HOUR]) {
        const i = mk(25, silent, gap);
        const rule = evalSourceSilent({ source: live, nonProbeAccepted7d: 25, medianGapMs: gap, lastNonProbeEventAt: ago(silent) }, { now: NOW, current: null });
        expect([gap, silent, i.facts.state === 'quiet']).toEqual([gap, silent, rule.open]);
        expect(i.facts.thresholdMs).toBe(silenceThresholdMs(gap));
      }
    }

    expect(buildSilentInsight({ sourceId: 's1', source: { isActive: false, archivedAt: null }, activity: null }, NOW)).toBeNull();
    expect(buildSilentInsight({ sourceId: 's1', source: { isActive: false, archivedAt: NOW }, activity: null }, NOW)).toBeNull();
  });

  it('I-dup: tổng + tách theo provider (nhiều trước), bỏ dòng 0; chưa có bản trùng = level ok, tổng 0', () => {
    const since = new Date('2026-10-11T17:00:00.000Z');
    const d = buildDupInsight({ projectId: 'p1', since, byProvider: [{ provider: 'github', n: 2 }, { provider: 'payos', n: 5 }, { provider: 'generic', n: 0 }] });
    expect(d).toEqual({
      code: 'I-dup',
      level: 'info',
      subjectType: 'project',
      subjectId: 'p1',
      facts: { total: 7, byProvider: [{ provider: 'payos', n: 5 }, { provider: 'github', n: 2 }], since: since.toISOString() },
    });
    expect(buildDupInsight({ projectId: 'p1', since, byProvider: [] })).toMatchObject({ level: 'ok', facts: { total: 0, byProvider: [] } });
  });

  it('I-dead: n trong DLQ + k trong 24h, nút sang DLQ khi n > 0; k không vượt n; DLQ trống = ok, không nút', () => {
    expect(buildDeadInsight({ projectId: 'p1', total: 12, recent: 3, capped: false })).toEqual({
      code: 'I-dead',
      level: 'warning',
      subjectType: 'project',
      subjectId: 'p1',
      facts: { total: 12, recent: 3, capped: false, windowHours: 24 },
      actions: [{ code: 'open_dlq' }],
    });
    expect(buildDeadInsight({ projectId: 'p1', total: 4, recent: 0, capped: false }).level).toBe('info');
    expect(buildDeadInsight({ projectId: 'p1', total: 2, recent: 9, capped: false }).facts.recent).toBe(2);
    const empty = buildDeadInsight({ projectId: 'p1', total: 0, recent: 0, capped: false });
    expect(empty.level).toBe('ok');
    expect(empty.actions).toBeUndefined();
  });

  it('BB-1: nhận định không biết nghiệp vụ, không rẽ nhánh theo provider', () => {
    const src = fs.readFileSync(path.join(ROOT, 'libs/common/src/alerts/insights.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    expect(src).not.toMatch(/order|đơn hàng|amount|payment\./i);
    expect(src).not.toMatch(/provider\s*===|['"](payos|github|stripe)['"]/);
  });
});
