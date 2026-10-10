import axios, { AxiosRequestConfig } from 'axios';

/**
 * Giới hạn HTTP chiều ra dùng chung cho mọi sender (review SPEC-1, ADR-051 phần phụ; sửa ở ADR-054).
 *
 * - axios `timeout` chỉ là IDLE timeout của socket: đích nhả từng byte một vẫn giữ worker vô hạn.
 *   `signal: AbortSignal.timeout(ms)` chặn TỔNG thời gian một lần gửi.
 * - Body GỬI đi: `maxBodyLength` 64KB.
 * - Body NHẬN về: KHÔNG dùng `maxContentLength` nữa (review SPEC-2 #5) — nó biến một phản hồi 2xx có
 *   body lớn thành lỗi -> 500 -> retry -> GỬI TRÙNG cho đích đã nhận rồi. Thay vào đó đọc phản hồi
 *   dạng stream, giữ tối đa 64KB rồi huỷ phần còn lại; status lấy từ dòng trạng thái — 2xx vẫn là 2xx.
 *
 * Signal tạo MỚI mỗi lần gửi (AbortSignal.timeout bắt đầu đếm từ lúc tạo).
 */
export const DEFAULT_SEND_TIMEOUT_MS = 5000;

/**
 * S10 (SPEC §4.9, ADR-078): `DELIVERY_TIMEOUT_MS` — trần TỔNG một lần gửi, kẹp 1000–10000ms (mặc định 5000).
 * Trên 10s: một đích chậm giữ consumer quá lâu (noisy neighbor, hướng A); dưới 1s: đích bình thường cũng timeout.
 * Đọc MỘT lần lúc load (đổi phải restart worker).
 */
export function resolveSendTimeoutMs(env = process.env.DELIVERY_TIMEOUT_MS): number {
  const n = env === undefined || env === '' ? NaN : Number(env);
  if (!Number.isFinite(n)) return DEFAULT_SEND_TIMEOUT_MS;
  return Math.min(10_000, Math.max(1_000, Math.round(n)));
}

export const SEND_TIMEOUT_MS = resolveSendTimeoutMs();
export const SEND_MAX_BYTES = 64 * 1024;
/** Đọc tối đa từng này byte của phản hồi; phần dư bị huỷ (không làm phình RAM worker). */
export const RESPONSE_READ_MAX_BYTES = 64 * 1024;

export function outboundLimits(timeoutMs = SEND_TIMEOUT_MS) {
  return {
    timeout: timeoutMs,
    signal: AbortSignal.timeout(timeoutMs),
    maxBodyLength: SEND_MAX_BYTES,
  };
}

/** Thông điệp lỗi dễ đọc: abort do hết hạn tổng -> nói rõ là timeout. */
export function describeSendError(err: any, timeoutMs = SEND_TIMEOUT_MS): string {
  if (err?.code === 'ERR_CANCELED' || err?.name === 'CanceledError' || err?.name === 'AbortError' || err?.name === 'TimeoutError') {
    return `timeout tổng ${timeoutMs}ms (AbortSignal)`;
  }
  return err?.message ?? String(err);
}

export interface LimitedResponse {
  status: number;
  /** Tối đa RESPONSE_READ_MAX_BYTES đầu tiên, utf-8. */
  body: string;
  /** Phản hồi dài hơn trần (hoặc bị cắt giữa chừng) — phần còn lại đã bị huỷ. */
  truncated: boolean;
}

function isReadable(x: any): x is NodeJS.ReadableStream & { destroy?: (e?: Error) => void } {
  return x !== null && typeof x === 'object' && typeof x.on === 'function' && typeof x.pipe === 'function';
}

/**
 * Đọc tối đa `maxBytes` từ stream rồi huỷ phần còn lại. Không bao giờ reject: lỗi giữa chừng (đích
 * cắt kết nối, abort tổng) chỉ làm body ngắn đi — status đã có từ trước rồi.
 */
export function readCapped(data: unknown, maxBytes = RESPONSE_READ_MAX_BYTES, timeoutMs = SEND_TIMEOUT_MS): Promise<{ body: string; truncated: boolean }> {
  if (!isReadable(data)) {
    // Không phải stream (adapter khác / test giả): chuẩn hoá thành chuỗi, cắt trần.
    const s = data === undefined || data === null ? '' : typeof data === 'string' ? data : Buffer.isBuffer(data) ? data.toString('utf8') : JSON.stringify(data);
    return Promise.resolve({ body: s.slice(0, maxBytes), truncated: s.length > maxBytes });
  }
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (truncated: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      data.removeListener('data', onData);
      try {
        data.destroy?.();
      } catch {}
      resolve({ body: Buffer.concat(chunks).subarray(0, maxBytes).toString('utf8'), truncated });
    };
    const onData = (chunk: Buffer | string) => {
      const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      chunks.push(b);
      size += b.length;
      if (size >= maxBytes) finish(true); // đủ trần: phần còn lại (nếu có) bị huỷ
    };
    const timer = setTimeout(() => finish(true), timeoutMs);
    data.on('data', onData);
    data.once('end', () => finish(size > maxBytes));
    data.once('error', () => finish(true));
    data.once('close', () => finish(size > maxBytes));
  });
}

/**
 * POST có giới hạn: status từ dòng trạng thái (KHÔNG ném cho non-2xx), body đọc tối đa 64KB.
 * Ném lỗi CHỈ khi không có phản hồi (lỗi mạng, timeout trước khi có header, SSRF agent từ chối).
 */
export async function postLimited(
  url: string,
  data: unknown,
  config: Pick<AxiosRequestConfig, 'headers' | 'httpAgent' | 'httpsAgent'>,
  timeoutMs = SEND_TIMEOUT_MS,
): Promise<LimitedResponse> {
  const res = await axios.post(url, data, {
    ...outboundLimits(timeoutMs),
    ...config,
    maxRedirects: 0,
    responseType: 'stream',
    validateStatus: () => true,
  });
  const { body, truncated } = await readCapped(res.data, RESPONSE_READ_MAX_BYTES, timeoutMs);
  return { status: res.status, body, truncated };
}

/** Lỗi gửi dạng chuẩn cho non-2xx (giữ giống thông điệp axios cũ để log/lastError không đổi nghĩa). */
export function httpErrorMessage(status: number): string | undefined {
  return status >= 200 && status < 300 ? undefined : `Request failed with status code ${status}`;
}
