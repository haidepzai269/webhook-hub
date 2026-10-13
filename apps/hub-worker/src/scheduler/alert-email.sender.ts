import { Inject, Injectable, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { ALERT_EMAIL_HOURLY_CAP, AlertTextLocale, MailSender, createMailSender, logger, renderAlertEmail, ruleAudience } from '@hub/common';
import { AlertEmailClaim, PrismaService } from '@hub/database';
import { alertEmailsTotal } from '../metrics';

/**
 * CB5 (SPEC-canh-bao-nhan-dinh §6, DINH-CHINH D1/D2, ADR-173): VÒNG GỬI email cảnh báo — job trong `hub-worker` (không
 * tiến trình mới, ADR-020/BB-4), TÁCH khỏi AlertEvaluator: evaluator chỉ ghi dòng PENDING vào outbox `alert_emails` cùng
 * transaction đổi trạng thái; gửi lỗi/chậm ở đây không bao giờ chặn evaluator (CB:T13).
 *
 * Mỗi lượt:
 *  1. Lấy lô bằng `FOR UPDATE SKIP LOCKED` trong transaction NGẮN (escape hatch có tên `alertEmailOutboxClaim`, xuyên
 *     project như cleanup.job): tăng `attempts`, đặt lease (đồng hồ DB), COMMIT. Nhiều worker không lấy trùng dòng.
 *  2. NGOÀI transaction, từng dòng: kiểm lại điều kiện lúc gửi -> sai thì SUPPRESSED; trần 6 email/giờ/người -> SUPPRESSED
 *     `cap`, thư kế tiếp có dòng "…và k cảnh báo khác". Thư RESOLVED chờ tới khi thư OPEN của cùng người xong.
 *  3. Ngay trước khi gửi: GIA HẠN lease có điều kiện (fencing, review TB-2) — lease đã bị worker khác lấy lại thì bỏ dòng.
 *     Gửi có hạn chót (`ALERT_EMAIL_SEND_TIMEOUT_MS`); mọi lần ghi kết quả kèm token lease. Lỗi -> thử lại sau 1 phút /
 *     5 phút; lần 3 -> FAILED (log + `hub_alert_emails_total{result="failed"}`).
 *  Lượt dừng trước khi lease của lô hết hạn (trừ biên an toàn) và trả các dòng còn lại — như lúc shutdown.
 * At-least-once: worker chết sau khi gửi mà trước khi ghi SENT -> hết lease, gửi lại một lần (chấp nhận, ADR-173).
 */
export const ALERT_MAIL_SENDER = Symbol('ALERT_MAIL_SENDER');
export const ALERT_EMAIL_SENDER_OPTIONS = Symbol('ALERT_EMAIL_SENDER_OPTIONS');

export const ALERT_EMAIL_INTERVAL_MS = 15_000;
export const ALERT_EMAIL_BATCH = 20;
export const ALERT_EMAIL_MAX_ATTEMPTS = 3;
/** Lease của một dòng — gia hạn mỗi lần trước khi gửi; hết lease thì worker khác lấy lại. */
export const ALERT_EMAIL_LEASE_MS = 120_000;
/** Hạn chót của MỘT lần gửi (driver treo coi như lỗi) — nhỏ hơn hẳn lease để kết quả luôn ghi kịp trước khi lease hết. */
export const ALERT_EMAIL_SEND_TIMEOUT_MS = 30_000;
/** Lượt ngừng lấy dòng mới khi đã dùng quá (lease − biên) kể từ lúc lấy lô — dòng chưa xử lý được trả lại. */
export const ALERT_EMAIL_LAP_MARGIN_MS = ALERT_EMAIL_SEND_TIMEOUT_MS + 15_000;
/** Lùi thời gian sau lần lỗi thứ 1, 2 (lần 3 -> FAILED). */
export const ALERT_EMAIL_RETRY_DELAYS_MS = [60_000, 300_000] as const;
/** Thư RESOLVED mà thư OPEN của cùng người còn PENDING -> hoãn lại sau ngần này (không tốn lần thử). */
export const ALERT_EMAIL_RESOLVED_DEFER_MS = 30_000;
const HOUR_MS = 3_600_000;

export type EligibilityProblem =
  | 'not_operator'
  | 'email_unverified'
  | 'email_disabled'
  | 'rule_not_selected'
  | 'project_muted'
  | 'resolve_not_wanted'
  | 'storage_warn_off';

/**
 * Hàm thuần: điều kiện §6 kiểm LẠI lúc gửi (tuỳ chọn có thể đã đổi từ lúc evaluator ghi PENDING). null = được gửi.
 * QT6 (E3, §8): luật audience `owners+operator` + người nhận đang là OWNER của project -> bỏ qua `alert_preferences` của
 * operator; chỉ cần email đã xác minh, và với `project.storage_warn` (70/85) thì công tắc `storage_warn_email` còn bật.
 * Owner không tắt được 95%/LOCKED. Mất vai trò owner trước lúc gửi -> rơi về điều kiện operator (thường là `not_operator`).
 */
export function alertEmailEligibility(
  r: Pick<AlertEmailClaim, 'isOperator' | 'emailVerified' | 'emailEnabled' | 'emailRules' | 'mutedProjects' | 'emailOnResolve' | 'rule' | 'tenantId' | 'kind'> &
    Partial<Pick<AlertEmailClaim, 'isOwner' | 'storageWarnEmail'>>,
): EligibilityProblem | null {
  if (r.isOwner && ruleAudience(r.rule) === 'owners+operator' && r.kind === 'OPEN') {
    if (!r.emailVerified) return 'email_unverified';
    if (r.rule === 'project.storage_warn' && r.storageWarnEmail === false) return 'storage_warn_off';
    return null;
  }
  if (!r.isOperator) return 'not_operator';
  if (!r.emailVerified) return 'email_unverified';
  if (!r.emailEnabled) return 'email_disabled';
  if (!r.emailRules.includes(r.rule)) return 'rule_not_selected';
  if (r.mutedProjects.map((x) => x.toLowerCase()).includes(r.tenantId.toLowerCase())) return 'project_muted';
  if (r.kind === 'RESOLVED' && !r.emailOnResolve) return 'resolve_not_wanted';
  return null;
}

export interface AlertEmailRunResult {
  claimed: number;
  sent: number;
  suppressed: number;
  retried: number;
  failed: number;
  /** Trả lại (shutdown / hết ngân sách lượt / hoãn RESOLVED) hoặc bỏ vì mất lease. */
  released: number;
}

export interface AlertEmailSenderOptions {
  /** CHỈ test: giới hạn vòng gửi vào các project này (DB kiểm chứng dùng chung). Production không đặt. */
  tenantIds?: string[];
  leaseMs?: number;
  sendTimeoutMs?: number;
}

type Cap = { sentInWindow: number; rollupIds: string[] };

@Injectable()
export class AlertEmailSender implements OnModuleInit, OnModuleDestroy {
  private mail: MailSender | null;
  private readonly intervalMs: number;
  private readonly webUrl: string;
  private readonly opts: Required<Omit<AlertEmailSenderOptions, 'tenantIds'>> & Pick<AlertEmailSenderOptions, 'tenantIds'>;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopping = false;
  private lap: Promise<AlertEmailRunResult> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    @Optional() @Inject(ALERT_MAIL_SENDER) mail?: MailSender,
    @Optional() @Inject(ALERT_EMAIL_SENDER_OPTIONS) opts?: AlertEmailSenderOptions,
  ) {
    this.mail = mail ?? null;
    const env = process.env.ALERT_EMAIL_INTERVAL_MS;
    const n = env === undefined || env === '' ? ALERT_EMAIL_INTERVAL_MS : parseInt(env, 10);
    this.intervalMs = Number.isFinite(n) && n >= 0 ? n : ALERT_EMAIL_INTERVAL_MS;
    this.webUrl = process.env.WEB_PUBLIC_URL ?? '';
    this.opts = { leaseMs: ALERT_EMAIL_LEASE_MS, sendTimeoutMs: ALERT_EMAIL_SEND_TIMEOUT_MS, ...(opts ?? {}) };
  }

  onModuleInit() {
    this.start();
  }

  async onModuleDestroy() {
    await this.stop();
  }

  start() {
    if (this.running || this.intervalMs === 0) return;
    this.running = true;
    this.stopping = false;
    this.schedule(5_000 + Math.floor(Math.random() * 10_000));
    logger.info({ intervalMs: this.intervalMs }, 'Alert email sender đã khởi động');
  }

  /** Dừng hẹn giờ; lượt đang chạy dừng trước dòng kế tiếp (dòng chưa gửi được trả lại). */
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
      let full = false;
      try {
        full = (await this.sendOnce()).claimed >= ALERT_EMAIL_BATCH;
      } catch (err: any) {
        logger.error({ err: err?.message }, 'Alert email sender: lỗi ngoài dự kiến trong một lượt');
      } finally {
        this.schedule(full ? 0 : this.intervalMs);
      }
    }, delayMs);
  }

  /** Driver tạo LƯỜI: cấu hình mail sai không làm worker chết lúc khởi động — chỉ làm email lỗi (đếm lần thử). */
  private mailer(): MailSender {
    this.mail ??= createMailSender();
    return this.mail;
  }

  /** Một lượt. `now` chỉ dùng để dựng câu trong thư (mọi mốc lưu DB theo đồng hồ DB). */
  sendOnce(now: Date = new Date()): Promise<AlertEmailRunResult> {
    const lap = this.runLap(now);
    this.lap = lap;
    return lap.finally(() => {
      if (this.lap === lap) this.lap = null;
    });
  }

  private async runLap(now: Date): Promise<AlertEmailRunResult> {
    const out: AlertEmailRunResult = { claimed: 0, sent: 0, suppressed: 0, retried: 0, failed: 0, released: 0 };
    if (this.stopping) return out;
    const startedAt = Date.now();
    const rows = await this.prisma.alertEmailOutboxClaim({
      limit: ALERT_EMAIL_BATCH,
      leaseMs: this.opts.leaseMs,
      maxAttempts: ALERT_EMAIL_MAX_ATTEMPTS,
      tenantIds: this.opts.tenantIds,
    });
    out.claimed = rows.length;
    // Trạng thái trần theo người, đọc một lần mỗi lượt rồi cộng dồn tại chỗ (dòng đã xếp theo user_id).
    const caps = new Map<string, Cap>();
    const budget = Math.max(0, this.opts.leaseMs - ALERT_EMAIL_LAP_MARGIN_MS);
    for (let i = 0; i < rows.length; i++) {
      if (this.stopping || Date.now() - startedAt > budget) {
        // Shutdown / sắp hết lease của lô: trả các dòng chưa xử lý (bớt lại lần thử) — worker khác/lần sau lấy ngay.
        for (const rest of rows.slice(i)) {
          if (await this.prisma.alertEmailOutboxMarkFailure(rest.id, rest.lease, { release: true }).catch(() => null)) out.released++;
        }
        break;
      }
      try {
        await this.processOne(rows[i], now, caps, out);
      } catch (err: any) {
        // Lỗi DB khi ghi kết quả: dòng giữ lease, hết lease thì được lấy lại (lần thử đã tính).
        logger.error({ err: err?.message, alertEmailId: rows[i].id }, 'Alert email sender: không ghi được kết quả một email');
      }
    }
    return out;
  }

  private suppressed(out: AlertEmailRunResult) {
    out.suppressed++;
    alertEmailsTotal.inc({ result: 'suppressed' });
  }

  private async processOne(r: AlertEmailClaim, now: Date, caps: Map<string, Cap>, out: AlertEmailRunResult) {
    const problem = alertEmailEligibility(r);
    if (problem) {
      if (await this.prisma.alertEmailOutboxMarkSuppressed(r.id, r.lease, `ineligible:${problem}`)) this.suppressed(out);
      logger.info({ alertEmailId: r.id, userId: r.userId, problem }, 'Email cảnh báo không gửi: người nhận không còn đủ điều kiện');
      return;
    }
    // Fencing (TB-2): gia hạn lease có điều kiện NGAY TRƯỚC khi quyết định gửi. Mất lease -> worker khác đang giữ dòng.
    const renewed = await this.prisma.alertEmailOutboxRenew(r.id, r.lease, this.opts.leaseMs);
    if (!renewed) {
      out.released++;
      logger.warn({ alertEmailId: r.id }, 'Email cảnh báo: lease đã bị lấy lại -> bỏ, không gửi');
      return;
    }
    const lease = renewed.lease;
    if (r.kind === 'RESOLVED') {
      // T-3: "đã ổn" chỉ đi sau thư OPEN của cùng người. OPEN còn đang chờ/đang gửi -> hoãn (không tốn lần thử);
      // OPEN đã FAILED (người nhận chưa từng thấy cảnh báo) -> không gửi "đã ổn".
      if (renewed.openState === 'PENDING') {
        if (await this.prisma.alertEmailOutboxMarkFailure(r.id, lease, { release: true, delayMs: ALERT_EMAIL_RESOLVED_DEFER_MS })) out.released++;
        return;
      }
      if (renewed.openState === 'FAILED') {
        if (await this.prisma.alertEmailOutboxMarkSuppressed(r.id, lease, 'ineligible:open_not_sent')) this.suppressed(out);
        return;
      }
    }
    let cap = caps.get(r.userId);
    if (!cap) {
      cap = await this.prisma.alertEmailOutboxCapState(r.userId, HOUR_MS);
      caps.set(r.userId, cap);
    }
    if (cap.sentInWindow >= ALERT_EMAIL_HOURLY_CAP) {
      if (await this.prisma.alertEmailOutboxMarkSuppressed(r.id, lease, 'cap')) {
        cap.rollupIds.push(r.id);
        this.suppressed(out);
      }
      logger.info({ alertEmailId: r.id, userId: r.userId }, 'Email cảnh báo vượt trần 6/giờ -> gộp vào thư kế tiếp');
      return;
    }

    const rollup = [...cap.rollupIds];
    let error: string | null = null;
    try {
      const msg = renderAlertEmail({
        kind: r.kind,
        locale: (r.locale === 'en' ? 'en' : 'vi') as AlertTextLocale,
        alert: {
          rule: r.rule,
          severity: r.severity,
          subjectType: r.subjectType,
          subjectId: r.subjectId,
          facts: r.facts,
          openedAt: new Date(r.openedAt),
          resolvedAt: r.resolvedAt ? new Date(r.resolvedAt) : null,
        },
        project: { id: r.tenantId, slug: r.projectSlug, name: r.projectName },
        subjectName: r.subjectName,
        // QT6: thư dung lượng tới owner nói đúng lý do nhận thư + link trang Dung lượng; `remind:` = thư nhắc hằng ngày.
        audience: r.isOwner && ruleAudience(r.rule) === 'owners+operator' ? 'owner' : 'operator',
        reminder: typeof r.tag === 'string' && r.tag.startsWith('remind:'),
        webUrl: this.webUrl,
        rollup: rollup.length,
        now,
      });
      await withDeadline(this.mailer().send({ to: r.email, ...msg }), this.opts.sendTimeoutMs);
    } catch (err: any) {
      error = String(err?.message ?? err ?? 'unknown');
    }

    if (error === null) {
      if (!(await this.prisma.alertEmailOutboxMarkSent(r.id, lease, rollup))) {
        out.released++;
        logger.warn({ alertEmailId: r.id }, 'Email cảnh báo đã gửi nhưng lease không còn của worker này -> không ghi SENT');
        return;
      }
      cap.sentInWindow++;
      cap.rollupIds = cap.rollupIds.filter((id) => !rollup.includes(id));
      out.sent++;
      alertEmailsTotal.inc({ result: 'sent' });
      return;
    }
    const retryMs = ALERT_EMAIL_RETRY_DELAYS_MS[Math.min(r.attempts, ALERT_EMAIL_RETRY_DELAYS_MS.length) - 1] ?? ALERT_EMAIL_RETRY_DELAYS_MS[0];
    const state = await this.prisma.alertEmailOutboxMarkFailure(r.id, lease, { error, maxAttempts: ALERT_EMAIL_MAX_ATTEMPTS, retryMs });
    if (state === 'FAILED') {
      out.failed++;
      alertEmailsTotal.inc({ result: 'failed' });
      logger.error({ alertEmailId: r.id, userId: r.userId, attempts: r.attempts, err: error }, 'Email cảnh báo FAILED sau 3 lần gửi lỗi');
    } else if (state === 'PENDING') {
      out.retried++;
      alertEmailsTotal.inc({ result: 'retry' });
      logger.warn({ alertEmailId: r.id, attempts: r.attempts, err: error }, 'Gửi email cảnh báo lỗi -> thử lại sau');
    } else {
      out.released++;
    }
  }
}

/** Hạn chót tổng của một lần gửi (TB-3): driver treo / mạng treo -> lỗi, dòng đi đường thử lại. */
function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    t = setTimeout(() => reject(new Error(`gửi email quá ${ms}ms`)), ms);
    t.unref?.();
  });
  return Promise.race([p, deadline]).finally(() => clearTimeout(t));
}
