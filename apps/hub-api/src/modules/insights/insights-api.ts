import {
  DESTINATION_ARCHIVED_ERROR_PREFIX,
  INSIGHT_CODES,
  INSIGHT_DEAD_COUNT_CAP,
  INSIGHT_DEAD_RECENT_MS,
  INSIGHT_DEST_WINDOW_MS,
  Insight,
  InsightCode,
  SILENT_BASELINE_MAX_EVENTS,
  SILENT_BASELINE_WINDOW_MS,
  buildDeadInsight,
  buildDestInsight,
  buildDupInsight,
  buildSilentInsight,
} from '@hub/common';
import { ALERT_ATTEMPT_ROWS_LIMIT, ALERT_INPUT_LIMIT, PrismaService } from '@hub/database';
import { assertFlatQuery, badParam } from '../api/list-params';

/**
 * CB6 (SPEC-canh-bao-nhan-dinh §7): logic của `GET /api/v1/projects/:projectId/insights` — tách khỏi controller để test
 * bằng store giả và trên Postgres thật. Tính LÚC ĐỌC, không lưu; mọi truy vấn qua `forTenant(projectId)` (BB-5, RLS),
 * có cửa sổ thời gian và LIMIT, dùng lại ĐÚNG truy vấn đầu vào của AlertEvaluator (cùng index của migration CB2).
 * Không chạm Redis. Trả `code + level + subject + facts (+ actions)`; câu chữ ở web (i18n).
 */
export type InsightStore = Pick<PrismaService, 'forTenant'>;

export interface InsightQuery {
  /** Danh sách mã, phân cách dấu phẩy (`I-dup,I-dead`). Không truyền = cả bốn. Mỗi trang console chỉ xin mã nó hiện. */
  codes?: string;
}

export function parseInsightCodes(q: InsightQuery | undefined): InsightCode[] {
  assertFlatQuery(q);
  const raw = q?.codes;
  if (raw === undefined || raw.trim() === '') return [...INSIGHT_CODES];
  const out: InsightCode[] = [];
  for (const part of raw.split(',')) {
    const c = part.trim();
    if (!(INSIGHT_CODES as readonly string[]).includes(c)) throw badParam('codes', `codes chỉ nhận ${INSIGHT_CODES.join(', ')}`);
    if (!out.includes(c as InsightCode)) out.push(c as InsightCode);
  }
  return out;
}

export async function getInsights(store: InsightStore, projectId: string, q?: InsightQuery, now = new Date()): Promise<Insight[]> {
  const codes = parseInsightCodes(q);
  const repo = store.forTenant(projectId);
  const since = (ms: number) => new Date(now.getTime() - ms);
  const want = (c: InsightCode) => codes.includes(c);

  const [dest, silent, dup, dead] = await Promise.all([
    want('I-dest') ? destInsights() : [],
    want('I-silent') ? silentInsights() : [],
    want('I-dup') ? repo.countIngestDuplicatesToday().then((r) => [buildDupInsight({ projectId, since: r.since, byProvider: r.byProvider })]) : [],
    want('I-dead')
      ? repo
          .countDlqForInsight(since(INSIGHT_DEAD_RECENT_MS), DESTINATION_ARCHIVED_ERROR_PREFIX, INSIGHT_DEAD_COUNT_CAP)
          .then((r) => [buildDeadInsight({ projectId, ...r })])
      : [],
  ]);
  return [...dup, ...dead, ...dest, ...silent];

  /** Đích còn dùng (không lưu trữ, không Ngắt) + attempt 1 giờ qua: đếm theo status và attempt mới nhất mỗi đích. */
  async function destInsights(): Promise<Insight[]> {
    const from = since(INSIGHT_DEST_WINDOW_MS);
    const [dests, counts, latest] = await Promise.all([
      repo.findAlertDestinations([], ALERT_INPUT_LIMIT),
      repo.countAttemptStatusesByDestination(from, ALERT_ATTEMPT_ROWS_LIMIT),
      repo.findRecentAttemptsByDestination(from, 1, ALERT_INPUT_LIMIT),
    ]);
    const countsBy = new Map<string, { status: number | null; n: number }[]>();
    for (const r of counts) countsBy.set(r.destinationId, [...(countsBy.get(r.destinationId) ?? []), { status: r.status, n: r.n }]);
    const latestBy = new Map(latest.map((r) => [r.destinationId, { status: r.status, at: r.at }]));
    return dests
      .filter((d) => d.isActive && !d.archivedAt)
      .map((d) =>
        buildDestInsight(
          {
            destinationId: d.id,
            circuitState: d.circuitState as 'CLOSED' | 'OPEN' | 'HALF_OPEN',
            statusCounts: countsBy.get(d.id) ?? [],
            latest: latestBy.get(d.id) ?? null,
          },
          now,
        ),
      );
  }

  /** Source còn dùng + nhịp baseline 7 ngày — CÙNG `findSourceActivity` (cửa sổ, số mốc) với luật `source.silent`. */
  async function silentInsights(): Promise<Insight[]> {
    const sources = (await repo.findAlertSources([], ALERT_INPUT_LIMIT)).filter((s) => s.isActive && !s.archivedAt);
    if (sources.length === 0) return [];
    const activity = await repo.findSourceActivity(
      sources.map((s) => s.id),
      since(SILENT_BASELINE_WINDOW_MS),
      SILENT_BASELINE_MAX_EVENTS,
    );
    const by = new Map(activity.map((a) => [a.sourceId, a]));
    const out: Insight[] = [];
    for (const s of sources) {
      const a = by.get(s.id);
      const i = buildSilentInsight(
        { sourceId: s.id, source: { isActive: s.isActive, archivedAt: s.archivedAt }, activity: a ? { n: a.n, lastAt: a.lastAt, medianGapMs: a.medianGapMs } : null },
        now,
      );
      if (i) out.push(i);
    }
    return out;
  }
}
