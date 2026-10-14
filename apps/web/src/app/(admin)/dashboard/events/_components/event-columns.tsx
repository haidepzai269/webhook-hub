"use client";

import { useMemo } from "react";

import type { HubColumn } from "@/components/admin/data-table";
import { DeliverySummary } from "@/components/admin/status-badge";
import { UnverifiedBadge } from "@/components/flow/unverified-badge";
import { Badge } from "@/components/ui/badge";
import { formatDateTime, formatRelative } from "@/lib/hub/format";
import type { HubEvent } from "@/lib/hub/types";
import type { Locale, TranslateFn } from "@/lib/i18n/dictionary";
import { useLocale, useT } from "@/lib/i18n/use-t";

/** Cột bảng sự kiện theo ngôn ngữ — header là chuỗi để menu ẩn/hiện cột của DataTable đọc được. */
export const buildEventColumns = (t: TranslateFn, locale: Locale): HubColumn<HubEvent>[] => [
  {
    id: "receivedAt",
    header: t("page.events.table.received-at"),
    accessorFn: (e) => e.receivedAt,
    cell: ({ row }) => (
      <span className="whitespace-nowrap text-xs" title={formatDateTime(row.original.receivedAt, locale)}>
        {formatRelative(row.original.receivedAt, undefined, locale)}
      </span>
    ),
    enableHiding: false,
  },
  {
    id: "type",
    header: t("page.events.table.type"),
    accessorFn: (e) => e.type,
    cell: ({ row }) => (
      <span className="flex min-w-0 items-center gap-1.5">
        <span className="truncate font-mono text-xs">{row.original.type}</span>
        {/* PK5 khoá 2: nhãn "Chưa xác thực" ở mọi nơi có event. */}
        <UnverifiedBadge of={row.original} />
      </span>
    ),
  },
  {
    id: "source",
    header: t("page.events.table.source"),
    accessorFn: (e) => e.source,
    cell: ({ row }) => <Badge variant="secondary">{row.original.source}</Badge>,
  },
  {
    id: "origin",
    header: t("page.events.table.origin"),
    accessorFn: (e) => e.origin,
    cell: ({ row }) => <span className="text-muted-foreground text-xs">{row.original.origin}</span>,
  },
  {
    id: "subject",
    header: t("page.events.table.subject"),
    accessorFn: (e) => e.subject ?? "",
    cell: ({ row }) => (
      <span className="block max-w-48 truncate text-xs" title={row.original.subject ?? ""}>
        {row.original.subject ?? "—"}
      </span>
    ),
  },
  {
    id: "deliveries",
    header: t("page.events.table.deliveries"),
    accessorFn: (e) => (e.deliveries ?? []).map((d) => d.status).join(" "),
    cell: ({ row }) => <DeliverySummary statuses={(row.original.deliveries ?? []).map((d) => d.status)} />,
  },
  {
    id: "id",
    header: t("page.events.table.id"),
    accessorFn: (e) => e.id,
    cell: ({ row }) => <span className="font-mono text-muted-foreground text-xs">{row.original.id}</span>,
  },
];

export function useEventColumns(): HubColumn<HubEvent>[] {
  const t = useT();
  const locale = useLocale();
  return useMemo(() => buildEventColumns(t, locale), [t, locale]);
}

