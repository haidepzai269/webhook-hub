/**
 * R2-1 (ADR-097): Shop tự lành khi hub chết lúc khởi động (Render free: autosuspend, cold start 30–60s+).
 * - `start()`: thử `ensure` tới khi thành công — KHÔNG giới hạn số lần, backoff 10s -> 20s -> 40s -> 60s (trần).
 * - `ensureNow()`: single-flight — webhook tới lúc chưa ghim gọi ngay (hub đang gửi webhook tức là hub đã sống),
 *   mọi lời gọi đồng thời dùng chung một promise.
 * `ensure` trả `sourceIds` của subscription đã ghim (bằng chứng nguồn tin cậy, ADR-094).
 */
export function backoffMs(attempt: number): number {
  return Math.min(60_000, 10_000 * 2 ** Math.max(0, attempt - 1));
}

type Log = { warn: (o: object, m: string) => void; info: (o: object, m: string) => void };
type Schedule = (fn: () => void, ms: number) => unknown;

export class HubRegistration {
  trustedSourceIds: string[] = [];
  private inflight: Promise<boolean> | null = null;

  constructor(
    private readonly ensure: () => Promise<string[]>,
    private readonly log: Log,
    private readonly schedule: Schedule = (fn, ms) => setTimeout(fn, ms),
  ) {}

  ensureNow(): Promise<boolean> {
    if (!this.inflight) {
      this.inflight = this.ensure()
        .then((ids) => {
          this.trustedSourceIds = ids;
          return true;
        })
        .catch((e: any) => {
          this.log.warn({ err: e?.message, code: e?.code }, '[Shop] Đăng ký endpoint với hub lỗi');
          return false;
        })
        .finally(() => {
          this.inflight = null;
        });
    }
    return this.inflight;
  }

  start(attempt = 1): void {
    void this.ensureNow().then((ok) => {
      if (ok || this.trustedSourceIds.length > 0) return;
      const ms = backoffMs(attempt);
      this.log.info({ attempt, retryInMs: ms }, '[Shop] Sẽ thử đăng ký lại với hub');
      this.schedule(() => this.start(attempt + 1), ms);
    });
  }
}
