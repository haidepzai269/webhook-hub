/**
 * Bố cục Nhật ký sự kiện (V3) — logic thuần: lưới cột CỐ ĐỊNH + chiều cao kéo được nhớ theo người xem.
 * Cột không phụ thuộc nội dung (rem hoặc minmax(rem,rem)) để hàng có "1/1" (chấm giao gộp) không đẩy lệch
 * cột của hàng khác — mỗi hàng là một grid riêng. minmax cho phép co khi ngăn hẹp; dưới `logMinWidth()`
 * thì cuộn ngang trong ngăn thay vì đè chữ. Cột cuối "Ghi chú" (event-notes.ts) ăn phần còn lại, cắt "…".
 * Tiêu đề cột là KHOÁ i18n (`labelKey`) — component dịch bằng `t(c.labelKey)`.
 */
import type { MessageKey } from "../../lib/i18n/dictionary";

export const LOG_COLUMNS = [
  { key: "time", labelKey: "journey.col.time", width: "6.5rem", min: 6.5 },
  { key: "provider", labelKey: "journey.col.provider", width: "minmax(4.5rem,8rem)", min: 4.5 },
  { key: "stages", labelKey: "journey.col.stages", width: "11rem", min: 11 },
  { key: "type", labelKey: "journey.col.type", width: "minmax(7rem,13rem)", min: 7 },
  { key: "result", labelKey: "journey.col.result", width: "minmax(5.5rem,10rem)", min: 5.5 },
  { key: "note", labelKey: "journey.col.note", width: "minmax(10rem,1fr)", min: 10 },
] as const satisfies readonly { key: string; labelKey: MessageKey; width: string; min: number }[];

export function logGridTemplate(): string {
  return LOG_COLUMNS.map((c) => c.width).join(" ");
}

/** Khe giữa cột (gap-3) + đệm ngang hàng (px-3) + viền trái 2px, tính bằng rem. */
const LOG_GAP_REM = 0.75;
const LOG_PAD_REM = 1.5 + 0.125;

/** Bề rộng tối thiểu của lưới: hẹp hơn thì ngăn nhật ký cuộn ngang. */
export function logMinWidth(): string {
  const cols = LOG_COLUMNS.reduce((n, c) => n + c.min, 0);
  return `${cols + LOG_GAP_REM * (LOG_COLUMNS.length - 1) + LOG_PAD_REM}rem`;
}

export const LOG_HEIGHT_KEY = "flow:v3:log-height";
export const LOG_HEIGHT_MIN_FRAC = 0.25;
export const LOG_HEIGHT_MAX_FRAC = 0.85;
export const LOG_HEIGHT_DEFAULT_FRAC = 0.25;

export function clampLogHeight(px: number, viewportH: number): number {
  const min = viewportH * LOG_HEIGHT_MIN_FRAC;
  const max = viewportH * LOG_HEIGHT_MAX_FRAC;
  return Math.min(max, Math.max(min, px));
}

type Store = Pick<Storage, "getItem" | "setItem">;

/** Chiều cao đã lưu (px) hoặc mặc định; storage bị chặn/rác → mặc định (trang vẫn chạy). */
export function readLogHeight(store: Store | null | undefined, viewportH: number): number {
  const fallback = viewportH * LOG_HEIGHT_DEFAULT_FRAC;
  try {
    const raw = store?.getItem(LOG_HEIGHT_KEY);
    if (raw == null) return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? clampLogHeight(n, viewportH) : fallback;
  } catch {
    return fallback;
  }
}

export function writeLogHeight(store: Store | null | undefined, px: number): void {
  try {
    store?.setItem(LOG_HEIGHT_KEY, String(Math.round(px)));
  } catch {
    /* storage bị chặn → chỉ không nhớ */
  }
}

/** Bước bàn phím của tay kéo: 5% viewport mỗi lần ↑/↓. */
export const LOG_HEIGHT_KEY_STEP_FRAC = 0.05;

/**
 * Tay kéo bằng bàn phím (L-B3): ↑ cao thêm, ↓ thấp đi, Home/End = min/max; luôn kẹp 25–85%.
 * Phím khác → null (để trình duyệt xử lý như thường).
 */
export function stepLogHeight(currentPx: number, key: string, viewportH: number): number | null {
  const step = viewportH * LOG_HEIGHT_KEY_STEP_FRAC;
  switch (key) {
    case "ArrowUp":
      return clampLogHeight(currentPx + step, viewportH);
    case "ArrowDown":
      return clampLogHeight(currentPx - step, viewportH);
    case "Home":
      return viewportH * LOG_HEIGHT_MIN_FRAC;
    case "End":
      return viewportH * LOG_HEIGHT_MAX_FRAC;
    default:
      return null;
  }
}

/** aria-valuenow/min/max của separator: phần trăm viewport (số nguyên). */
export function logHeightAria(px: number, viewportH: number): { now: number; min: number; max: number } {
  return {
    now: Math.round((px / viewportH) * 100),
    min: Math.round(LOG_HEIGHT_MIN_FRAC * 100),
    max: Math.round(LOG_HEIGHT_MAX_FRAC * 100),
  };
}
