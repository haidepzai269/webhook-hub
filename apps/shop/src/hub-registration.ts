// R2-1 (ADR-097): Shop tự lành khi hub chết lúc khởi động. `start()` thử `ensure` tới khi được (backoff 10s -> 60s, không
// giới hạn); `ensureNow()` single-flight cho webhook tới lúc chưa ghim. `ensure` trả `sourceIds` đã ghim (ADR-094).
export const backoffMs = (attempt: number): number => Math.min(60_000, 10_000 * 2 ** Math.max(0, attempt - 1));
type Log = { warn: (o: object, m: string) => void; info: (o: object, m: string) => void };
type Schedule = (fn: () => void, ms: number) => unknown;
export class HubRegistration {
  trustedSourceIds: string[] = [];
  lastError: string | null = null;
  private inflight: Promise<boolean> | null = null;
  private gen = 0; // SK2: đổi cài đặt -> thế hệ mới; kết quả ensure của thế hệ cũ bị bỏ
  constructor(private readonly ensure: () => Promise<string[]>, private readonly log: Log, private readonly schedule: Schedule = (fn, ms) => setTimeout(fn, ms)) {}
  ensureNow(): Promise<boolean> {
    if (this.inflight) return this.inflight;
    const gen = this.gen;
    const p: Promise<boolean> = this.ensure()
      .then((ids) => { if (gen !== this.gen) return false; [this.trustedSourceIds, this.lastError] = [ids, null]; return true; })
      .catch((e: any) => [gen === this.gen && (this.lastError = String(e?.message ?? e)), this.log.warn({ err: e?.message, code: e?.code }, '[Shop] Đăng ký endpoint với hub lỗi'), false][2] as boolean)
      .finally(() => this.inflight === p && (this.inflight = null));
    return (this.inflight = p);
  }
  /** SK2: hub/nguồn tin cậy đổi -> thế hệ mới; nguồn cũ hết được tin NGAY. H-1: `trusted` = sourceIds vừa VERIFIED trên cấu hình mới. */
  reset(trusted: string[] = []): void {
    [this.gen, this.trustedSourceIds, this.inflight, this.lastError] = [this.gen + 1, trusted, null, null];
  }
  start(attempt = 1): void {
    void this.ensureNow().then((ok) => {
      if (ok || this.trustedSourceIds.length > 0) return;
      this.log.info({ attempt, retryInMs: backoffMs(attempt) }, '[Shop] Sẽ thử đăng ký lại với hub');
      this.schedule(() => this.start(attempt + 1), backoffMs(attempt));
    });
  }
}
