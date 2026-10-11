/**
 * Gộp toast `trace.ingested` (review SPEC-2 #8, ADR-054) — logic THUẦN, không React, để test được.
 *
 * - Mốc "đã toast tới đâu" (`watermark`) nằm trong store realtime, KHÔNG trong `useRef` của component:
 *   mount lại trang Sự kiện không toast lại cả loạt trace cũ.
 * - Bị dội (vd 50 request chữ ký sai/giây) -> tối đa MỘT toast mỗi `windowMs`, kèm "+N" số còn lại;
 *   phần dồn lại được xả khi cửa sổ hết (component đặt hẹn giờ theo `flushInMs`).
 */
export const TOAST_WINDOW_MS = 2000;
export const NOTABLE_OUTCOMES = new Set(["REJECTED", "DUPLICATE", "RATE_LIMITED"]);

export interface ToastableTrace {
  receivedAt: number;
  outcome: string;
}

export interface ToastCursor<T extends ToastableTrace = ToastableTrace> {
  /** receivedAt lớn nhất đã xét. */
  watermark: number;
  /** Lúc hiện toast gần nhất (ms). */
  lastToastAt: number;
  /** Số trace đáng báo đang dồn, chưa toast. */
  pending: number;
  /** Trace đáng báo mới nhất trong phần đang dồn — là trace sẽ được toast. */
  latest: T | null;
}

export function emptyToastCursor<T extends ToastableTrace>(): ToastCursor<T> {
  return { watermark: 0, lastToastAt: 0, pending: 0, latest: null };
}

export interface ToastStep<T extends ToastableTrace> {
  toast: { trace: T; more: number } | null;
  cursor: ToastCursor<T>;
  /** Còn dồn mà chưa tới lượt -> gọi lại sau từng này ms để xả. */
  flushInMs: number | null;
}

/** `traces` mới nhất ở đầu (như store realtime). */
export function stepToasts<T extends ToastableTrace>(
  traces: readonly T[],
  cur: ToastCursor<T>,
  now: number,
  windowMs = TOAST_WINDOW_MS,
): ToastStep<T> {
  const fresh = traces.filter((t) => t.receivedAt > cur.watermark);
  const watermark = fresh.reduce((m, t) => Math.max(m, t.receivedAt), cur.watermark);
  const notable = fresh.filter((t) => NOTABLE_OUTCOMES.has(t.outcome));
  const newest = notable.reduce<T | null>((a, t) => (!a || t.receivedAt > a.receivedAt ? t : a), null);
  const pending = cur.pending + notable.length;
  const latest = newest ?? cur.latest;

  if (pending === 0 || !latest) {
    return { toast: null, cursor: { ...cur, watermark, pending: 0, latest: null }, flushInMs: null };
  }
  const since = now - cur.lastToastAt;
  if (since >= windowMs) {
    return {
      toast: { trace: latest, more: pending - 1 },
      cursor: { watermark, lastToastAt: now, pending: 0, latest: null },
      flushInMs: null,
    };
  }
  return {
    toast: null,
    cursor: { watermark, lastToastAt: cur.lastToastAt, pending, latest },
    flushInMs: windowMs - since,
  };
}

/**
 * Callback cho setInterval của đồng hồ đếm ngược: cập nhật "now" và TỰ dừng khi về 0
 * (review SPEC-2 #8 — trước đây interval chạy mãi sau khi đã tới giờ).
 */
export function countdownTicker(
  target: number,
  setNow: (n: number) => void,
  stop: () => void,
  clock: () => number = Date.now,
): () => void {
  return () => {
    const n = clock();
    setNow(n);
    if (n >= target) stop();
  };
}

/**
 * Mọi mutation có ghi audit_logs phải làm mới cả danh sách audit — gom một chỗ để không quên
 * (review SPEC-2 #8: renormalize/tạo nguồn/đích/subscription từng không invalidate ["audit"]).
 */
export const AUDIT_KEY = ["audit"] as const;
export function keysAfterAudited(...keys: readonly (readonly unknown[])[]): (readonly unknown[])[] {
  return [...keys, AUDIT_KEY];
}

/** 409 xoá (ADR-054) -> thông điệp dễ hiểu từ body server (deliveryCount / subscriptionCount). */
export function describeDeleteConflict(e: unknown): string | null {
  // Duck-typing HubApiError (status + body) để file này không phụ thuộc client/env — test được thuần.
  const err = e as { status?: unknown; body?: unknown; message?: unknown } | null;
  if (!err || err.status !== 409) return null;
  const b = (err.body ?? {}) as { deliveryCount?: number; subscriptionCount?: number };
  if (typeof b.subscriptionCount === "number") {
    return `Đích còn ${b.subscriptionCount} subscription trỏ vào (${b.deliveryCount ?? 0} delivery lịch sử). Tắt các subscription đó; đích chỉ xoá được khi không còn subscription nào.`;
  }
  if (typeof b.deliveryCount === "number") {
    return `Subscription còn ${b.deliveryCount} delivery trong lịch sử (kể cả DEAD) — không xoá để giữ bằng chứng. Hãy bấm "Tắt" để ngừng gửi.`;
  }
  return typeof err.message === "string" ? err.message : "Xung đột (409)";
}

