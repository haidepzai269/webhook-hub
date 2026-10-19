/**
 * Gộp toast `trace.ingested` (review SPEC-2 #8, ADR-054) — logic THUẦN, không React, để test được.
 *
 * - Mốc "đã toast tới đâu" (`watermark`) nằm trong store realtime, KHÔNG trong `useRef` của component:
 *   mount lại trang Sự kiện không toast lại cả loạt trace cũ.
 * - Bị dội (vd 50 request chữ ký sai/giây) -> tối đa MỘT toast mỗi `windowMs`, kèm "+N" số còn lại;
 *   phần dồn lại được xả khi cửa sổ hết (component đặt hẹn giờ theo `flushInMs`).
 */
import { createT, type MessageKey, type TranslateFn } from "../i18n/dictionary";

/** Mặc định cho caller chưa truyền `t` (vd ngoài trang cấu hình) — tiếng Việt như trước. */
const VI_T: TranslateFn = createT("vi");

/**
 * Socket -> prefix query cần gọi lại (socket.ts gom trong 400ms rồi invalidate). Nguồn sự thật là API, không tự vá state.
 * "insights" (CB6 — I-dead/I-dest/I-dup/I-silent) đi cùng mọi tin làm đổi số của nó: trước đây chỉ poll 60s nên thẻ
 * "Hàng đợi lỗi" ở Tổng quan báo "không có lượt nào" trong khi KPI ngay trên đã là 4 (xem trên trình duyệt thật).
 */
export const SOCKET_INVALIDATES = {
  // event.received không kéo "insights": dưới tải mỗi sự kiện đều kèm delivery.attempt (đã gọi lại nhận định).
  "event.received": ["overview", "events", "timeseries", "flow"],
  "delivery.attempt": ["overview", "deliveries", "dlq", "timeseries", "event", "events", "flow", "insights"],
  "circuit.changed": ["destinations", "flow", "insights"],
  "alert.changed": ["alerts", "insights"],
  /** trace.ingested chỉ gọi lại bản đồ khi bị từ chối (cổng xác thực đỏ). */
  "trace.rejected": ["flow"],
} as const satisfies Record<string, readonly string[]>;

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
export function describeDeleteConflict(e: unknown, t: TranslateFn = VI_T): string | null {
  // Duck-typing HubApiError (status + body) để file này không phụ thuộc client/env — test được thuần.
  const err = e as { status?: unknown; body?: unknown; message?: unknown } | null;
  if (!err || err.status !== 409) return null;
  const b = (err.body ?? {}) as { deliveryCount?: number; subscriptionCount?: number };
  if (typeof b.subscriptionCount === "number") {
    return t("errors.delete-conflict.destination", {
      subscriptions: b.subscriptionCount,
      deliveries: b.deliveryCount ?? 0,
    });
  }
  if (typeof b.deliveryCount === "number") {
    return t("errors.delete-conflict.subscription", { deliveries: b.deliveryCount });
  }
  return typeof err.message === "string" ? err.message : t("errors.delete-conflict.generic");
}

/**
 * DX1 (ADR-136): lỗi hub-api có khuôn `{error, message (tiếng Anh), fix, docsUrl, requestId, detail?}`. Console hiển thị
 * `detail` (câu tiếng Việt do hub viết cho đúng chỗ lỗi); thiếu `detail` thì tra câu console (vi/en) theo MÃ `error`; mã lạ thì
 * `message`. Không bao giờ hiển thị `fix` (viết cho dev dùng API) thay cho câu của console.
 */
/** Mã lỗi hub-api có câu console riêng trong `errors.api.<mã, '_' → '-'>`; mã khác → `detail`/`message` của hub. */
const API_ERROR_CODES = [
  "not_found",
  "internal_error",
  "service_unavailable",
  "public_url_required",
  "invalid_api_key",
  "unauthenticated",
  "session_expired",
  "csrf_failed",
  "forbidden",
  "rate_limited",
  "payload_too_large",
  "slug_taken",
] as const;

const apiErrorKey = (code: string): MessageKey | null =>
  (API_ERROR_CODES as readonly string[]).includes(code) ? (`errors.api.${code.replace(/_/g, "-")}` as MessageKey) : null;

