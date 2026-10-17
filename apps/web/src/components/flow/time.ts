"use client";

import { useEffect, useState } from "react";

import { DEFAULT_LOCALE, INTL_LOCALE, type Locale } from "../../lib/i18n/locales";

/** HH:MM:SS.mmm theo giờ máy người xem — "COMMIT lúc 10:02:37.120". */
export function clock(iso: string | number | null | undefined, ms = true): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const p = (n: number, l = 2) => String(n).padStart(l, "0");
  const base = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  return ms ? `${base}.${p(d.getMilliseconds(), 3)}` : base;
}

/** Ngày theo locale giao diện (mặc định vi) + clock(). Component: `fullDate(iso, useLocale())`. */
export function fullDate(iso: string | null | undefined, locale: Locale = DEFAULT_LOCALE): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return `${d.toLocaleDateString(INTL_LOCALE[locale])} ${clock(iso)}`;
}

export function fmtMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m${s ? ` ${s}s` : ""}`;
}

/**
 * Đếm ngược mm:ss tới một mốc do SERVER trả (next_attempt_at) — chỉ là hiển thị, không suy trạng thái.
 * Đã tới hạn → `dueLabel` (bắt buộc — component truyền `t("journey.due")`, hàm thuần không tự chọn ngôn ngữ).
 */
export function countdown(targetIso: string | null | undefined, now: number, dueLabel: string): string | null {
  if (!targetIso) return null;
  const left = Math.round((Date.parse(targetIso) - now) / 1000);
  if (left <= 0) return dueLabel;
  const h = Math.floor(left / 3600);
  const m = Math.floor((left % 3600) / 60);
  const s = left % 60;
  const p = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`;
}

export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}