/**
 * DX1 (ADR-136): lỗi hub-api có khuôn `{error, message (tiếng Anh), fix, docsUrl, requestId, detail?}`. Console hiển thị
 * `detail` (câu tiếng Việt do hub viết cho đúng chỗ lỗi); thiếu `detail` thì tra câu Việt theo MÃ `error`; mã lạ thì
 * `message`. Không bao giờ hiển thị `fix` (viết cho dev dùng API) thay cho câu của console.
 */
const VI_BY_CODE: Record<string, string> = {
  not_found: "Không tìm thấy (hoặc không thuộc project này).",
  internal_error: "Lỗi máy chủ hub — thử lại sau.",
  service_unavailable: "Hub tạm thời không phục vụ được — thử lại sau.",
  // Admin gặp 422 vì HUB_PUBLIC_URL chưa đặt trên Render: nói ĐÚNG biến nào, đặt ở đâu.
  public_url_required:
    "Hub chưa có địa chỉ công khai nên provider không gọi vào được. Đặt biến HUB_PUBLIC_URL=https://<hub-api>.onrender.com cho service hub-api trên Render (Environment → Add Environment Variable) rồi deploy lại. Local: dùng named cloudflared tunnel và đặt HUB_PUBLIC_URL là URL https của tunnel.",
  invalid_api_key: "API key không hợp lệ hoặc đã bị thu hồi.",
  unauthenticated: "Chưa đăng nhập.",
  session_expired: "Phiên đăng nhập đã hết hạn.",
  csrf_failed: "Thiếu hoặc sai CSRF token — tải lại trang.",
  forbidden: "Không có quyền thực hiện thao tác này.",
  rate_limited: "Thao tác quá nhanh — đợi rồi thử lại.",
  payload_too_large: "Dữ liệu quá lớn.",
  slug_taken: "Slug đã có project.",
};

export function errorMessageOf(body: unknown): string {
  if (body === null || typeof body !== "object") return typeof body === "string" ? body.slice(0, 300) : "";
  const b = body as { detail?: unknown; message?: unknown; error?: unknown; requestId?: unknown };
  let text = "";
  if (b.error === "public_url_required") text = VI_BY_CODE.public_url_required;
  else if (typeof b.detail === "string" && b.detail) text = b.detail;
  else if (typeof b.error === "string" && VI_BY_CODE[b.error]) text = VI_BY_CODE[b.error];
  else if (Array.isArray(b.message)) text = b.message.join(", ");
  else if (typeof b.message === "string") text = b.message;
  // 5xx: kèm mã yêu cầu để báo admin tra log.
  if (text && (b.error === "internal_error" || b.error === "service_unavailable") && typeof b.requestId === "string") {
    text += ` (mã yêu cầu ${b.requestId})`;
  }
  return text;
}

/**
 * P2 (ADR-140): cột "Xác minh" của trang Đích. Endpoint webhook phải trả lời challenge (ADR-040) trước khi hub giao;
 * FAILED (vd `ssrf_blocked`) trước đây không thấy được trên console. Lý do viết tiếng Việt theo MÃ của hub.
 */
export type VerificationTone = "ok" | "wait" | "bad";

const VI_VERIFICATION: Record<string, string> = {
  ssrf_blocked: "URL trỏ vào địa chỉ nội bộ/riêng — hub chặn (SSRF). Đăng ký URL công khai (https) của service.",
  timeout: "Endpoint không trả lời challenge trong 10 giây.",
  challenge_mismatch: 'Endpoint trả lời sai challenge — phải trả đúng {"challenge": "<giá trị nhận được>"}.',
  invalid_json: "Endpoint trả về nội dung không phải JSON.",
  unreachable: "Hub không kết nối được (DNS, từ chối kết nối hoặc lỗi TLS).",
  invalid_url: "Endpoint không có URL http(s) hợp lệ.",
  no_signing_secret: "Endpoint chưa có signing secret.",
};

export function describeVerification(
  verification: string | undefined | null,
  code: string | undefined | null,
): { label: string; tone: VerificationTone; reason: string | null } {
  if (verification === "PENDING")
    return { label: "PENDING", tone: "wait", reason: "Đang chờ endpoint trả lời challenge." };
  if (verification !== "FAILED") return { label: "VERIFIED", tone: "ok", reason: null };
  if (!code) return { label: "FAILED", tone: "bad", reason: "Xác minh thất bại." };
  const http = /^http_(\d{3})$/.exec(code);
  const reason = http
    ? `Endpoint trả HTTP ${http[1]} cho challenge (phải trả 200).`
    : (VI_VERIFICATION[code] ?? `Lỗi xác minh: ${code}`);
  return { label: "FAILED", tone: "bad", reason };
}

/**
 * Nút 🔗 trên một dòng Nguồn (lỗi production 2026-10-12): nguồn CHƯA từng kết nối (vd `src_payos_main` của seed) mà provider
 * có connector -> mở hộp "Kết nối provider" điền sẵn nguồn này; đã có kết nối -> hộp tình trạng (chỉ xem/thao tác);
 * provider không có connector -> giải thích là nguồn dán URL tay.
 */
export function connectionDialogMode(
  connection: unknown | null | undefined,
  provider: string,
  connectorProviders: string[] | undefined,
): "loading" | "status" | "connect" | "manual" {
  if (connection === undefined || connectorProviders === undefined) return "loading";
  if (connection) return "status";
  return connectorProviders.includes(provider) ? "connect" : "manual";
}