/** `t` = ngôn ngữ giao diện lúc lỗi xảy ra (hubFetch dựng từ <html lang>). `detail`/`message` của hub giữ nguyên văn. */
export function errorMessageOf(body: unknown, t: TranslateFn): string {
  if (body === null || typeof body !== "object") return typeof body === "string" ? body.slice(0, 300) : "";
  const b = body as { detail?: unknown; message?: unknown; error?: unknown; requestId?: unknown };
  const key = typeof b.error === "string" ? apiErrorKey(b.error) : null;
  let text = "";
  // Admin gặp 422 vì URL ingest chưa đặt trên Render: nói ĐÚNG biến nào (HUB_INGEST_PUBLIC_URL, thiếu thì HUB_PUBLIC_URL —
  // ADR-211), đặt ở đâu (thắng detail của hub).
  if (b.error === "public_url_required") text = t("errors.api.public-url-required");
  else if (typeof b.detail === "string" && b.detail) text = b.detail;
  else if (key) text = t(key);
  else if (Array.isArray(b.message)) text = b.message.join(", ");
  else if (typeof b.message === "string") text = b.message;
  // 5xx: kèm mã yêu cầu để báo admin tra log.
  if (text && (b.error === "internal_error" || b.error === "service_unavailable") && typeof b.requestId === "string") {
    text = t("errors.api.with-request-id", { text, requestId: b.requestId });
  }
  return text;
}

/**
 * P2 (ADR-140): cột "Xác minh" của trang Đích. Endpoint webhook phải trả lời challenge (ADR-040) trước khi hub giao;
 * FAILED (vd `ssrf_blocked`) trước đây không thấy được trên console. Lý do viết tiếng Việt theo MÃ của hub.
 */
export type VerificationTone = "ok" | "wait" | "bad";

/** Mã `verificationError` của hub có câu riêng trong `errors.verification.<mã>`; mã khác -> câu chung kèm mã gốc. */
const VERIFICATION_CODES = [
  "ssrf_blocked",
  "timeout",
  "challenge_mismatch",
  "invalid_json",
  "unreachable",
  "invalid_url",
  "no_signing_secret",
] as const;

/**
 * `label` = mã gốc của hub (PENDING / FAILED / VERIFIED — để ở `title`, đối chiếu log); `labelKey` = nhãn dịch hiển thị.
 */
export function describeVerification(
  verification: string | undefined | null,
  code: string | undefined | null,
  t: TranslateFn = VI_T,
): { label: string; labelKey: MessageKey; tone: VerificationTone; reason: string | null } {
  if (verification === "PENDING")
    return {
      label: "PENDING",
      labelKey: "errors.verification.label.pending",
      tone: "wait",
      reason: t("errors.verification.pending"),
    };
  if (verification !== "FAILED")
    return { label: "VERIFIED", labelKey: "errors.verification.label.verified", tone: "ok", reason: null };
  const failed = { label: "FAILED", labelKey: "errors.verification.label.failed" as MessageKey, tone: "bad" as const };
  if (!code) return { ...failed, reason: t("errors.verification.failed") };
  const http = /^http_(\d{3})$/.exec(code);
  if (http) return { ...failed, reason: t("errors.verification.http", { code: http[1] }) };
  if (!(VERIFICATION_CODES as readonly string[]).includes(code))
    return { ...failed, reason: t("errors.verification.unknown", { code }) };
  // Khoá i18n chỉ dùng '-' (dictionary.spec) -> mã hub `ssrf_blocked` tra `errors.verification.ssrf-blocked`.
  const key = `errors.verification.${code.replace(/_/g, "-")}` as MessageKey;
  const reason = t(key);
  return { ...failed, reason };
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

/**
 * ADR-260: hộp "Lưu trữ nguồn" cần biết nguồn có kết nối hub quản lý không để chọn lời nhắc đúng. Chỉ `manual` khi
 * ĐÃ biết chắc (404 -> `conn === null`); đang tải / lỗi (403, 5xx, mạng) KHÔNG được coi là "tạo tay" -> khoá xác nhận.
 * `DISCONNECTED` (đã ngắt hoặc đã lưu trữ credentials) coi như không còn gì để ngắt -> `manual`.
 */
export function archiveWarningMode(
  conn: { status: string } | null | undefined,
  state: { isPending: boolean; isError: boolean },
): "managed" | "manual" | "pending" | "error" {
  if (state.isError) return "error";
  if (state.isPending || conn === undefined) return "pending";
  if (conn && conn.status !== "DISCONNECTED") return "managed";
  return "manual";
}

/**
 * Chữ lỗi để hiện cho người dùng từ MỘT lỗi bất kỳ (toast, ô báo lỗi): lỗi từ hub (`HubApiError`: có `status` + `body`) →
 * `errorMessageOf` (dịch theo mã `error`); còn lại → `message`. Nhận diện bằng hình dạng (không import client.ts) để file
 * này vẫn là TS thuần cho jest. Thay `toast.error(e.message)` — vốn lộ chuỗi tiếng Anh thô của server.
 */
export function errorTextOf(e: unknown, t: TranslateFn): string {
  if (e !== null && typeof e === "object" && "status" in e && "body" in e) {
    const text = errorMessageOf((e as { body: unknown }).body, t);
    if (text) return text;
  }
  return e instanceof Error ? e.message : String(e);
}
