"use client";

import { useState } from "react";

import { ChevronLeft, ChevronRight } from "lucide-react";

import { DataTable, type HubColumn } from "@/components/admin/data-table";
import { PageHeader } from "@/components/admin/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatDateTime, formatRelative, shortId } from "@/lib/hub/format";
import { useAuditLogs } from "@/lib/hub/queries";
import type { AuditLog } from "@/lib/hub/types";

const PAGE_SIZE = 50;

/** Hành động "nguy hiểm" (gửi lại / xoá) tô màu để nhìn ra ngay. */
function actionTone(action: string) {
  if (action.endsWith(".delete")) return "border-rose-500/40 text-rose-700 dark:text-rose-300";
  if (action.startsWith("delivery.replay") || action.startsWith("raw_event.")) {
    return "border-amber-500/40 text-amber-700 dark:text-amber-300";
  }
  if (action.endsWith(".create")) return "border-emerald-500/40 text-emerald-700 dark:text-emerald-300";
  return "";
}

/** Tóm tắt metadata: số lượng (replay hàng loạt) hoặc danh sách trường đã sửa — không bao giờ có secret. */
function metaSummary(meta: unknown): string {
  if (!meta || typeof meta !== "object") return "";
  const m = meta as Record<string, unknown>;
  if (typeof m.count === "number") return `${m.count} mục`;
  if (Array.isArray(m.fields)) return `sửa: ${m.fields.join(", ")}`;
  if (typeof m.generation === "number") return `→ gen ${m.generation}`;
  if (typeof m.name === "string") return m.name;
  return "";
}

const columns: HubColumn<AuditLog>[] = [
  {
    id: "createdAt",
    header: "Thời gian",
    accessorFn: (a) => a.createdAt,
    cell: ({ row }) => (
      <span className="whitespace-nowrap text-xs" title={formatDateTime(row.original.createdAt)}>
        {formatDateTime(row.original.createdAt)}
        <span className="block text-[11px] text-muted-foreground">{formatRelative(row.original.createdAt)}</span>
      </span>
    ),
    enableHiding: false,
  },
  {
    id: "actor",
    header: "Người làm",
    accessorFn: (a) => a.actor,
    cell: ({ row }) => <span className="font-medium text-sm">{row.original.actor}</span>,
  },
  {
    id: "action",
    header: "Hành động",
    accessorFn: (a) => a.action,
    cell: ({ row }) => (
      <Badge variant="outline" className={`font-mono text-[11px] ${actionTone(row.original.action)}`}>
        {row.original.action}
      </Badge>
    ),
  },
  {
    id: "entity",
    header: "Đối tượng",
    accessorFn: (a) => `${a.entityType} ${a.entityId}`,
    cell: ({ row }) => {
      const a = row.original;
      const summary = metaSummary(a.metadata);
      return (
        <div className="min-w-0">
          <div className="text-xs">
            {a.entityType}{" "}
            <span className="font-mono text-muted-foreground" title={a.entityId}>
              {shortId(a.entityId, 12)}
            </span>
          </div>
          {summary && <div className="truncate text-[11px] text-muted-foreground">{summary}</div>}
        </div>
      );
    },
  },
  {
    id: "reason",
    header: "Lý do",
    accessorFn: (a) => a.reason ?? "",
    cell: ({ row }) =>
      row.original.reason ? (
        <span className="block max-w-80 truncate text-sm" title={row.original.reason}>
          {row.original.reason}
        </span>
      ) : (
        <span className="text-muted-foreground text-xs">—</span>
      ),
  },
];

/**
 * Nhật ký hành động (S2-3/S2-5). Mỗi dòng được ghi CÙNG transaction với hành động — có hành động thì
 * chắc chắn có dòng này. Phân trang lùi theo `before` (id nhỏ nhất của trang trước).
 */
export default function AuditPage() {
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const before = cursors.at(-1);
  const { data, isLoading, isFetching, isPlaceholderData, error } = useAuditLogs(before, PAGE_SIZE);
  const page = cursors.length;

  return (
    <>
      <PageHeader
        title="Nhật ký (Audit)"
        description="Ai đã làm gì, lúc nào, vì sao: replay, replay hàng loạt, chuẩn hoá lại, tạo/sửa/xoá nguồn, đích, subscription."
      />
      <DataTable
        data={data?.items}
        columns={columns}
        getRowId={(a) => a.id}
        isLoading={isLoading}
        isStale={isPlaceholderData}
        error={error}
        pageSize={false}
        searchPlaceholder="Lọc trong trang này…"
        emptyText={page > 1 ? "Hết nhật ký." : "Chưa có hành động nào được ghi."}
        toolbar={
          <div className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">
              Trang {page}
              {isFetching ? " · đang tải…" : ""}
            </span>
            <Button variant="outline" size="sm" disabled={page === 1} onClick={() => setCursors((c) => c.slice(0, -1))}>
              <ChevronLeft />
              Trước
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={!data?.nextBefore || isPlaceholderData}
              onClick={() => data?.nextBefore && setCursors((c) => [...c, data.nextBefore ?? undefined])}
            >
              Trang sau
              <ChevronRight />
            </Button>
          </div>
        }
      />
    </>
  );
}
