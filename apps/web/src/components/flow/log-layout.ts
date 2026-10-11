/**
 * Bố cục Nhật ký sự kiện (V3) — logic thuần: lưới cột CỐ ĐỊNH + chiều cao kéo được nhớ theo người xem.
 * Cột cố định để hàng có "1/1" (chấm giao gộp) không đẩy lệch cột type/kết quả của hàng khác.
 */

export const LOG_COLUMNS = [
  { key: "time", label: "Thời gian", width: "6.5rem" },
  { key: "provider", label: "Provider", width: "8rem" },
  { key: "stages", label: "Chặng", width: "11rem" },
  { key: "type", label: "Type", width: "14rem" },
  { key: "result", label: "Kết quả", width: "minmax(0,1fr)" },
] as const;

export function logGridTemplate(): string {
  return LOG_COLUMNS.map((c) => c.width).join(" ");
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
