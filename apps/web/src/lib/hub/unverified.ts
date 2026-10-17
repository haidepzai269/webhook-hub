// PK5 khoá 2 (SPEC-provider-khac §7.1, ADR-206; REVIEW-PK5 TB-1, T-9): sự kiện chưa xác thực KHÔNG BAO GIỜ trông như đã
// xác thực ở console. Logic thuần (không React) — test bằng jest ở gốc repo.

/** Một thứ mang cờ `verified` của server (event, raw, dòng hành trình). Vắng = đã xác thực (dữ liệu trước PK5). */
export interface VerifiedFlag {
  verified?: boolean | null;
}

/** `true` khi server nói rõ `verified: false` — hub không kiểm chữ ký nguồn của sự kiện này. */
export const isUnverified = (x: VerifiedFlag | null | undefined): boolean => x?.verified === false;

/** Trang hành trình: chưa xác thực khi event HOẶC raw mang `verified: false` (raw có cả khi chưa normalize). */
export const journeyUnverified = (d: { event?: VerifiedFlag | null; raw?: VerifiedFlag | null } | null | undefined): boolean =>
  isUnverified(d?.event) || isUnverified(d?.raw);

/** Nguồn `generic` dùng scheme `unverified` ("đích tự kiểm"). */
export const isUnverifiedSource = (s: { provider: string; verificationConfig?: unknown }): boolean =>
  s.provider === "generic" &&
  typeof s.verificationConfig === "object" &&
  s.verificationConfig !== null &&
  (s.verificationConfig as { scheme?: unknown }).scheme === "unverified";

/**
 * Review PK5 T-9: request vào nguồn `unverified` khi project TẮT cờ bị từ chối mà không ghi gì (không lưu lượng, không Lắng
 * nghe) — dev quên bật cờ sẽ không thấy gì. Cảnh báo cạnh nguồn khi cờ được biết là TẮT (đang tải / không đọc được -> không
 * cảnh báo bừa).
 */
export const unverifiedSourceBlocked = (
  s: { provider: string; verificationConfig?: unknown },
  allowUnverifiedSources: boolean | undefined,
): boolean => isUnverifiedSource(s) && allowUnverifiedSources === false;

/**
 * REVIEW-PK5-R2 TB-1b: nhãn chữ ký ở xem nhanh (event-sheet) + bước ① (trace-timeline). Nguồn `unverified` ghi
 * `raw_events.signature_valid = true` (cố ý, để không bật cảnh báo signature_failing) — nên KHÔNG được suy "hợp lệ" từ
 * riêng `signatureValid`: event HOẶC raw mang `verified: false` -> "Chưa xác thực" (hổ phách, tông cảnh báo).
 */
export type SignatureView = "unverified" | "valid" | "invalid";

export const signatureView = (ev: VerifiedFlag & { rawEvent?: (VerifiedFlag & { signatureValid: boolean }) | null }): SignatureView =>
  isUnverified(ev) || isUnverified(ev.rawEvent) ? "unverified" : ev.rawEvent?.signatureValid ? "valid" : "invalid";

/** Khoá i18n + tông chấm + kiểu badge cho từng trạng thái. Chỉ `valid` được xanh (`ok`). */
export const SIGNATURE_VIEW = {
  unverified: {
    key: "page.events.unverified",
    tone: "warn",
    variant: "outline",
    className: "tone-badge [--tone:var(--flow-warning)]", // = toneBadgeClass("warn") (lib thuần TS, không import React)
  },
  valid: { key: "page.events.sheet.signature-valid", tone: "ok", variant: "secondary", className: "" },
  invalid: { key: "page.events.sheet.signature-invalid", tone: "bad", variant: "destructive", className: "" },
} as const satisfies Record<SignatureView, { key: string; tone: "ok" | "bad" | "warn"; variant: "outline" | "secondary" | "destructive"; className: string }>;
