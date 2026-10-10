"use client";

import type { HubColumn } from "@/components/admin/data-table";
import { DeliverySummary } from "@/components/admin/status-badge";
import { Badge } from "@/components/ui/badge";
import { formatDateTime, formatRelative } from "@/lib/hub/format";
import type { HubEvent } from "@/lib/hub/types";

export const eventColumns: HubColumn<HubEvent>[] = [
  {
    id: "receivedAt",
    header: "Nhận lúc",
    accessorFn: (e) => e.receivedAt,
    cell: ({ row }) => (
      <span className="whitespace-nowrap text-xs" title={formatDateTime(row.original.receivedAt)}>
        {formatRelative(row.original.receivedAt)}
      </span>
    ),
    enableHiding: false,
  },
  {
    id: "type",
    header: "Loại",
    accessorFn: (e) => e.type,
    cell: ({ row }) => <span className="font-mono text-xs">{row.original.type}</span>,
  },
  {
    id: "source",
    header: "Nguồn",
    accessorFn: (e) => e.source,
    cell: ({ row }) => <Badge variant="secondary">{row.original.source}</Badge>,
  },
  {
    id: "origin",
    header: "Origin",
    accessorFn: (e) => e.origin,
    cell: ({ row }) => <span className="text-muted-foreground text-xs">{row.original.origin}</span>,
  },
  {
    id: "subject",
    header: "Subject",
    accessorFn: (e) => e.subject ?? "",
    cell: ({ row }) => (
      <span className="block max-w-48 truncate text-xs" title={row.original.subject ?? ""}>
        {row.original.subject ?? "—"}
      </span>
    ),
  },
  {
    id: "deliveries",
    header: "Deliveries",
    accessorFn: (e) => (e.deliveries ?? []).map((d) => d.status).join(" "),
    cell: ({ row }) => <DeliverySummary statuses={(row.original.deliveries ?? []).map((d) => d.status)} />,
  },
  {
    id: "id",
    header: "ID",
    accessorFn: (e) => e.id,
    cell: ({ row }) => <span className="font-mono text-muted-foreground text-xs">{row.original.id}</span>,
  },
];
