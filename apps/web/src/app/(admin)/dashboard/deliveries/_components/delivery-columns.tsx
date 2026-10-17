"use client";

import { useEffect, useMemo, useState } from "react";

import type { HubColumn } from "@/components/admin/data-table";
import { DeliveryStatusBadge, toneTextClass } from "@/components/admin/status-badge";
import { UnverifiedBadge } from "@/components/flow/unverified-badge";
import { formatDateTime, formatRelative, httpTone, shortId } from "@/lib/hub/format";
import { countdownTicker } from "@/lib/hub/ui-logic";
import type { Delivery, DeliveryAttempt } from "@/lib/hub/types";
import type { Locale, TranslateFn } from "@/lib/i18n/dictionary";
import { useLocale, useT } from "@/lib/i18n/use-t";
import { CellTooltip } from "@/components/ui/cell-tooltip";

/** Lần thử cuối (API không đảm bảo thứ tự attempts trong danh sách) — để hiện HTTP/ms. */
function lastAttempt(d: Delivery): DeliveryAttempt | undefined {
  return d.attempts?.reduce<DeliveryAttempt | undefined>(
    (a, b) => (!a || b.attemptNo > a.attemptNo ? b : a),
    undefined,
  );
}

/** Đếm ngược tới `next_attempt_at` (S2-2) — tick mỗi giây, tự dừng khi đã tới giờ. */
export function RetryCountdown({ iso }: { iso: string }) {
  const t = useT();
  const locale = useLocale();
  const target = new Date(iso).getTime();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (target <= Date.now()) return;
    // Tự clearInterval khi về 0 (review SPEC-2 #8) — không để timer chạy mãi trên hàng đã tới giờ.
    const t = setInterval(
      countdownTicker(target, setNow, () => clearInterval(t)),
      1000,
    );
    return () => clearInterval(t);
  }, [target]);
  const left = Math.max(0, Math.round((target - now) / 1000));
  if (left === 0) return <span className="text-muted-foreground text-xs">{t("page.deliveries.countdown.due")}</span>;
  const m = Math.floor(left / 60);
  const sec = left % 60;
  return (
    <span
      className="whitespace-nowrap font-mono text-amber-600 text-xs tabular-nums dark:text-amber-400"
      title={formatDateTime(iso, locale)}
    >
      {m > 0 ? `${m}m ${String(sec).padStart(2, "0")}s` : `${sec}s`}
    </span>
  );
}

/** Cột bảng lượt giao theo ngôn ngữ — header là chuỗi để menu ẩn/hiện cột của DataTable đọc được. */
export const buildDeliveryColumns = (t: TranslateFn, locale: Locale): HubColumn<Delivery>[] => [
  {
    id: "status",
    header: t("page.deliveries.col.status"),
    accessorFn: (d) => d.status,
    cell: ({ row }) => <DeliveryStatusBadge status={row.original.status} />,
    enableHiding: false,
  },
  {
    id: "destination",
    header: t("page.deliveries.col.destination"),
    accessorFn: (d) => d.subscription?.destination?.name ?? d.subscription?.name ?? "",
    cell: ({ row }) => {
      const dest = row.original.subscription?.destination;
      return (
        <div className="min-w-0">
          <div className="truncate font-medium text-sm">{dest?.name ?? row.original.subscription?.name ?? "—"}</div>
          {dest?.type && <div className="text-muted-foreground text-xs">{dest.type}</div>}
        </div>
      );
    },
  },
  {
    id: "eventType",
    header: t("page.deliveries.col.event"),
    accessorFn: (d) => d.event?.type ?? "",
    cell: ({ row }) => (
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate font-mono text-xs">{row.original.event?.type ?? "—"}</span>
          {/* PK5 khoá 2: lượt giao của sự kiện chưa xác thực mang nhãn (cả ở DLQ — dùng chung cột). */}
          <UnverifiedBadge of={row.original.event} />
        </div>
        <div className="font-mono text-[11px] text-muted-foreground" title={row.original.eventId}>
          {shortId(row.original.eventId, 12)}
        </div>
      </div>
    ),
  },
  {
    id: "generation",
    header: t("page.deliveries.col.generation"),
    accessorFn: (d) => String(d.attemptGeneration),
    cell: ({ row }) => (
      <span className="font-mono text-xs" title={t("page.deliveries.col.generation-hint")}>
        {row.original.attemptGeneration}
      </span>
    ),
  },
  {
    id: "attempts",
    header: t("page.deliveries.col.attempts"),
    accessorFn: (d) => String(d.attemptCount),
    cell: ({ row }) => <span className="font-mono text-xs">{row.original.attemptCount}</span>,
  },
  {
    id: "http",
    header: t("page.deliveries.col.http"),
    accessorFn: (d) => String(lastAttempt(d)?.responseStatus ?? ""),
    cell: ({ row }) => {
      const a = lastAttempt(row.original);
      return <span className={`font-mono text-xs ${toneTextClass(httpTone(a?.responseStatus))}`}>{a?.responseStatus ?? "—"}</span>;
    },
  },
  {
    id: "ms",
    header: t("page.deliveries.col.ms"),
    accessorFn: (d) => String(lastAttempt(d)?.durationMs ?? ""),
    cell: ({ row }) => {
      const a = lastAttempt(row.original);
      return <span className="font-mono text-xs tabular-nums">{a?.durationMs ?? "—"}</span>;
    },
  },
  {
    id: "nextAttemptAt",
    header: t("page.deliveries.col.next-attempt"),
    accessorFn: (d) => d.nextAttemptAt ?? "",
    cell: ({ row }) => {
      const d = row.original;
      const pending = (d.status === "RETRYING" || d.status === "PENDING") && d.nextAttemptAt;
      return pending && d.nextAttemptAt ? (
        <RetryCountdown iso={d.nextAttemptAt} />
      ) : (
        <span className="text-muted-foreground text-xs">—</span>
      );
    },
  },
  {
    id: "lastError",
    header: t("page.deliveries.col.last-error"),
    accessorFn: (d) => d.lastError ?? "",
    cell: ({ row }) =>
      row.original.lastError ? (
        <CellTooltip text={row.original.lastError}>
          <span data-cell-text className="block max-w-64 truncate text-rose-600 text-xs">
            {row.original.lastError}
          </span>
        </CellTooltip>
      ) : (
        <span className="text-muted-foreground text-xs">—</span>
      ),
  },
  {
    id: "updatedAt",
    header: t("page.deliveries.col.updated"),
    accessorFn: (d) => d.updatedAt,
    cell: ({ row }) => (
      <span className="whitespace-nowrap text-xs" title={formatDateTime(row.original.updatedAt, locale)}>
        {formatRelative(row.original.updatedAt, undefined, locale)}
      </span>
    ),
  },
];

export function useDeliveryColumns(): HubColumn<Delivery>[] {
  const t = useT();
  const locale = useLocale();
  return useMemo(() => buildDeliveryColumns(t, locale), [t, locale]);
}
