import { Injectable, OnModuleInit, Optional } from '@nestjs/common';
import {
  ALERT_RULES,
  AlertRuleCode,
  CleanupSuggestion,
  HUB_PROJECT_STORAGE,
  STORAGE_ALERT_RULES,
  StorageLevel,
  forecastHours,
  logger,
  parseStorageLevel,
  planStorageEmail,
  quotaBytesFor,
  resolveProjectStorageQuotaMb,
  resolveStorageAutoCleanEnabled,
  resolveStorageLockEnabled,
  storageEmailRecipients,
  storageRuleForLevel,
  storageSignalDue,
  validateCanonical,
} from '@hub/common';
import { AlertRow, PrismaService, StorageTickRow } from '@hub/database';
import { AlertEvaluator } from './alert.evaluator';
import { emitHubEvent } from './hub-events';
import { LevelChange, StorageJob } from './storage.job';

/**
 * QT6 (SPEC-han-muc-dung-luong §3, §6, §8 + ĐÍNH CHÍNH E3/E5, ADR-190): cảnh báo dung lượng — cắm vào StorageJob
 * (`onLevelChange` + quét bù `onTick` + chốt ổ `onDiskCheck`). Không job mới, không tiến trình mới (ADR-020).
 *
 * MỘT lần "báo" = MỘT transaction của project:
 *   khoá `project_usage` (FOR UPDATE) -> nấc hiện tại vs `signaled_level`:
 *     - lệch: đóng alert nấc cũ / mở alert nấc mới (`project.storage_warn|critical|locked`), phát `hub.project.storage`
 *       qua outbox (`emitHubEvent` — đường của mọi event, vẫn phát khi LOCKED), ghi `signaled_level`.
 *     - kế hoạch email (`planStorageEmail`): nấc đi LÊN -> một thư `up:<nấc>:<ngày>`; 95%/LOCKED -> nhắc mỗi 24h
 *       `remind:<nấc>:<ngày>`. Thư vào outbox `alert_emails` cho từng owner + operator (trần 6/giờ/người của vòng gửi CB).
 *   COMMIT rồi mới PUBLISH realtime (alert.changed, kèm audience -> room owners). Hai đường báo cùng lúc xếp hàng ở FOR
 *   UPDATE; đường sau thấy đã khớp nên không phát lần hai -> "đúng một event mỗi lần đổi nấc".
 * Lỗi ở đây KHÔNG làm hỏng lượt đo (StorageJob nuốt lỗi hook); lượt nấc kế tiếp thấy `signaled_level` lệch và báo bù.
 */
