"use client";

import type { ReactNode } from "react";

import { cn } from "cn";

import type { MessageKey } from "@/lib/i18n/dictionary";
import { useT } from "@/lib/i18n/use-t";
import { barPct, formatBytes, levelSeg, levelTone, parseLevel } from "@/lib/storage/storage-logic";

/** Màu theo nấc (token có bản dark ở styles/alerts.css): < 70 xanh, 70/85 hổ phách, 95+ đỏ. */
export const USAGE_TONE_COLOR = { ok: "var(--ok)", warning: "var(--warning)", danger: "var(--danger)" } as const;

export interface Usage {
  usedPct: number;
  usedBytes: number;
  quotaBytes: number;
  level: string;
}

/**
 * Mức dùng dung lượng MỘT kiểu (ADR-247), màu theo nấc `levelTone`:
 *  - `inline`: một dòng chữ "% · used / quota · nấc" (cột bảng).
 *  - `bar`: nhãn + % + byte trên một thanh mảnh (thẻ dự án).
 *  - `card`: thanh dày có `role="progressbar"`, hàng % + `aside` (vd. dự báo) bên dưới (trang Dung lượng).
 * Số liệu là ước tính (xem `page.storage.estimated`).
 */
export function UsageMeter({
  usage,
  variant = "inline",
  label,
  aside,
  className,
}: {
  usage: Usage;
  variant?: "inline" | "bar" | "card";
  /** Nhãn trên thanh (variant `bar`) và `aria-label` (variant `card`). */
  label?: string;
  /** Nội dung bên phải hàng % (variant `card`). */
  aside?: ReactNode;
  className?: string;
}) {
  const t = useT();
  const level = parseLevel(usage.level);
  const color = USAGE_TONE_COLOR[levelTone(level)];
  const levelText = level !== "OK" ? t(`page.storage.level.${levelSeg(level)}` as MessageKey) : null;
  const bytes = `${formatBytes(usage.usedBytes)} / ${formatBytes(usage.quotaBytes)}`;

  if (variant === "inline") {
    return (
      <span className={cn("whitespace-nowrap text-xs tabular-nums", className)} title={t("page.storage.estimated")}>
        <span className="font-medium" style={{ color: level === "OK" ? "var(--muted-foreground)" : color }}>
          {usage.usedPct}%
        </span>{" "}
        <span className="text-muted-foreground">
          {bytes}
          {levelText ? ` · ${levelText}` : ""}
        </span>
      </span>
    );
  }

  if (variant === "bar") {
    return (
      <div className={cn("space-y-1.5", className)}>
        <div className="flex items-center justify-between gap-2 text-xs">
          <span className="text-muted-foreground">{label}</span>
          <span className="tabular-nums">
            <span className="font-medium" style={{ color: level === "OK" ? undefined : color }}>
              {usage.usedPct}%
            </span>
            <span className="text-muted-foreground"> · {bytes}</span>
          </span>
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-muted" title={levelText ?? undefined}>
          <div className="h-full rounded-full transition-all" style={{ width: `${barPct(usage.usedPct)}%`, background: color }} />
        </div>
      </div>
    );
  }

  return (
    <div className={cn("space-y-2", className)}>
      <div
        className="h-3 w-full overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(barPct(usage.usedPct))}
        aria-label={label}
      >
        <div className="h-full rounded-full transition-[width]" style={{ width: `${barPct(usage.usedPct)}%`, backgroundColor: color }} />
      </div>
      <div className="flex flex-wrap justify-between gap-2 text-muted-foreground text-sm">
        <span className="tabular-nums">{usage.usedPct}%</span>
        {aside}
      </div>
    </div>
  );
}
