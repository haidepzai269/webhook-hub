import { Inject, Injectable, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { ALERT_EMAIL_HOURLY_CAP, AlertTextLocale, MailSender, createMailSender, logger, renderAlertEmail } from '@hub/common';
import { AlertEmailClaim, PrismaService } from '@hub/database';
import { alertEmailsTotal } from '../metrics';

/**
 * CB5 (SPEC-canh-bao-nhan-dinh §6, DINH-CHINH D1/D2, ADR-173): VÒNG GỬI email cảnh báo — job trong `hub-worker` (không
 * tiến trình mới, ADR-020/BB-4), TÁCH khỏi AlertEvaluator: evaluator chỉ ghi dòng PENDING vào outbox `alert_emails` cùng
 * transaction đổi trạng thái; gửi lỗi/chậm ở đây không bao giờ chặn evaluator (CB:T13).
 *
 * Mỗi lượt:
 *  1. Lấy lô bằng `FOR UPDATE SKIP LOCKED` trong transaction NGẮN (escape hatch có tên `alertEmailOutboxClaim`, xuyên
 *     project như cleanup.job): tăng `attempts`, đặt lease, COMMIT. Nhiều worker không lấy trùng dòng.
 *  2. NGOÀI transaction, từng dòng: kiểm lại điều kiện lúc gửi (vẫn operator, email đã xác minh, còn bật email, luật còn
 *     trong `email_rules`, project không bị tắt tiếng, `email_on_resolve` cho thư lúc đóng) -> sai thì SUPPRESSED;
 *     trần 6 email/giờ/người -> SUPPRESSED `cap`, thư kế tiếp của người đó có dòng "…và k cảnh báo khác".
 *  3. Gửi qua `createMailSender()` (driver log|gmail|resend|capture); xong -> SENT. Lỗi -> thử lại sau 1 phút / 5 phút;
 *     lần thứ 3 vẫn lỗi -> FAILED (log + `hub_alert_emails_total{result="failed"}`).
 * At-least-once: worker chết sau khi gửi mà trước khi ghi SENT -> hết lease, gửi lại một lần (chấp nhận, ADR-173).
 */
export const ALERT_MAIL_SENDER = Symbol('ALERT_MAIL_SENDER');

export const ALERT_EMAIL_INTERVAL_MS = 15_000;
export const ALERT_EMAIL_BATCH = 20;
export const ALERT_EMAIL_MAX_ATTEMPTS = 3;
/** Lease của một dòng đang gửi — dài hơn mọi lần gọi nhà mail; hết lease thì worker khác lấy lại. */
export const ALERT_EMAIL_LEASE_MS = 120_000;
/** Lùi thời gian sau lần lỗi thứ 1, 2 (lần 3 -> FAILED). */
export const ALERT_EMAIL_RETRY_DELAYS_MS = [60_000, 300_000] as const;
const HOUR_MS = 3_600_000;

export type EligibilityProblem = 'not_operator' | 'email_unverified' | 'email_disabled' | 'rule_not_selected' | 'project_muted' | 'resolve_not_wanted';

/** Hàm thuần: điều kiện §6 kiểm LẠI lúc gửi (tuỳ chọn có thể đã đổi từ lúc evaluator ghi PENDING). null = được gửi. */
export function alertEmailEligibility(
  r: Pick<AlertEmailClaim, 'isOperator' | 'emailVerified' | 'emailEnabled' | 'emailRules' | 'mutedProjects' | 'emailOnResolve' | 'rule' | 'tenantId' | 'kind'>,
): EligibilityProblem | null {
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
}

@Injectable()
export class AlertEmailSender implements OnModuleInit, OnModuleDestroy {
  private mail: MailSender | null;
  private readonly intervalMs: number;
  private readonly webUrl: string;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopping = false;
  private lap: Promise<AlertEmailRunResult> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    @Optional() @Inject(ALERT_MAIL_SENDER) mail?: MailSender,
  ) {
    this.mail = mail ?? null;
    const env = process.env.ALERT_EMAIL_INTERVAL_MS;
    const n = env === undefined || env === '' ? ALERT_EMAIL_INTERVAL_MS : parseInt(env, 10);
    this.intervalMs = Number.isFinite(n) && n >= 0 ? n : ALERT_EMAIL_INTERVAL_MS;
    this.webUrl = process.env.WEB_PUBLIC_URL ?? '';
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
        full = (await this.sendOnce(new Date())).claimed >= ALERT_EMAIL_BATCH;
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

  /** Một lượt. `now` tiêm vào (test). */
  sendOnce(now: Date = new Date()): Promise<AlertEmailRunResult> {
    const lap = this.runLap(now);
    this.lap = lap;
    return lap.finally(() => {
      if (this.lap === lap) this.lap = null;
    });
  }

  private async runLap(now: Date): Promise<AlertEmailRunResult> {
    const out: AlertEmailRunResult = { claimed: 0, sent: 0, suppressed: 0, retried: 0, failed: 0 };
    if (this.stopping) return out;
    const rows = await this.prisma.alertEmailOutboxClaim(now, ALERT_EMAIL_BATCH, ALERT_EMAIL_LEASE_MS);
    out.claimed = rows.length;
    // Trạng thái trần theo người, đọc một lần mỗi lượt rồi cộng dồn tại chỗ (dòng đã xếp theo user_id).
    const caps = new Map<string, { sentInWindow: number; rollupIds: string[] }>();
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (this.stopping) {
        // Shutdown: trả các dòng chưa gửi (bớt lại lần thử đã tính) — worker khác/lần chạy sau lấy ngay.
        for (const rest of rows.slice(i)) await this.prisma.alertEmailOutboxMarkFailure(rest.id, { release: true }).catch(() => null);
        break;
      }
      try {
        await this.processOne(r, now, caps, out);
      } catch (err: any) {
        // Lỗi DB khi ghi kết quả: dòng giữ lease, hết lease thì được lấy lại (lần thử đã tính).
        logger.error({ err: err?.message, alertEmailId: r.id }, 'Alert email sender: không ghi được kết quả một email');
      }
    }
    return out;
  }

  private async processOne(r: AlertEmailClaim, now: Date, caps: Map<string, { sentInWindow: number; rollupIds: string[] }>, out: AlertEmailRunResult) {
    const problem = alertEmailEligibility(r);
    if (problem) {
      await this.prisma.alertEmailOutboxMarkSuppressed(r.id, `ineligible:${problem}`);
      out.suppressed++;
      alertEmailsTotal.inc({ result: 'suppressed' });
      logger.info({ alertEmailId: r.id, userId: r.userId, problem }, 'Email cảnh báo không gửi: người nhận không còn đủ điều kiện');
      return;
    }
    let cap = caps.get(r.userId);
    if (!cap) {
      cap = await this.prisma.alertEmailOutboxCapState(r.userId, new Date(now.getTime() - HOUR_MS));
      caps.set(r.userId, cap);
    }
    if (cap.sentInWindow >= ALERT_EMAIL_HOURLY_CAP) {
      if (await this.prisma.alertEmailOutboxMarkSuppressed(r.id, 'cap')) cap.rollupIds.push(r.id);
      out.suppressed++;
      alertEmailsTotal.inc({ result: 'suppressed' });
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
        webUrl: this.webUrl,
        rollup: rollup.length,
        now,
      });
      await this.mailer().send({ to: r.email, ...msg });
    } catch (err: any) {
      error = String(err?.message ?? err ?? 'unknown');
    }

    if (error === null) {
      await this.prisma.alertEmailOutboxMarkSent(r.id, now, rollup);
      cap.sentInWindow++;
      cap.rollupIds = cap.rollupIds.filter((id) => !rollup.includes(id));
      out.sent++;
      alertEmailsTotal.inc({ result: 'sent' });
      return;
    }
    const delay = ALERT_EMAIL_RETRY_DELAYS_MS[Math.min(r.attempts, ALERT_EMAIL_RETRY_DELAYS_MS.length) - 1] ?? ALERT_EMAIL_RETRY_DELAYS_MS[0];
    const state = await this.prisma.alertEmailOutboxMarkFailure(r.id, { error, maxAttempts: ALERT_EMAIL_MAX_ATTEMPTS, retryAt: new Date(now.getTime() + delay) });
    if (state === 'FAILED') {
      out.failed++;
      alertEmailsTotal.inc({ result: 'failed' });
      logger.error({ alertEmailId: r.id, userId: r.userId, attempts: r.attempts, err: error }, 'Email cảnh báo FAILED sau 3 lần gửi lỗi');
    } else {
      out.retried++;
      alertEmailsTotal.inc({ result: 'retry' });
      logger.warn({ alertEmailId: r.id, attempts: r.attempts, err: error }, 'Gửi email cảnh báo lỗi -> thử lại sau');
    }
  }
}