@Injectable()
export class StorageAlerts implements OnModuleInit {
  private readonly lockEnabled = resolveStorageLockEnabled();
  private readonly autoCleanEnabled = resolveStorageAutoCleanEnabled();
  private readonly defaultQuotaMb = resolveProjectStorageQuotaMb();
  /** Đồng hồ (test thay được). */
  clock: () => number = Date.now;

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly storage?: StorageJob,
    @Optional() private readonly evaluator?: AlertEvaluator,
  ) {}

  onModuleInit() {
    if (!this.storage) return;
    this.storage.onLevelChange.push((c) => this.onLevelChange(c));
    this.storage.onTick.push((rows) => this.sweep(rows));
    this.storage.onDiskCheck.push((d) => this.diskCheck(d));
  }

  private async onLevelChange(c: LevelChange): Promise<void> {
    await this.signal(c.tenantId, c.quotaBytes);
  }

  /** Lượt nấc 60s: báo bù project có `signaled_level` lệch / tới hạn nhắc email (so trong bộ nhớ, +0 truy vấn khi không). */
  async sweep(rows: (StorageTickRow & { finalLevel: StorageLevel })[]): Promise<number> {
    const now = new Date(this.clock());
    let n = 0;
    for (const r of rows) {
      const due = storageSignalDue({ level: r.finalLevel, signaledLevel: r.signaledLevel ?? null, notifiedLevel: r.notifiedLevel ?? null, notifiedAt: r.notifiedAt ?? null, now });
      if (!due) continue;
      try {
        if (await this.signal(r.tenantId, quotaBytesFor(r.quotaMb, this.defaultQuotaMb))) n++;
      } catch (err: any) {
        logger.warn({ err: err?.message, tenantId: r.tenantId }, 'Storage alerts: báo bù lỗi (lượt sau thử lại)');
      }
    }
    return n;
  }

  /**
   * Báo MỘT project (idempotent). Trả true nếu lần này có làm gì (đổi alert / phát webhook / tạo email).
   * `quotaBytes` không truyền -> đọc hạn mức của project.
   */
  async signal(tenantId: string, quotaBytes?: number): Promise<boolean> {
    const now = new Date(this.clock());
    let quota = quotaBytes;
    if (quota === undefined) {
      const p = await this.prisma.findProjectById(tenantId);
      if (!p) return false;
      quota = quotaBytesFor((p as { storageQuotaMb?: number | null }).storageQuotaMb, this.defaultQuotaMb);
    }
    const idn = this.prisma.identity();
    // Người nhận đọc NGOÀI transaction khoá (bảng danh tính, không RLS) — lỗi đọc thì lần này không email, alert vẫn đúng.
    // Review QT-S3 L1: lỗi đọc -> KHÔNG ghi dấu email (giữ notified_level/at cũ) để lượt nấc sau gửi bù, không mất thư 70/85.
    let recipientsOk = true;
    const failed = (err: any) => {
      recipientsOk = false;
      logger.warn({ err: err?.message, tenantId }, 'Storage alerts: lỗi đọc người nhận email — lượt sau gửi bù');
      return [];
    };
    const [owners, operators] = await Promise.all([
      idn.listProjectOwnersForStorageEmail(tenantId).catch(failed),
      idn.listAlertEmailRecipients().catch(failed),
    ]);
    const out = await this.prisma.tenantTx(tenantId, async (tx) => {
      const repo = this.prisma.forTenant(tenantId, tx);
      const u = await repo.lockProjectUsageForSignal();
      if (!u) return null;
      const level = parseStorageLevel(u.level);
      const signaled = u.signaledLevel === null ? 'OK' : parseStorageLevel(u.signaledLevel);
      const changed = level !== signaled;
      const planned = planStorageEmail({ level, notifiedLevel: u.notifiedLevel, notifiedAt: u.notifiedAt, now });
      const plan = recipientsOk
        ? planned
        : { send: null, notifiedLevel: u.notifiedLevel === null ? null : parseStorageLevel(u.notifiedLevel), notifiedAt: u.notifiedAt };
      const notifiedSame = plan.notifiedLevel === (u.notifiedLevel === null ? null : parseStorageLevel(u.notifiedLevel)) && plan.notifiedAt?.getTime() === u.notifiedAt?.getTime();
      if (!changed && !plan.send && notifiedSame) return { notices: [] as { alert: AlertRow; rule: AlertRuleCode; to: 'OPEN' | 'RESOLVED' }[], acted: false };

      const traffic24h = await repo.trafficBytesSince(new Date(now.getTime() - 86_400_000));
      const forecast = forecastHours(u.usedBytes, quota!, u.bloatFactor, traffic24h);
      const suggestion = bestSuggestion(u.suggestions);
      const facts = {
        level,
        previousLevel: signaled,
        usedBytes: Math.max(0, Math.round(u.usedBytes)),
        quotaBytes: quota!,
        pct: quota! > 0 ? Math.round((u.usedBytes / quota!) * 1000) / 10 : 0,
        forecastHours: forecast,
        suggestion: suggestion
          ? { action: suggestion.action, importance: suggestion.importance, olderThan: suggestion.olderThan, estimatedBytes: suggestion.estimatedBytes, estimatedEvents: suggestion.estimatedEvents }
          : null,
        lockEnabled: this.lockEnabled,
        autoCleanEnabled: this.autoCleanEnabled,
        calibratedAt: u.calibratedAt ? u.calibratedAt.toISOString() : null,
      };
      const notices: { alert: AlertRow; rule: AlertRuleCode; to: 'OPEN' | 'RESOLVED' }[] = [];
      const want = storageRuleForLevel(level);
      let alertId: string | null = null;
      // Đóng alert của nấc khác, mở/làm mới alert của nấc hiện tại (facts mới — kể cả lượt nhắc).
      const open = await repo.findOpenAlertsByRules([...STORAGE_ALERT_RULES], tenantId);
      for (const a of open) {
        if (a.rule === want) continue;
        const r = await repo.resolveAlertById(a.id, now, { resolvedLevel: level });
        if (r) notices.push({ alert: r, rule: a.rule as AlertRuleCode, to: 'RESOLVED' });
      }
      if (want) {
        const meta = ALERT_RULES[want];
        const r = await repo.upsertOpenAlert({ rule: want, severity: meta.severity, subjectType: meta.subjectType, subjectId: tenantId, facts, now });
        alertId = r.alert.id;
        if (r.opened) notices.push({ alert: r.alert, rule: want, to: 'OPEN' });
      }
      if (changed) {
        // §3: MỖI lần đổi nấc (lên hay xuống) đúng MỘT `hub.project.storage` — outbox bình thường, vẫn phát khi LOCKED.
        let data: Record<string, unknown> = {
          level,
          previousLevel: signaled,
          usedBytes: facts.usedBytes,
          quotaBytes: quota!,
          forecastHours: forecast,
          suggestion: suggestion ?? null,
          lockEnabled: this.lockEnabled,
        };
        if (!validateCanonical(HUB_PROJECT_STORAGE, data).ok) data = { ...data, suggestion: null }; // gợi ý cũ sai khuôn -> bỏ, không chặn báo
        await emitHubEvent(tx, repo, tenantId, { type: HUB_PROJECT_STORAGE, data, now });
      }
      if (plan.send && alertId && want) {
        const users = storageEmailRecipients(want, tenantId, owners, operators);
        await repo.enqueueAlertEmails(alertId, 'OPEN', users, plan.send.tag);
      }
      await repo.markStorageSignaled({ signaledLevel: level, notifiedLevel: plan.notifiedLevel, notifiedAt: plan.notifiedAt });
      logger.info({ cause: 'growth.storage', tenantId, from: signaled, to: level, changed, email: plan.send?.reason ?? null }, 'Storage alerts: đã báo nấc dung lượng');
      return { notices, acted: true };
    });
    if (!out) return false;
    for (const n of out.notices) this.evaluator?.announce(n.alert, n.rule, n.to);
    return out.acted;
  }

  /**
   * §6 (ADR-185/190): chốt ổ toàn cục -> cảnh báo operator `hub.storage_near_full`. Bảng alerts bắt buộc tenant -> neo vào
   * project LÂU ĐỜI NHẤT (ổn định giữa các lượt; xoá project đó thì alert đi theo CASCADE và lượt sau mở lại ở project kế).
   */
  async diskCheck(d: { sizeBytes: number; nearFull: boolean; budgetMb: number; top: { tenantId: string; usedBytes: number }[] }): Promise<void> {
    const idn = this.prisma.identity();
    const [anchor] = await idn.listProjectIds();
    if (!anchor) return;
    const rule = 'hub.storage_near_full' as const;
    const now = new Date(this.clock());
    const operators = d.nearFull ? await idn.listAlertEmailRecipients().catch(() => []) : [];
    const notices = await this.prisma.tenantTx(anchor, async (tx) => {
      const repo = this.prisma.forTenant(anchor, tx);
      const out: { alert: AlertRow; to: 'OPEN' | 'RESOLVED' }[] = [];
      if (d.nearFull) {
        const budgetBytes = Math.round(d.budgetMb * 1024 * 1024);
        const facts = { sizeBytes: d.sizeBytes, budgetBytes, pct: Math.round((d.sizeBytes / budgetBytes) * 1000) / 10, top: d.top.slice(0, 3) };
        const meta = ALERT_RULES[rule];
        const r = await repo.upsertOpenAlert({ rule, severity: meta.severity, subjectType: meta.subjectType, subjectId: anchor, facts, now });
        if (r.opened) {
          out.push({ alert: r.alert, to: 'OPEN' });
          const users = operators.filter((o) => o.emailRules.includes(rule)).map((o) => o.userId);
          await repo.enqueueAlertEmails(r.alert.id, 'OPEN', users);
        }
      } else {
        for (const a of await repo.findOpenAlertsByRules([rule], anchor)) {
          const r = await repo.resolveAlertById(a.id, now, {});
          if (r) out.push({ alert: r, to: 'RESOLVED' });
        }
      }
      return out;
    });
    for (const n of notices) this.evaluator?.announce(n.alert, rule, n.to);
  }
}

/** Gợi ý giải phóng nhiều nhất trong bộ đã lưu (đã qua hàng rào lúc lưu) — null nếu không có / sai hình. */
export function bestSuggestion(raw: unknown): CleanupSuggestion | null {
  if (!Array.isArray(raw)) return null;
  let best: CleanupSuggestion | null = null;
  for (const s of raw as CleanupSuggestion[]) {
    if (!s || typeof s !== 'object' || typeof s.estimatedBytes !== 'number') continue;
    if (!best || s.estimatedBytes > best.estimatedBytes) best = s;
  }
  return best;
}
