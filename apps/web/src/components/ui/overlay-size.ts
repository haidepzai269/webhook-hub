/**
 * Bộ cỡ chung của overlay (UI-MS) — MỘT chỗ khai báo, Dialog / AlertDialog / Sheet đọc từ đây.
 * Chọn theo thực tế đang dùng trong console:
 * - `sm` 24rem: xác nhận ngắn (AlertDialog), hộp một câu hỏi.
 * - `md` 32rem: form tạo mới / kết nối (đa số modal).
 * - `lg` 42rem: chi tiết nhiều cột / form nhiều ô (endpoint, nguồn generic), sheet chi tiết sự kiện / lưu lượng.
 *
 * Chiều cao: không bao giờ quá khung nhìn — `min(<cỡ>, 90dvh)`; nội dung dài cuộn trong thân (DialogBody/SheetBody).
 * Chuỗi class phải viết NGUYÊN VĂN (Tailwind quét mã nguồn, không ghép chuỗi động).
 */
export type OverlaySize = "sm" | "md" | "lg";

export const DIALOG_SIZE: Record<OverlaySize, string> = {
  sm: "sm:max-w-sm max-h-[min(32rem,90dvh)]",
  md: "sm:max-w-lg max-h-[min(42rem,90dvh)]",
  lg: "sm:max-w-2xl max-h-[min(48rem,90dvh)]",
};

/** Sheet trái/phải: rộng cố định theo cỡ, mobile chiếm hết bề ngang; cao = khung nhìn (header/footer đứng yên). */
export const SHEET_SIZE: Record<OverlaySize, string> = {
  sm: "sm:max-w-sm",
  md: "sm:max-w-lg",
  lg: "sm:max-w-2xl",
};
