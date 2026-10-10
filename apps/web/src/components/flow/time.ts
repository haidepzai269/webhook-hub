"use client";

import { useEffect, useState } from "react";

/** HH:MM:SS.mmm theo giờ máy người xem — "COMMIT lúc 10:02:37.120". */
export function clock(iso: string | null | undefined, ms = true): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const p = (n: number, l = 2) => String(n).padStart(l, "0");
  const base = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  return ms ? `${base}.${p(d.getMilliseconds(), 3)}` : base;
}

export function fullDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return `${d.toLocaleDateString("vi-VN")} ${clock(iso)}`;
}

export function fmtMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m${s ? ` ${s}s` : ""}`;
}

/** Đếm ngược mm:ss tới một mốc do SERVER trả (next_attempt_at) — chỉ là hiển thị, không suy trạng thái. */
export function countdown(targetIso: string | null | undefined, now: number): string | null {
  if (!targetIso) return null;
  const left = Math.round((Date.parse(targetIso) - now) / 1000);
  if (left <= 0) return "đến hạn";
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
