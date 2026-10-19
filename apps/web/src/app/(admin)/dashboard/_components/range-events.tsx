"use client";

import { useEffect, useMemo } from "react";

import { X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { cn } from "cn";

import { GridList, GridListRow } from "@/components/admin/grid-list";
import { expectedProbe, noDestination } from "@/components/flow/event-notes";
import { EXECUTION_TONE, ExecutionStatusPill } from "@/components/flow/execution-bits";
import { ProviderIcon } from "@/components/flow/provider-icon";
import { TONE_VAR } from "@/components/flow/tokens";
import { UnverifiedBadge } from "@/components/flow/unverified-badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { CellTooltip } from "@/components/ui/cell-tooltip";
import type { ExecutionFilters } from "@/lib/hub/flow-types";
import { useExecutions } from "@/lib/hub/queries";
import { useT } from "@/lib/i18n/use-t";

import { eventsHref, formatSelection, formatVn, type Selection } from "./chart-selection";
import { useChartSelection } from "./selection-context";

const GRID_COLS = "8rem 7.5rem minmax(0,1fr) 7.5rem";
/** Dưới `md`: thẻ 2 cột [thời gian | trạng thái] / [kiểu · đối tượng] / [nhà cung cấp]. */
const ROW_CARD =
  "max-md:[&>:nth-child(1)]:order-1 max-md:[&>:nth-child(4)]:order-2 max-md:[&>:nth-child(4)]:justify-self-end max-md:[&>:nth-child(3)]:order-3 max-md:[&>:nth-child(3)]:col-span-2 max-md:[&>:nth-child(2)]:order-4 max-md:[&>:nth-child(2)]:col-span-2";

/**
 * ADR-262: khối "Sự kiện từ …" khi có vùng chọn trên biểu đồ. Dùng `/flow/executions?from&to` (CÙNG endpoint trang Sự kiện,
 * không đổi backend); chỉ truy vấn khi vùng chọn đã chốt (URL đổi), không theo từng lần rê chuột. Không cập nhật trực tiếp.
 */
export function RangeEvents({ selection }: { selection: Selection }) {
  const t = useT();
  const router = useRouter();
  const { select, setHoverAt } = useChartSelection();
  const filters: ExecutionFilters = useMemo(() => ({ from: selection.from, to: selection.to }), [selection.from, selection.to]);
  const q = useExecutions(filters);
  const items = useMemo(() => q.data?.pages.flatMap((p) => p.items) ?? [], [q.data]);
  const label = formatSelection(selection);
  useEffect(() => () => setHoverAt(null), [setHoverAt]);

  // Rê / focus một dòng -> báo mốc của nó cho biểu đồ (ủy quyền ở khung ngoài; dòng mang `data-ts` ở ô thời gian).
  const track = (target: EventTarget) => {
    const row = (target as HTMLElement).closest("[role=button]");
    setHoverAt(row?.querySelector<HTMLElement>("[data-ts]")?.dataset.ts ?? null);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("page.dashboard.sel.title", { range: label })}</CardTitle>
        <CardDescription>{t("page.dashboard.sel.desc")}</CardDescription>
        <CardAction className="flex flex-wrap items-center justify-end gap-2">
          <Button
            variant="secondary"
            size="sm"
            className="max-md:min-h-10 max-md:px-3"
            onClick={() => select(null)}
            title={t("page.dashboard.sel.clear")}
          >
            {/* Tên truy cập = chữ hiển thị + "Bỏ chọn" (WCAG 2.5.3 label-in-name). */}
            <span className="tabular-nums">{t("page.dashboard.sel.chip", { range: label })}</span>
            <span className="sr-only">{t("page.dashboard.sel.clear")}</span>
            <X className="size-3.5" aria-hidden />
          </Button>
          <Button asChild variant="outline" size="sm" className="max-md:min-h-10 max-md:px-3">
            <Link href={eventsHref(selection)}>{t("page.dashboard.recent.view-all")}</Link>
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        <p className="sr-only" aria-live="polite">
          {q.isLoading ? "" : t("page.dashboard.sel.announce", { count: items.length, range: label })}
          {q.hasNextPage ? ` ${t("page.dashboard.sel.announce-more")}` : ""}
        </p>
        {/* biome-ignore lint/a11y/noStaticElementInteractions: ủy quyền rê/focus cho các dòng bên trong (mỗi dòng tự là nút) */}
        <div
          className="flow-surface overflow-hidden rounded-2xl"
          onMouseOver={(e) => track(e.target)}
          onFocus={(e) => track(e.target)}
          onMouseLeave={() => setHoverAt(null)}
          onBlur={() => setHoverAt(null)}
        >
          <GridList
            template={GRID_COLS}
            stack
            headers={[
              t("page.events.col.time"),
              t("page.events.col.provider"),
              t("page.events.col.type"),
              t("page.events.col.status"),
            ]}
            loading={q.isLoading}
            error={q.error}
            onRetry={() => void q.refetch()}
            isEmpty={items.length === 0}
            emptyText={t("page.dashboard.sel.empty")}
          >
            {items.map((i) => {
              const probe = expectedProbe(i);
              return (
                <GridListRow
                  key={i.id}
                  onActivate={() => router.push(`/dashboard/events/${encodeURIComponent(i.id)}`)}
                  className={cn(ROW_CARD)}
                  tone={probe || (i.status === "succeeded" && noDestination(i)) ? TONE_VAR.idle : TONE_VAR[EXECUTION_TONE[i.status]]}
                  style={{ contentVisibility: "auto", containIntrinsicSize: "auto 44px" }}
                >
                  <span data-ts={i.receivedAt} className="text-xs tabular-nums">
                    {formatVn(i.receivedAt)}
                  </span>
                  <CellTooltip text={i.providerLabel}>
                    <span className="inline-flex min-w-0 items-center gap-1.5">
                      <span className="shrink-0 text-muted-foreground">
                        <ProviderIcon provider={i.provider} name={i.sourceName ?? undefined} size={14} />
                      </span>
                      <span data-cell-text className="truncate text-sm">{i.providerLabel}</span>
                    </span>
                  </CellTooltip>
                  <span className="min-w-0">
                    <CellTooltip text={i.type} className="flex">
                      <span className="flex min-w-0 items-center gap-1.5">
                        <span data-cell-text className="truncate font-mono text-xs">{i.type ?? "—"}</span>
                        <UnverifiedBadge of={i} />
                      </span>
                    </CellTooltip>
                    {i.subject && (
                      <CellTooltip text={i.subject} className="flex">
                        <span data-cell-text className="block truncate text-muted-foreground text-xs">{i.subject}</span>
                      </CellTooltip>
                    )}
                  </span>
                  <ExecutionStatusPill status={i.status} probe={probe} noDest={noDestination(i)} />
                </GridListRow>
              );
            })}
          </GridList>
        </div>
        {q.hasNextPage && (
          <div className="mt-3 flex justify-center">
            <Button variant="outline" size="sm" disabled={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>
              {q.isFetchingNextPage ? t("page.dashboard.sel.loading-more") : t("page.dashboard.sel.more")}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
