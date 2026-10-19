/**
 * Chặn trang cấu hình (tầng C) khi viewport quá hẹp (ADR-261). Thuần: quyết định theo bề rộng đo được, KHÔNG đọc user-agent.
 * - `measuring`: chưa đo (SSR / render đầu) → nơi dùng vẽ khung chờ, không vẽ trang rồi mới đổi.
 * - `blocked`: hẹp hơn `minWidth` và người dùng chưa chọn "Vẫn tiếp tục".
 */
export type GuardState = "measuring" | "ok" | "blocked";

export function decideGuard(width: number | null, minWidth: number, override: boolean): GuardState {
  if (width === null) return "measuring";
  if (override || width >= minWidth) return "ok";
  return "blocked";
}

/** Khoá sessionStorage nhớ "Vẫn tiếp tục" — theo đường dẫn của trang. */
export const guardStorageKey = (pathname: string) => `screen-guard:${pathname}`;
