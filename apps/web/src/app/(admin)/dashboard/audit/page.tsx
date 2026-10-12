"use client";

import { Suspense, useCallback } from "react";

import { X } from "lucide-react";

import { CursorPager } from "@/components/admin/cursor-pager";
import { DataTable, type HubColumn } from "@/components/admin/data-table";
import { PageHeader } from "@/components/admin/page-header";
import { TimeRange } from "@/components/admin/time-range";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDateTime, formatRelative, shortId } from "@/lib/hub/format";
import { AUDIT_PARAMS, toApiQuery } from "@/lib/hub/list-url";
import { useAuditFacets, useAuditLogs } from "@/lib/hub/queries";
import type { AuditLog } from "@/lib/hub/types";
import { useDebouncedUrlInput, useUrlParams } from "@/lib/hub/use-url-params";

const ALL = "__all";
const ACTOR_MAX = 128;
const isActor = (x: string) => x.length <= ACTOR_MAX;

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
 * Nhật ký thao tác (S2-3/S2-5). Mỗi dòng được ghi CÙNG transaction với hành động — có hành động thì chắc chắn có
 * dòng này. ADR-163: Trước/Sau theo cursor keyset `(created_at, id)`; lọc người làm, hành động, loại đối tượng,
 * khoảng thời gian — tất cả trên URL.
 */
function AuditView() {
  const url = useUrlParams(AUDIT_PARAMS);
  const v = url.values;
  const facets = useAuditFacets();
  const { data, isLoading, isPlaceholderData, error } = useAuditLogs(toApiQuery(v));
  const writeActor = useCallback((x: string | null) => url.setFilter({ actor: x }), [url.setFilter]);
  const [actorInput, setActorInput] = useDebouncedUrlInput(v.actor, isActor, writeActor, 400, url.resetToken);
  const filtered = Boolean(v.actor || v.action || v.entityType || v.from || v.to);
  // Nhóm hành động theo tiền tố (`delivery.` gồm delivery.replay, delivery.replay_bulk) + từng hành động.
  const actions = facets.data?.actions ?? [];
  const actionGroups = [...new Set(actions.map((a) => a.split(".")[0]).filter(Boolean))].map((g) => `${g}.`);

  return (
    <>
      <PageHeader
        title="Nhật ký thao tác"
        description="Ai đã làm gì, lúc nào, vì sao: replay, replay hàng loạt, chuẩn hoá lại, tạo/sửa/xoá nguồn, đích, subscription."
      />
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Input
          value={actorInput}
          onChange={(e) => setActorInput(e.target.value)}
          placeholder="Người làm (email…)"
          maxLength={ACTOR_MAX}
          list="audit-actors"
          className="h-8 w-48 text-xs"
          aria-label="Người làm"
        />
        <datalist id="audit-actors">
          {(facets.data?.actors ?? []).map((a) => (
            <option key={a} value={a} />
          ))}
        </datalist>
        <Select value={v.action ?? ALL} onValueChange={(a) => url.setFilter({ action: a === ALL ? null : a })}>
          <SelectTrigger size="sm" className="w-56" aria-label="Hành động">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Mọi hành động</SelectItem>
            {actionGroups.map((g) => (
              <SelectItem key={g} value={g} className="font-mono text-xs">
                {g}*
              </SelectItem>
            ))}
            {actions.map((a) => (
              <SelectItem key={a} value={a} className="font-mono text-xs">
                {a}
              </SelectItem>
            ))}
            {v.action && !actions.includes(v.action) && !actionGroups.includes(v.action) && (
              <SelectItem value={v.action} className="font-mono text-xs">
                {v.action}
              </SelectItem>
            )}
          </SelectContent>
        </Select>
        <Select value={v.entityType ?? ALL} onValueChange={(e) => url.setFilter({ entityType: e === ALL ? null : e })}>
          <SelectTrigger size="sm" className="w-48" aria-label="Loại đối tượng">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Mọi loại đối tượng</SelectItem>
            {[...new Set([...(facets.data?.entityTypes ?? []), ...(v.entityType ? [v.entityType] : [])])].map((e) => (
              <SelectItem key={e} value={e} className="font-mono text-xs">
                {e}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <TimeRange key={url.resetToken} from={v.from} to={v.to} onChange={(r) => url.setFilter(r)} />
        {filtered && (
          <Button variant="ghost" size="sm" onClick={url.clear}>
            <X />
            Bỏ lọc
          </Button>
        )}
      </div>
      <DataTable
        data={data?.items}
        columns={columns}
        getRowId={(a) => a.id}
        isLoading={isLoading}
        isStale={isPlaceholderData}
        error={error}
        pageSize={false}
        searchPlaceholder="Lọc trong trang này…"
        emptyText={filtered ? "Không có thao tác nào khớp bộ lọc." : "Chưa có hành động nào được ghi."}
        toolbar={
          <CursorPager
            next={data?.next}
            prev={data?.prev}
            loading={isPlaceholderData}
            onNext={(c) => url.setCursor({ before: c })}
            onPrev={(c) => url.setCursor({ after: c })}
            onNewest={() => url.setCursor({})}
          />
        }
      />
    </>
  );
}

export default function AuditPage() {
  return (
    <Suspense fallback={<Skeleton className="h-96 w-full" />}>
      <AuditView />
    </Suspense>
  );
}
