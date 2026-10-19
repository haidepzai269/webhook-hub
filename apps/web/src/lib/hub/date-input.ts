/**
 * Ô ngày/giờ gõ tay (ADR-266) — TS thuần, không React, không alias `@/` để jest gốc test thẳng.
 * Giá trị chuẩn là chuỗi `yyyy-MM-dd` (ngày) + `HH:mm` (giờ) theo GIỜ MÁY người xem — cùng dạng `datetime-local`
 * mà `list-url.ts` (`localInputToIso`, `localInputToIsoEnd`) đã nhận; ô chỉ đổi cách NHẬP/HIỂN THỊ, không đổi hợp đồng URL.
 */

import type { Locale } from "../i18n/locales";

/** Khuôn hiển thị theo ngôn ngữ: vi `dd/MM/yyyy`, en `MM/dd/yyyy` (kiểu en-US). */
export const DATE_PATTERN: Record<Locale, string> = { vi: "dd/MM/yyyy", en: "MM/dd/yyyy" };

/** Giờ mặc định khi chọn ngày mà chưa có giờ: "Từ" đầu ngày, "Đến" cuối ngày (…23:59 -> …:59.999 ở `localInputToIsoEnd`). */
export const DEFAULT_TIME = { start: "00:00", end: "23:59" } as const;

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** `yyyy-MM-dd` có phải ngày có thật không (30/02, 31/04 -> sai). */
export function isValidYmd(ymd: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(y, mo - 1, d);
  return date.getFullYear() === y && date.getMonth() === mo - 1 && date.getDate() === d;
}

/** `yyyy-MM-dd` -> chữ theo khuôn của ngôn ngữ; rỗng/sai -> "". */
export function formatYmd(ymd: string, locale: Locale): string {
  if (!isValidYmd(ymd)) return "";
  const [y, m, d] = ymd.split("-");
  return locale === "vi" ? `${d}/${m}/${y}` : `${m}/${d}/${y}`;
}

/**
 * Chữ người xem gõ -> `yyyy-MM-dd`. "" -> "" (xoá); sai khuôn / ngày không có thật -> null.
 * Ngày/tháng gõ 1–2 chữ số, năm đủ 4 chữ số; chấp nhận `/`, `-`, `.` làm dấu ngăn.
 */
export function parseDateText(text: string, locale: Locale): string | null {
  const s = text.trim();
  if (!s) return "";
  const m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s);
  if (!m) return null;
  const [day, month] = locale === "vi" ? [m[1], m[2]] : [m[2], m[1]];
  const ymd = `${m[3]}-${pad(Number(month))}-${pad(Number(day))}`;
  return isValidYmd(ymd) ? ymd : null;
}

/** Chữ giờ gõ -> `HH:mm` (24 giờ). "" -> ""; sai -> null. Nhận `H:mm`, `HH:mm`, `HHmm`. */
export function parseTimeText(text: string): string | null {
  const s = text.trim();
  if (!s) return "";
  const m = /^(\d{1,2}):(\d{2})$/.exec(s) ?? /^(\d{2})(\d{2})$/.exec(s);
  if (!m) return null;
  const [h, min] = [Number(m[1]), Number(m[2])];
  return h < 24 && min < 60 ? `${pad(h)}:${pad(min)}` : null;
}

/** `Date` (giờ máy) -> `yyyy-MM-dd`. */
export function dateToYmd(d: Date): string {
  return `${pad(d.getFullYear(), 4)}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** `yyyy-MM-dd` -> `Date` 00:00 giờ máy; sai -> undefined. */
export function ymdToDate(ymd: string): Date | undefined {
  if (!isValidYmd(ymd)) return undefined;
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(y, m - 1, d);
}

/**
 * Ghép ngày + giờ thành giá trị kiểu `datetime-local` (`yyyy-MM-ddTHH:mm`). Chưa có ngày -> "" (không lọc);
 * có ngày mà giờ trống -> giờ mặc định của đầu "Từ"/"Đến".
 */
export function composeLocal(ymd: string, hm: string, edge: keyof typeof DEFAULT_TIME): string {
  if (!isValidYmd(ymd)) return "";
  return `${ymd}T${hm || DEFAULT_TIME[edge]}`;
}

/** Ngược lại với `composeLocal`: `yyyy-MM-ddTHH:mm` (vd từ `isoToLocalInput`) -> { ymd, hm }; rỗng -> cả hai "". */
export function splitLocal(local: string): { ymd: string; hm: string } {
  const [ymd = "", hm = ""] = local.split("T");
  return isValidYmd(ymd) ? { ymd, hm } : { ymd: "", hm: "" };
}
