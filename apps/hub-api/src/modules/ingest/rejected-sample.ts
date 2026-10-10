/**
 * Chặn phình dữ liệu từ request KÝ SAI (S1-4, ADR-045).
 *
 * Request REJECTED chỉ là mẫu để điều tra (§7.1), không phải bằng chứng gốc như raw_event ACCEPTED.
 * Kẻ biết một source key có thể bắn tới giới hạn rate limit (100 req/phút) với body ~1MB — không
 * chặn thì ~14GB/ngày, Neon free chỉ có 0,5GB. Hai lớp chặn:
 *  (a) chỉ lưu tối đa 4KB đầu của body;
 *  (b) tối đa 20 bản ghi REJECTED/phút/source, đếm TRONG BỘ NHỚ tiến trình (không tốn lệnh Redis).
 *      Vượt thì vẫn trả 401 nhưng không ghi DB, chỉ log.
 */
export const REJECTED_BODY_MAX_BYTES = 4096;
export const REJECTED_MAX_PER_MINUTE = 20;
const WINDOW_MS = 60_000;
/** Khoá meta gắn vào cột `headers` (jsonb) — không cần migration thêm cột. */
export const REJECTED_META_KEY = '__hub_meta';

export interface RejectedSample {
  bodyRaw: Buffer;
  body: unknown;
  meta: { bodyTruncated: boolean; originalBytes: number };
}

export function sampleRejectedBody(rawBody: Buffer, parsedBody: unknown): RejectedSample {
  const truncated = rawBody.length > REJECTED_BODY_MAX_BYTES;
  const bodyRaw = truncated ? rawBody.subarray(0, REJECTED_BODY_MAX_BYTES) : rawBody;
  // Body đã parse có thể lớn bằng raw — khi cắt thì lưu bản xem trước dạng chuỗi, đúng 4KB đầu.
  const body = truncated
    ? { _truncatedPreview: bodyRaw.toString('utf8') }
    : typeof parsedBody === 'object' && parsedBody !== null
      ? parsedBody
      : {};
  return { bodyRaw: Buffer.from(bodyRaw), body, meta: { bodyTruncated: truncated, originalBytes: rawBody.length } };
}

/** Cửa sổ cố định 1 phút theo source, trong bộ nhớ. Nhiều instance hub-api thì trần là 20 × số instance. */
export class RejectedRecordLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();

  constructor(private readonly maxPerMinute = REJECTED_MAX_PER_MINUTE) {}

  /** true = được ghi DB; false = đã vượt trần trong phút này (chỉ log). */
  tryAcquire(sourceId: string, now = Date.now()): boolean {
    const w = this.windows.get(sourceId);
    if (!w || now - w.start >= WINDOW_MS) {
      this.windows.set(sourceId, { start: now, count: 1 });
      this.evictStale(now);
      return true;
    }
    if (w.count >= this.maxPerMinute) return false;
    w.count++;
    return true;
  }

  private evictStale(now: number) {
    if (this.windows.size < 1000) return;
    for (const [k, w] of this.windows) if (now - w.start >= WINDOW_MS) this.windows.delete(k);
  }
}
