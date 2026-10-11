// R2-1 (ADR-097): Shop tự lành khi hub chết lúc khởi động. `start()` thử `ensure` tới khi được (backoff 10s -> 60s, không
// giới hạn); `ensureNow()` single-flight cho webhook tới lúc chưa ghim. `ensure` trả `sourceIds` đã ghim (ADR-094).
export function backoffMs(attempt: number): number {
  return Math.min(60_000, 10_000 * 2 ** Math.max(0, attempt - 1));
}

type Log = { warn: (o: object, m: string) => void; info: (o: object, m: string) => void };
type Schedule = (fn: () => void, ms: number) => unknown;

export class HubRegistration {
  trustedSourceIds: string[] = [];
  lastError: string | null = null;
  private inflight: Promise<boolean> | null = null;
  private gen = 0; // SK2: đổi cài đặt -> thế hệ mới; kết quả ensure của thế hệ cũ bị bỏ

  constructor(
    private readonly ensure: () => Promise<string[]>,
    private readonly log: Log,
    private readonly schedule: Schedule = (fn, ms) => setTimeout(fn, ms),
  ) {}

  ensureNow(): Promise<boolean> {
    if (!this.inflight) {
      const gen = this.gen;
      const p: Promise<boolean> = this.ensure()
        .then((ids) => {
          if (gen !== this.gen) return false;
          [this.trustedSourceIds, this.lastError] = [ids, null];
          return true;
        })
        .catch((e: any) => {
          if (gen === this.gen) this.lastError = String(e?.message ?? e);
          this.log.warn({ err: e?.message, code: e?.code }, '[Shop] Đăng ký endpoint với hub lỗi');
          return false;
        })
        .finally(() => {
          if (this.inflight === p) this.inflight = null;
        });
      this.inflight = p;
    }
    return this.inflight;
  }

  /** SK2: hub/nguồn tin cậy đổi -> quên nguồn cũ NGAY (webhook nguồn cũ không còn được tin), lần ensure sau dùng cấu hình mới. */
  reset(): void {
    [this.gen, this.trustedSourceIds, this.inflight, this.lastError] = [this.gen + 1, [], null, null];
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
