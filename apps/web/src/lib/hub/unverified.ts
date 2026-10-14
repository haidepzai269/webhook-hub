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
