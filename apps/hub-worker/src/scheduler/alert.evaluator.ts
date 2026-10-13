import { Inject, Injectable, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import Redis from 'ioredis';
import {
  ALERT_EVAL_INTERVAL_MS,
  ALERT_REALTIME_CHANNEL,
  ALERT_RULES,
  AUTH_REJECTED_WINDOW_MS,
  AlertFacts,
  AlertRuleCode,
  AlertSeverity,
  BACKLOG_MIN_AGE_MS,
  CLIENT_ERROR_WINDOW_MS,
  ConnectionInput,
  DEAD_SPIKE_MIN,
  DEAD_SPIKE_WINDOW_MS,
  DESTINATION_ARCHIVED_ERROR_PREFIX,
  EVALUATED_RULE_CODES,
  FAILING_WINDOW_MS,
  FLAP_SUPPRESS_MS,
  RuleContext,
  RuleDecision,
  SIGNATURE_WINDOW_MS,
  SILENT_BASELINE_MAX_EVENTS,
  SILENT_BASELINE_WINDOW_MS,
  STREAK_QUIET_CLOSE_MS,
  SubjectLifecycle,
  evalAuthRejected,
  evalCircuitOpen,
  evalClientError,
  evalConnectionBroken,
  evalDeadSpike,
  evalDestinationFailing,
  evalNormalizeBacklog,
  evalSignatureFailing,
  evalSourceSilent,
  fastFailRedisOptions,
  logger,
  toAlertChangedNotice,
} from '@hub/common';
import {
  ALERT_ATTEMPT_ROWS_LIMIT,
  ALERT_INPUT_LIMIT,
  AlertAttemptRow,
  AlertDestinationRow,
  AlertEmailRecipient,
  AlertRow,
  AlertSourceRow,
  PrismaService,
  TenantScopedRepository,
} from '@hub/database';
import { alertEvalErrors, alertTransitions, alertsOpen } from '../metrics';

/**
 * CB2 (SPEC-canh-bao-nhan-dinh §5.1, DINH-CHINH D1/D4/D5/D9, ADR-165/168): đánh giá luật cảnh báo mỗi
 * `ALERT_EVAL_INTERVAL_MS` (mặc định 60s; `0` = tắt) — job trong `hub-worker`, KHÔNG tiến trình mới (ADR-020, BB-4).
 *
 * - KHÔNG khoá (D4): nhiều worker cùng chạy chỉ tốn thêm truy vấn; trọng tài là unique index một phần + `INSERT … ON
 *   CONFLICT` (`upsertOpenAlert`). Không Redis lock.
 * - Lặp project (`IdentityRepository.listProjectIds`), MỌI truy vấn của một project đi qua `TenantScopedRepository` (BB-5).
 *   Mỗi luật: một truy vấn tổng hợp có cửa sổ + LIMIT (hai luật chuỗi dùng chung một truy vấn attempt) + hàm thuần
 *   `rules.ts`. Đối tượng Ngắt/lưu trữ/đã xoá: luật trả "đóng kèm reason", không bao giờ mở.
 * - Chỉ khi trạng thái ĐỔI (dòng OPEN vừa tạo / dòng OPEN vừa được đóng): trong CÙNG transaction tạo outbox email PENDING
 *   (D1, §6 — vòng gửi là CB5), sau COMMIT mới PUBLISH `hub:realtime:alerts` (không facts thô). Redis lỗi chỉ mất realtime
 *   (BB-2): cảnh báo vẫn mở/đóng đúng trong Postgres.
 * - Một luật ném lỗi: log + `hub_alert_eval_errors_total{rule}`, luật khác chạy tiếp. Shutdown dừng ở ranh giới luật.
 */
export const ALERT_REDIS = Symbol('ALERT_REDIS');

/** Số attempt gần nhất mỗi đích cho luật chuỗi (ngưỡng là 3; thừa để còn thấy 2xx mới hơn mốc giữa các lượt). */
export const STREAK_ATTEMPTS_PER_DESTINATION = 50;
/** Số mốc sự kiện gần nhất mỗi source để tính nhịp baseline (`source.silent`; ngưỡng là 20). */
export const SILENT_EVENTS_PER_SOURCE = SILENT_BASELINE_MAX_EVENTS; // CB6: chung với nhận định I-silent
/** Trần đếm `delivery.dead_spike` (ngưỡng là 10). */
export const DEAD_SPIKE_COUNT_CAP = 1000;

/** Trần cảnh báo OPEN đọc mỗi project; chạm trần -> không suy "không có trong ảnh chụp" = "không mở" (Thấp 4). */
export const OPEN_ALERTS_READ_LIMIT = 500;

/** Cửa sổ chung của truy vấn attempt cho hai luật chuỗi (cửa sổ chuỗi + cửa sổ "im"). */
const STREAK_LOOKBACK_MS = Math.max(AUTH_REJECTED_WINDOW_MS, CLIENT_ERROR_WINDOW_MS, STREAK_QUIET_CLOSE_MS);
/** Đối tượng có cảnh báo OPEN nhưng không còn trong DB (đã xoá cứng) -> đóng như lưu trữ. */
const GONE = (now: Date): SubjectLifecycle => ({ isActive: false, archivedAt: now });

export interface AlertEvalResult {
  projects: number;
  transitions: number;
  errors: number;
  /** true = dừng giữa chừng vì shutdown. */
  aborted: boolean;
}

interface Candidate {
  subjectId: string;
  decide: (ctx: RuleContext) => RuleDecision;
}

type OpenAlert = { id: string; rule: string; subjectId: string; severity: AlertSeverity; openedAt: Date; facts: AlertFacts };

/** Dữ liệu dùng chung giữa các luật của MỘT project trong MỘT lượt (mỗi truy vấn chạy tối đa một lần). */
class ProjectLap {
  private memo = new Map<string, Promise<unknown>>();
  /** Danh sách đích/source chạm LIMIT: đối tượng vắng mặt có thể chỉ bị cắt -> KHÔNG được đóng "như đã xoá". */
  destinationsTruncated = false;
  sourcesTruncated = false;

  constructor(
    readonly tenantId: string,
    readonly now: Date,
    readonly repo: TenantScopedRepository,
    readonly open: Map<string, OpenAlert>,
    /** Ảnh chụp cảnh báo OPEN chạm trần đọc: thiếu trong ảnh chụp KHÔNG có nghĩa là chưa mở. */
    readonly openTruncated: boolean,
  ) {}

  private hitLimit(what: string, n: number, limit: number): boolean {
    if (n < limit) return false;
    logger.warn({ tenantId: this.tenantId, what, limit }, 'Alert evaluator: truy vấn đầu vào chạm LIMIT — kết quả có thể thiếu');
    return true;
  }

  once<T>(key: string, load: () => Promise<T>): Promise<T> {
    if (!this.memo.has(key)) this.memo.set(key, load());
    return this.memo.get(key) as Promise<T>;
  }

  since(ms: number): Date {
    return new Date(this.now.getTime() - ms);
  }

  openSubjectIds(prefix: 'destination.' | 'source.'): string[] {
    return [...new Set([...this.open.values()].filter((a) => a.rule.startsWith(prefix)).map((a) => a.subjectId))];
  }

  destinations(): Promise<AlertDestinationRow[]> {
    return this.once('destinations', async () => {
      const rows = await this.repo.findAlertDestinations(this.openSubjectIds('destination.'), ALERT_INPUT_LIMIT);
      this.destinationsTruncated = this.hitLimit('destinations', rows.length, ALERT_INPUT_LIMIT);
      return rows;
    });
  }

  sources(): Promise<AlertSourceRow[]> {
    return this.once('sources', async () => {
      const rows = await this.repo.findAlertSources(this.openSubjectIds('source.'), ALERT_INPUT_LIMIT);
      this.sourcesTruncated = this.hitLimit('sources', rows.length, ALERT_INPUT_LIMIT);
      return rows;
    });
  }

  streakAttempts(): Promise<Map<string, AlertAttemptRow[]>> {
    return this.once('streakAttempts', async () => {
      const rows = await this.repo.findRecentAttemptsByDestination(this.since(STREAK_LOOKBACK_MS), STREAK_ATTEMPTS_PER_DESTINATION, ALERT_ATTEMPT_ROWS_LIMIT);
      this.hitLimit('streakAttempts', rows.length, ALERT_ATTEMPT_ROWS_LIMIT);
      const by = new Map<string, AlertAttemptRow[]>();
      for (const r of rows) by.set(r.destinationId, [...(by.get(r.destinationId) ?? []), r]); // SQL đã xếp mới nhất trước
      return by;
    });
  }

  deadByDestination(): Promise<Map<string, number>> {
    return this.once('deadByDestination', async () => {
      const rows = await this.repo.countDeadDeliveriesByDestination(this.since(AUTH_REJECTED_WINDOW_MS));
      return new Map(rows.map((r) => [r.destinationId, r.n]));
    });
  }
}

const key = (rule: string, subjectId: string) => `${rule}|${subjectId}`;

function lifecycleOf(row: { isActive: boolean; archivedAt: Date | null }): SubjectLifecycle {
  return { isActive: row.isActive, archivedAt: row.archivedAt };
}

@Injectable()
export class AlertEvaluator implements OnModuleInit, OnModuleDestroy {
  /** Redis publisher: tiêm vào (test) hoặc tạo LƯỜI ở lần publish đầu (giới hạn kết nối Upstash — worker không có cảnh báo nào thì không mở kết nối). */
  private redis: Redis | null;
  private readonly ownsRedis: boolean;
  private connecting: Promise<void> | null = null;
  private readonly intervalMs: number;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopping = false;
  private lap: Promise<AlertEvalResult> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    @Optional() @Inject(ALERT_REDIS) redisClient?: Redis,
  ) {
    const env = process.env.ALERT_EVAL_INTERVAL_MS;
    const n = env === undefined || env === '' ? ALERT_EVAL_INTERVAL_MS : parseInt(env, 10);
    this.intervalMs = Number.isFinite(n) && n >= 0 ? n : ALERT_EVAL_INTERVAL_MS;
    this.redis = redisClient ?? null;
    this.ownsRedis = !redisClient;
  }

  onModuleInit() {
    this.start();
  }

  async onModuleDestroy() {
    await this.stop();
    if (this.ownsRedis && this.redis) {
      const r = this.redis;
      this.redis = null;
      await r.quit().catch(() => r.disconnect());
    }
  }

  start() {
    if (this.running || this.intervalMs === 0) return;
    this.running = true;
    this.stopping = false;
    // Lượt đầu sau 15–45s: worker vừa lên chưa tranh tài nguyên với consumer; nhiều worker không cùng nhịp.
    this.schedule(15_000 + Math.floor(Math.random() * 30_000));
    logger.info({ intervalMs: this.intervalMs }, 'Alert evaluator đã khởi động');
  }

  /** Dừng hẹn giờ; lượt đang chạy dừng ở ranh giới luật kế tiếp. Promise xong khi lượt đó kết thúc. */
  async stop(): Promise<void> {
    this.running = false;
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.lap) await this.lap.catch(() => undefined);
  }

  private schedule(delayMs: number) {
    if (!this.running) return;
    this.timer = setTimeout(async () => {
      try {
        await this.evaluateOnce(new Date());
      } catch (err: any) {
        logger.error({ err: err?.message }, 'Alert evaluator: lỗi ngoài dự kiến trong một lượt');
      } finally {
        this.schedule(this.intervalMs);
      }
    }, delayMs);
  }

  /** Một lượt trên mọi project. `now` tiêm vào (test). */
  evaluateOnce(now: Date = new Date()): Promise<AlertEvalResult> {
    const lap = this.runLap(now);
    this.lap = lap;
    return lap.finally(() => {
      if (this.lap === lap) this.lap = null;
    });
  }

  private async runLap(now: Date): Promise<AlertEvalResult> {
    const result: AlertEvalResult = { projects: 0, transitions: 0, errors: 0, aborted: false };
    if (this.stopping) return { ...result, aborted: true }; // stop() đã gọi: không bắt đầu lượt mới
    const identity = this.prisma.identity();
    const projectIds = await identity.listProjectIds();
    const recipients = await identity.listAlertEmailRecipients().catch((err: any) => {
      // Email không bao giờ chặn evaluator (§6): lỗi đọc người nhận -> lượt này không tạo email, cảnh báo vẫn chạy.
      logger.warn({ err: err?.message }, 'Alert evaluator: không đọc được người nhận email -> lượt này không tạo email');
      return [] as AlertEmailRecipient[];
    });
    const openBySeverity: Record<AlertSeverity, number> = { critical: 0, warning: 0, info: 0 };
    let complete = true;
    for (const tenantId of projectIds) {
      if (this.stopping) {
        result.aborted = true;
        break;
      }
      const r = await this.evaluateProject(tenantId, now, recipients);
      result.projects++;
      result.transitions += r.transitions;
      result.errors += r.errors;
      if (r.aborted) result.aborted = true;
      if (!r.openBySeverity) complete = false;
      else for (const s of Object.keys(openBySeverity) as AlertSeverity[]) openBySeverity[s] += r.openBySeverity[s];
    }
    if (complete && !result.aborted) for (const [severity, n] of Object.entries(openBySeverity)) alertsOpen.set({ severity }, n);
    return result;
  }

  /**
   * Một project: đọc cảnh báo OPEN (hysteresis + đóng), rồi lần lượt từng luật. Trả số OPEN theo mức sau lượt
   * (null nếu không đọc được cảnh báo OPEN — gauge giữ giá trị cũ).
   */
  async evaluateProject(
    tenantId: string,
    now: Date,
    recipients: AlertEmailRecipient[] = [],
  ): Promise<{ transitions: number; errors: number; aborted: boolean; openBySeverity: Record<AlertSeverity, number> | null }> {
    const out = { transitions: 0, errors: 0, aborted: false, openBySeverity: null as Record<AlertSeverity, number> | null };
    const repo = this.prisma.forTenant(tenantId);
    let open: Map<string, OpenAlert>;
    let openTruncated = false;
    try {
      const rows = await repo.findOpenAlerts(OPEN_ALERTS_READ_LIMIT);
      openTruncated = rows.length >= OPEN_ALERTS_READ_LIMIT;
      if (openTruncated) logger.warn({ tenantId, limit: OPEN_ALERTS_READ_LIMIT }, 'Alert evaluator: cảnh báo OPEN chạm trần đọc — đọc bù OPEN theo luật cho đối tượng ngoài ảnh chụp (findOpenAlertsForSubjects), gauge giữ giá trị cũ');
      open = new Map(
        rows.map((a) => [
          key(a.rule, a.subjectId),
          { id: a.id, rule: a.rule, subjectId: a.subjectId, severity: a.severity as AlertSeverity, openedAt: a.openedAt, facts: (a.facts ?? {}) as AlertFacts },
        ]),
      );
    } catch (err: any) {
      logger.error({ err: err?.message, tenantId }, 'Alert evaluator: không đọc được cảnh báo OPEN của project -> bỏ project lượt này');
      alertEvalErrors.inc({ rule: 'project' });
      out.errors++;
      return out;
    }
    const lap = new ProjectLap(tenantId, now, repo, open, openTruncated);
    const finalOpen = new Map<string, AlertSeverity>([...open].map(([k, a]) => [k, a.severity]));

    // QT6: chỉ luật `driver: 'evaluator'` — luật dung lượng / chốt ổ do StorageAlerts mở/đóng theo sự kiện, evaluator không
    // đánh giá và KHÔNG đóng chúng (vòng "OPEN mà không còn đối tượng" dưới đây chỉ chạy cho luật được lặp).
    for (const rule of EVALUATED_RULE_CODES) {
      if (this.stopping) {
        out.aborted = true;
        break;
      }
      try {
        const candidates = await this.candidates(rule, lap);
        const covered = new Set(candidates.map((c) => c.subjectId));
        // Cảnh báo OPEN mà đối tượng không còn trong DB (xoá cứng) -> đóng như lưu trữ. CHỈ khi danh sách đối tượng đọc
        // trọn (không chạm LIMIT): lượt đọc bị cắt không bao giờ được đóng cảnh báo.
        const st = ALERT_RULES[rule].subjectType;
        const truncated = (st === 'destination' && lap.destinationsTruncated) || (st === 'source' && lap.sourcesTruncated);
        for (const a of open.values()) {
          if (a.rule === rule && !covered.has(a.subjectId) && !truncated) candidates.push({ subjectId: a.subjectId, decide: () => ({ open: false, facts: { reason: 'archived' } }) });
        }
        // Ảnh chụp OPEN bị cắt: đọc bù dòng OPEN thật của luật này cho đối tượng ngoài ảnh chụp — quyết định với current
        // = null sẽ đóng nhầm cảnh báo đang giữ mở (HALF_OPEN, PENDING, vùng giữa của hysteresis).
        const extra = new Map<string, OpenAlert>();
        if (lap.openTruncated) {
          const missing = candidates.map((c) => c.subjectId).filter((id) => !open.has(key(rule, id)));
          for (const a of await repo.findOpenAlertsForSubjects(rule, missing)) {
            extra.set(a.subjectId, { id: a.id, rule: a.rule, subjectId: a.subjectId, severity: a.severity as AlertSeverity, openedAt: a.openedAt, facts: (a.facts ?? {}) as AlertFacts });
          }
        }
        for (const c of candidates) {
          if (this.stopping) break; // shutdown: không ghi thêm, dừng ngay giữa luật (phần đã ghi là trạng thái hợp lệ)
          const current = open.get(key(rule, c.subjectId)) ?? extra.get(c.subjectId) ?? null;
          const decision = c.decide({ now, current: current ? { openedAt: current.openedAt, facts: current.facts } : null });
          const changed = await this.apply(lap, rule, c.subjectId, decision, current, recipients);
          if (changed) out.transitions++;
          if (decision.open) finalOpen.set(key(rule, c.subjectId), ALERT_RULES[rule].severity);
          else finalOpen.delete(key(rule, c.subjectId));
        }
      } catch (err: any) {
        out.errors++;
        alertEvalErrors.inc({ rule });
        logger.error({ err: err?.message, tenantId, rule }, 'Alert evaluator: luật lỗi -> bỏ qua luật này, chạy tiếp luật khác');
      }
    }
    const counts: Record<AlertSeverity, number> = { critical: 0, warning: 0, info: 0 };
    for (const sev of finalOpen.values()) counts[sev]++;
    // Ảnh chụp bị cắt -> tổng không đáng tin, gauge giữ giá trị cũ. Dừng giữa chừng cũng vậy.
    if (this.stopping) out.aborted = true;
    out.openBySeverity = openTruncated || out.aborted ? null : counts;
    return out;
  }

  /** Đầu vào + hàm thuần của từng luật (mỗi đối tượng một quyết định). */
  private async candidates(rule: AlertRuleCode, lap: ProjectLap): Promise<Candidate[]> {
    const { now, tenantId, repo } = lap;
    switch (rule) {
      case 'destination.auth_rejected':
      case 'destination.client_error': {
        const [dests, attempts, dead] = await Promise.all([lap.destinations(), lap.streakAttempts(), lap.deadByDestination()]);
        const fn = rule === 'destination.auth_rejected' ? evalAuthRejected : evalClientError;
        return dests.map((d) => ({
          subjectId: d.id,
          decide: (ctx) =>
            fn({ destination: lifecycleOf(d), attempts: (attempts.get(d.id) ?? []).map((a) => ({ status: a.status, at: a.at })), dead: dead.get(d.id) ?? 0 }, ctx),
        }));
      }
      case 'destination.failing': {
        const [dests, rows] = await Promise.all([lap.destinations(), repo.countAttemptStatusesByDestination(lap.since(FAILING_WINDOW_MS), ALERT_ATTEMPT_ROWS_LIMIT)]);
        if (rows.length >= ALERT_ATTEMPT_ROWS_LIMIT) logger.warn({ tenantId, what: 'failingStatuses' }, 'Alert evaluator: truy vấn đầu vào chạm LIMIT — kết quả có thể thiếu');
        const statuses = new Map<string, (number | null)[]>();
        for (const r of rows) statuses.set(r.destinationId, [...(statuses.get(r.destinationId) ?? []), ...Array<number | null>(r.n).fill(r.status)]);
        return dests.map((d) => ({ subjectId: d.id, decide: (ctx) => evalDestinationFailing({ destination: lifecycleOf(d), statuses: statuses.get(d.id) ?? [] }, ctx) }));
      }
      case 'destination.circuit_open': {
        const dests = await lap.destinations();
        return dests.map((d) => ({ subjectId: d.id, decide: (ctx) => evalCircuitOpen({ destination: lifecycleOf(d), circuitState: d.circuitState }, ctx) }));
      }
      case 'delivery.dead_spike': {
        const dead = await repo.countDeadForSpike(lap.since(DEAD_SPIKE_WINDOW_MS), DESTINATION_ARCHIVED_ERROR_PREFIX, Math.max(DEAD_SPIKE_COUNT_CAP, DEAD_SPIKE_MIN));
        return [{ subjectId: tenantId, decide: (ctx) => evalDeadSpike({ dead }, ctx) }];
      }
      case 'source.signature_failing': {
        const [sources, rows] = await Promise.all([lap.sources(), repo.countSignatureBySource(lap.since(SIGNATURE_WINDOW_MS))]);
        const by = new Map(rows.map((r) => [r.sourceId, r]));
        return sources.map((s) => ({
          subjectId: s.id,
          decide: (ctx) =>
            evalSignatureFailing({ source: lifecycleOf(s), nonProbeRequests: by.get(s.id)?.requests ?? 0, nonProbeInvalid: by.get(s.id)?.invalid ?? 0 }, ctx),
        }));
      }
      case 'source.connection_broken': {
        const sources = await lap.sources();
        return sources.map((s) => {
          const connection: ConnectionInput['connection'] =
            s.connectionStatus && s.connectionUpdatedAt
              ? { status: s.connectionStatus, lastError: s.connectionLastError, lastFix: s.connectionLastFix, updatedAt: s.connectionUpdatedAt }
              : null;
          // D5: nhãn provider là DỮ LIỆU (mã provider của kết nối/source) — web dịch thành tên hiển thị; không viết cứng.
          return { subjectId: s.id, decide: (ctx) => evalConnectionBroken({ source: lifecycleOf(s), connection, providerLabel: s.connectionProvider ?? s.provider }, ctx) };
        });
      }
      case 'source.silent': {
        const sources = await lap.sources();
        const openSilent = new Set([...lap.open.values()].filter((a) => a.rule === rule).map((a) => a.subjectId));
        // Chỉ source còn chạy (hoặc đang có cảnh báo im lặng) mới cần truy vấn nhịp; source Ngắt/lưu trữ đóng theo lifecycle.
        const ids = sources.filter((s) => (s.isActive && !s.archivedAt) || openSilent.has(s.id)).map((s) => s.id);
        const rows = await repo.findSourceActivity(ids, lap.since(SILENT_BASELINE_WINDOW_MS), SILENT_EVENTS_PER_SOURCE);
        const by = new Map(rows.map((r) => [r.sourceId, r]));
        return sources.map((s) => ({
          subjectId: s.id,
          decide: (ctx) => {
            const a = by.get(s.id);
            return evalSourceSilent(
              { source: lifecycleOf(s), nonProbeAccepted7d: a?.n ?? 0, medianGapMs: a?.medianGapMs ?? null, lastNonProbeEventAt: a?.lastAt ?? null },
              ctx,
            );
          },
        }));
      }
      case 'normalize.backlog': {
        // Cùng truy vấn với orphan-banner (§4): raw ACCEPTED chưa sinh event và chưa normalize xong, cũ hơn 10 phút.
        const { total } = await repo.findOrphanRawEvents({ limit: 1, olderThanSeconds: Math.floor(BACKLOG_MIN_AGE_MS / 1000) });
        return [{ subjectId: tenantId, decide: (ctx) => evalNormalizeBacklog({ stuck: total }, ctx) }];
      }
      case 'project.storage_warn':
      case 'project.storage_critical':
      case 'project.storage_locked':
      case 'hub.storage_near_full':
        return []; // luật sự kiện (QT6) — không có đầu vào ở evaluator
      default: {
        const never: never = rule;
        throw new Error(`Luật chưa có đầu vào: ${String(never)}`);
      }
    }
  }

  /**
   * Ghi quyết định. Trả true khi CHÍNH lượt này đổi trạng thái (tạo dòng OPEN / đóng dòng OPEN) — chỉ khi đó mới có email
   * PENDING (cùng transaction) và PUBLISH (sau COMMIT). Còn mở: chỉ làm mới `last_seen_at` + facts (hysteresis).
   */
  private async apply(
    lap: ProjectLap,
    rule: AlertRuleCode,
    subjectId: string,
    decision: RuleDecision,
    current: OpenAlert | null,
    recipients: AlertEmailRecipient[],
  ): Promise<boolean> {
    const { tenantId, now } = lap;
    const meta = ALERT_RULES[rule];
    if (decision.open) {
      const { alert, opened } = await this.prisma.tenantTx(tenantId, async (tx) => {
        const repo = this.prisma.forTenant(tenantId, tx);
        const r = await repo.upsertOpenAlert({ rule, severity: meta.severity, subjectType: meta.subjectType, subjectId, facts: decision.facts, now });
        if (r.opened) await this.enqueueOpenEmails(repo, r.alert, now, recipients);
        return r;
      });
      if (!opened) return false;
      this.transitioned(alert, rule, 'OPEN');
      return true;
    }
    // Không có trong ảnh chụp (kể cả đọc bù khi ảnh chụp bị cắt) = chưa mở -> thôi.
    if (!current) return false;
    const resolved = await this.prisma.tenantTx(tenantId, async (tx) => {
      const repo = this.prisma.forTenant(tenantId, tx);
      // Đóng ĐÚNG dòng trong ảnh chụp (theo id, còn OPEN) — không đóng nhầm dòng OPEN mới evaluator khác vừa mở.
      const row = await repo.resolveAlertById(current.id, now, decision.facts);
      if (row) await this.enqueueResolvedEmails(repo, row, recipients);
      return row;
    });
    if (!resolved) return false; // evaluator khác đã đóng trước -> không publish lần hai
    this.transitioned(resolved, rule, 'RESOLVED');
    return true;
  }

  /** §6 + D1: operator đã bật email, luật ∈ email_rules, project không mute (đã lọc operator + email xác minh ở repo). */
  private eligible(recipients: AlertEmailRecipient[], rule: string, tenantId: string): AlertEmailRecipient[] {
    return recipients.filter((r) => r.emailRules.includes(rule) && !r.mutedProjects.includes(tenantId));
  }

  private async enqueueOpenEmails(repo: TenantScopedRepository, alert: AlertRow, now: Date, recipients: AlertEmailRecipient[]): Promise<void> {
    const users = this.eligible(recipients, alert.rule, alert.tenantId).map((r) => r.userId);
    if (users.length === 0) return;
    // Chống flapping (§6): cùng (rule, subject) vừa RESOLVED trong 30 phút -> lần mở lại này không email.
    if (await repo.hasAlertResolvedSince(alert.rule, alert.subjectId, new Date(now.getTime() - FLAP_SUPPRESS_MS))) {
      logger.info({ tenantId: alert.tenantId, rule: alert.rule, subjectId: alert.subjectId }, 'Cảnh báo mở lại trong 30 phút sau khi đóng -> không gửi email lần nữa');
      return;
    }
    await repo.enqueueAlertEmails(alert.id, 'OPEN', users);
  }

  /** Email lúc đóng: chỉ người chọn `email_on_resolve` VÀ đã có email OPEN của chính cảnh báo này (không gửi "đã ổn" cho tin chưa từng báo). */
  private async enqueueResolvedEmails(repo: TenantScopedRepository, alert: AlertRow, recipients: AlertEmailRecipient[]): Promise<void> {
    const want = this.eligible(recipients, alert.rule, alert.tenantId).filter((r) => r.emailOnResolve).map((r) => r.userId);
    if (want.length === 0) return;
    const hadOpen = new Set(await repo.findAlertEmailUserIds(alert.id, 'OPEN'));
    await repo.enqueueAlertEmails(alert.id, 'RESOLVED', want.filter((u) => hadOpen.has(u)));
  }

  /**
   * Báo một lần đổi trạng thái: metric + log + PUBLISH realtime (sau COMMIT). Công khai cho QT6 (StorageAlerts mở/đóng
   * luật dung lượng theo sự kiện) — DÙNG CHUNG kết nối Redis lười của evaluator (giới hạn kết nối Upstash, ADR-062).
   */
  announce(alert: AlertRow, rule: AlertRuleCode, to: 'OPEN' | 'RESOLVED') {
    this.transitioned(alert, rule, to);
  }

  private transitioned(alert: AlertRow, rule: AlertRuleCode, to: 'OPEN' | 'RESOLVED') {
    alertTransitions.inc({ rule, to });
    logger.info({ tenantId: alert.tenantId, alertId: alert.id, rule, subjectId: alert.subjectId, to }, 'Cảnh báo đổi trạng thái');
    const notice = toAlertChangedNotice({ id: alert.id, tenantId: alert.tenantId, rule, state: to });
    // BB-2: Redis chỉ là đường realtime — lỗi (đồng bộ hay bất đồng bộ) bị nuốt, trạng thái trong Postgres đã COMMIT.
    // Mất một thông báo thì chuông vẫn poll 30s (§5.3).
    this.publish(JSON.stringify(notice)).catch(() => {});
  }

  private async publish(message: string): Promise<void> {
    if (!this.redis) {
      const r = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', fastFailRedisOptions());
      r.on('error', (err) => logger.warn({ err: err.message }, 'Redis pub (alerts) lỗi'));
      this.redis = r;
      this.connecting = r.connect().catch(() => {});
    }
    if (this.connecting) await this.connecting;
    await this.redis.publish(ALERT_REALTIME_CHANNEL, message);
  }
}
