/**
 * LOGGING.md §11.3 — chống bão cho Sentry phía trình duyệt: dedupe theo fingerprint trong cửa sổ + trần số event/phút,
 * đếm TRONG BỘ NHỚ của tab (không localStorage, không mạng). Hết gói free 5k errors vì một vòng lặp lỗi là rủi ro thật.
 */
export interface GateOptions {
  maxPerMin: number;
  dedupeMs: number;
  now?: () => number;
}

export interface Gate {
  /** true = cho gửi. */
  allow(key: string): boolean;
  stats(): { sent: number; deduped: number; dropped: number };
}

export function createGate({ maxPerMin, dedupeMs, now = Date.now }: GateOptions): Gate {
  const seen = new Map<string, number>();
  let minuteStart = 0;
  let minuteCount = 0;
  const s = { sent: 0, deduped: 0, dropped: 0 };
  return {
    allow(key) {
      const t = now();
      const last = seen.get(key);
      if (last !== undefined && t - last < dedupeMs) {
        s.deduped++;
        return false;
      }
      if (t - minuteStart >= 60_000) {
        minuteStart = t;
        minuteCount = 0;
      }
      if (minuteCount >= maxPerMin) {
        s.dropped++;
        return false;
      }
      minuteCount++;
      seen.delete(key);
      seen.set(key, t);
      if (seen.size > 200) {
        const oldest = seen.keys().next().value;
        if (oldest !== undefined) seen.delete(oldest);
      }
      s.sent++;
      return true;
    },
    stats: () => ({ ...s }),
  };
}

/** Khoá dedupe ổn định: loại lỗi + khung stack đầu (file:dòng) + thẻ nguyên nhân; không message (có thể chứa id biến thiên). */
export function eventFingerprintKey(event: any): string {
  const ex = event?.exception?.values?.[0];
  const frames: any[] = ex?.stacktrace?.frames ?? [];
  const top = frames[frames.length - 1];
  const where = top ? `${top.filename ?? ""}:${top.lineno ?? ""}` : String(event?.message ?? "").slice(0, 80);
  return [event?.tags?.frontend_cause ?? "", ex?.type ?? "", where].join("|");
}
