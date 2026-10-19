"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { ExecutionStatus } from "@hub/flow";
import { Eye, Pause, Play, X } from "lucide-react";
import { cn } from "cn";
import { useRouter } from "next/navigation";

import { PageHeader } from "@/components/admin/page-header";
import { GridList, GridListRow } from "@/components/admin/grid-list";
import { expectedProbe } from "@/components/flow/event-notes";
import { EXECUTION_TONE, ExecutionStatusPill, FailedAt, MiniPipeline } from "@/components/flow/execution-bits";
import { ProjectPicker } from "@/components/flow/project-picker";
import { ProviderIcon } from "@/components/flow/provider-icon";
import { clock } from "@/components/flow/time";
import { ICON, TONE_VAR } from "@/components/flow/tokens";
import { UnverifiedBadge } from "@/components/flow/unverified-badge";
import { Button } from "@/components/ui/button";
import { CellTooltip } from "@/components/ui/cell-tooltip";
import { SearchInput } from "@/components/admin/search-input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PageSkeleton } from "@/components/admin/skeletons";
import { TimeRange } from "@/components/admin/time-range";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { IconButton } from "@/components/admin/icon-button";
import { formatRelative } from "@/lib/hub/format";
import type { ExecutionFilters } from "@/lib/hub/flow-types";
import { EXECUTION_PARAMS } from "@/lib/hub/list-url";
import { useDestinations, useExecutions, useFlowProjectStore, useSources } from "@/lib/hub/queries";
import { useDebouncedUrlInput, useUrlParams } from "@/lib/hub/use-url-params";
import type { MessageKey } from "@/lib/i18n/dictionary";
import { useLocale, useT } from "@/lib/i18n/use-t";
import { useUnroll } from "@/lib/ui/use-unroll";

import { EventSheet } from "./_components/event-sheet";
import { OrphanBanner } from "./_components/orphan-banner";
import { TraceFeed } from "./_components/trace-feed";
import { useRealtimeProject } from "@/lib/hub/socket";

const TABS: { id: ExecutionStatus | "all"; label: MessageKey }[] = [
  { id: "all", label: "common.all" },
  { id: "in_progress", label: "page.events.tab.in-progress" },
  { id: "failed", label: "page.events.tab.failed" },
  { id: "rejected", label: "page.events.tab.rejected" },
  { id: "succeeded", label: "page.events.tab.succeeded" },
];

const ALL = "__all";
const isTypePattern = (x: string) => /^[a-z0-9_]+(\.[a-z0-9_]+)*(\.\*)?$/.test(x);
const isIdPrefix = (x: string) => /^[0-9A-Za-z_-]{4,36}$/.test(x);

/**
 * Grid cố định 7 cột: Thời gian | Nhà cung cấp | Kiểu·đối tượng | Đường ống | Trạng thái | Hỏng ở | Mắt.
 * Pipeline cố 9rem (đủ 6 chấm + khoảng cách), Status cố 7.5rem, FailedAt co giãn.
 */
const GRID_COLS = "7rem 7.5rem minmax(0,1fr) 9rem 7.5rem minmax(0,1fr) 2rem";

/**
 * Dưới `md` (ADR-261) hàng thành thẻ 2 cột — xếp lại ô bằng `order`/`col-span` theo thứ tự con ở trên:
 * [thời gian | trạng thái] / [kiểu · đối tượng] / [nhà cung cấp | đường ống] / [hỏng ở]. Nút xem nhanh ẩn (chạm thẻ = mở hành trình đầy đủ).
 */
const ROW_CARD =
  "max-md:[&>:nth-child(1)]:order-1 max-md:[&>:nth-child(5)]:order-2 max-md:[&>:nth-child(5)]:justify-self-end max-md:[&>:nth-child(3)]:order-3 max-md:[&>:nth-child(3)]:col-span-2 max-md:[&>:nth-child(2)]:order-4 max-md:[&>:nth-child(4)]:order-5 max-md:[&>:nth-child(4)]:justify-self-end max-md:[&>:nth-child(6)]:order-6 max-md:[&>:nth-child(6)]:col-span-2 max-md:[&>:nth-child(7)]:hidden";

/**
 * V2 — Danh sách hành trình (SPEC-event-flow-ui §4). Dùng `/flow/executions` (KHÔNG dùng
 * `/api/v1/events` để khỏi vướng S7 của đa service). Mỗi dòng có "đường ống mini" + cột "Hỏng ở"
 * do server dựng. Dòng mới chảy vào qua invalidate socket; "Tạm dừng" để đọc.
 */
function ExecutionsView() {
  const router = useRouter();
  const t = useT();
  const locale = useLocale();
  // ADR-163: bộ lọc trên URL (F5 / gửi link giữ nguyên): trạng thái, source, đích, type, khoảng thời gian, id.
  const url = useUrlParams(EXECUTION_PARAMS);
  const v = url.values;
  const status = (v.status as ExecutionStatus | undefined) ?? "all";
  const source = v.source ?? "";
  const destination = v.destination ?? "";
  const [paused, setPaused] = useState(false);
  const [quick, setQuick] = useState<{ id: string | null; open: boolean }>({ id: null, open: false });
  // Ô gõ -> URL sau 350ms, chỉ khi hợp lệ hoặc rỗng (đang gõ dở thì không ghi, không xoá chữ); Back/Bỏ lọc -> ô theo URL.
  const writeType = useCallback((x: string | null) => url.setFilter({ type: x }), [url.setFilter]);
  const writeQ = useCallback((x: string | null) => url.setFilter({ q: x }), [url.setFilter]);
  const [typeInput, setTypeInput] = useDebouncedUrlInput(v.type, isTypePattern, writeType, 350, url.resetToken);
  const [idInput, setIdInput] = useDebouncedUrlInput(v.q, isIdPrefix, writeQ, 350, url.resetToken);

  const filters: ExecutionFilters = useMemo(
    () => ({
      status: status === "all" ? undefined : status,
      source: source || undefined,
      destination: destination || undefined,
      type: v.type,
      from: v.from,
      to: v.to,
      q: v.q,
    }),
    [status, source, destination, v.type, v.from, v.to, v.q],
  );
  const q = useExecutions(filters, { paused });
  useRealtimeProject(useFlowProjectStore((st) => st.projectId)); // R-5: socket theo project đang xem
  // R-4: danh sách lọc theo ĐÚNG project đang xem; đổi project thì bỏ lọc source/đích cũ (id của project khác).
  const projectId = useFlowProjectStore((s) => s.projectId);
  const sources = useSources(projectId);
  const destinations = useDestinations(projectId);
  const lastProject = useRef(projectId);
  useEffect(() => {
    if (lastProject.current === projectId) return;
    lastProject.current = projectId;
    url.setFilter({ source: null, destination: null });
  }, [projectId, url.setFilter]);
  const items = useMemo(() => q.data?.pages.flatMap((p) => p.items) ?? [], [q.data]);
  // Chỉ dòng mới nạp (cuộn xuống) / mới chèn (trực tiếp) "mở ra"; đổi bộ lọc = lô mới.
  const unroll = useUnroll(
    items.map((i) => i.id),
    { resetKey: `${projectId ?? ""}|${JSON.stringify(filters)}` },
  );

  // Cuộn vô hạn theo cursor.
  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver((es) => {
      if (es[0]?.isIntersecting && q.hasNextPage && !q.isFetchingNextPage) void q.fetchNextPage();
    });
    io.observe(el);
    return () => io.disconnect();
  }, [q.hasNextPage, q.isFetchingNextPage, q.fetchNextPage]);

  return (
    <>
      <PageHeader
        title={t("page.events.title")}
        description={t("page.events.description")}
        actions={
          <>
          <ProjectPicker />
          <Button variant={paused ? "default" : "outline"} size="sm" onClick={() => setPaused((p) => !p)} aria-pressed={paused}>
            {paused ? <Play {...ICON} /> : <Pause {...ICON} />}
            {paused ? t("page.events.resume") : t("page.events.pause")}
          </Button>
          </>
        }
      />
      <OrphanBanner />
      {/* P2: request trùng (DUPLICATE) / chữ ký sai (REJECTED) không sinh event -> chỉ thấy ở dải trực tiếp này. */}
      <div className="mb-3">
        <TraceFeed />
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Tabs className="max-w-full overflow-x-auto" value={status} onValueChange={(id) => url.setFilter({ status: id === "all" ? null : id })}>
          <TabsList variant="segmented">
            {TABS.map((tab) => (
              <TabsTrigger key={tab.id} value={tab.id}>
                {tab.id !== "all" && <span className="size-1.5 rounded-full" style={{ background: TONE_VAR[EXECUTION_TONE[tab.id]] }} />}
                {t(tab.label)}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <Select value={source || ALL} onValueChange={(x) => url.setFilter({ source: x === ALL ? null : x })}>
          <SelectTrigger size="sm" className="w-full sm:w-48" aria-label={t("page.events.filter.source")}>
            <SelectValue placeholder={t("page.events.filter.source")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{t("page.events.filter.all-sources")}</SelectItem>
            {sources.data?.map((s) => (
              <SelectItem key={s.id} value={s.id}>
                {s.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={destination || ALL} onValueChange={(x) => url.setFilter({ destination: x === ALL ? null : x })}>
          <SelectTrigger size="sm" className="w-full sm:w-52" aria-label={t("page.events.filter.destination")}>
            <SelectValue placeholder={t("page.events.filter.destination")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{t("page.events.filter.all-destinations")}</SelectItem>
            {destinations.data?.map((d) => (
              <SelectItem key={d.id} value={d.id}>
                {d.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <SearchInput
          wrapperClassName="w-full sm:w-48"
          value={typeInput}
          onChange={(e) => setTypeInput(e.target.value)}
          placeholder={t("page.events.filter.type")}
          aria-label={t("page.events.filter.type")}
          className="font-mono text-xs"
        />
        <SearchInput
          wrapperClassName="w-full sm:w-48"
          value={idInput}
          onChange={(e) => setIdInput(e.target.value)}
          placeholder={t("page.events.filter.id")}
          aria-label={t("page.events.filter.id")}
          title={t("page.events.filter.id-hint")}
          className="font-mono text-xs"
        />
        <TimeRange key={url.resetToken} from={v.from} to={v.to} onChange={(r) => url.setFilter(r)} />
        {(source || destination || v.type || v.q || v.from || v.to || status !== "all") && (
          <Button variant="ghost" size="sm" onClick={url.clear}>
            <X {...ICON} />
            {t("common.filters.clear")}
          </Button>
        )}
        <span className="ml-auto text-muted-foreground text-xs">{paused ? t("page.events.paused") : t("page.events.live")}</span>
      </div>

      <div className="flow-surface overflow-hidden rounded-2xl">
        <GridList
          template={GRID_COLS}
          stack
          headers={[
            t("page.events.col.time"),
            t("page.events.col.provider"),
            t("page.events.col.type"),
            t("page.events.col.pipeline"),
            t("page.events.col.status"),
            t("page.events.col.failed-at"),
            null,
          ]}
          loading={q.isLoading}
          error={q.error}
          onRetry={() => void q.refetch()}
          isEmpty={items.length === 0}
          emptyText={t("page.events.no-match")}
        >
        {items.map((i) => {
          // Request kiểm tra kết nối của provider (ADR-159) → viền xám + pill "Kiểm tra kết nối", như ngăn Nhật ký.
          const probe = expectedProbe(i);
          const anim = unroll(i.id);
          return (
            <GridListRow
              key={i.id}
              onActivate={() => router.push(`/dashboard/events/${encodeURIComponent(i.id)}`)}
              className={cn(ROW_CARD, anim.className)}
              tone={probe ? TONE_VAR.idle : TONE_VAR[EXECUTION_TONE[i.status]]}
              style={{ contentVisibility: "auto", containIntrinsicSize: "auto 44px", ...anim.style }}
            >
              {/* Thời gian */}
              <span className="text-xs tabular-nums" title={formatRelative(i.receivedAt, undefined, locale)}>
                {clock(i.receivedAt)}
              </span>
              {/* Nhà cung cấp */}
              <CellTooltip text={i.providerLabel}>
                <span className="inline-flex min-w-0 items-center gap-1.5">
                  <span className="shrink-0 text-muted-foreground">
                    <ProviderIcon provider={i.provider} name={i.sourceName ?? undefined} size={14} />
                  </span>
                  <span data-cell-text className="truncate text-sm">{i.providerLabel}</span>
                </span>
              </CellTooltip>
              {/* Kiểu · đối tượng */}
              <span className="min-w-0">
                <CellTooltip text={i.type} className="flex">
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span data-cell-text className="truncate font-mono text-xs">{i.type ?? "—"}</span>
                    {/* PK5 (E4): nhãn ở mọi nơi có event — hub không xác thực nguồn này. */}
                    <UnverifiedBadge of={i} />
                  </span>
                </CellTooltip>
                {i.subject && (
                  <CellTooltip text={i.subject} className="flex">
                    <span data-cell-text className="block truncate text-muted-foreground text-xs">{i.subject}</span>
                  </CellTooltip>
                )}
              </span>
              {/* Đường ống */}
              <MiniPipeline summary={i.summary} context={i} />
              {/* Trạng thái */}
              <ExecutionStatusPill status={i.status} probe={probe} />
              {/* Hỏng ở */}
              <FailedAt failedAt={i.failedAt} status={i.status} />
              {/* Xem nhanh */}
              <span>
                {i.eventId && (
                  <IconButton
                    size="icon-xs"
                    icon={<Eye />}
                    label={t("page.events.quick-view")}
                    onClick={(e) => {
                      e.stopPropagation();
                      setQuick({ id: i.eventId, open: true });
                    }}
                  />
                )}
              </span>
            </GridListRow>
          );
        })}
        <div ref={sentinel} className="h-6" />
        {q.isFetchingNextPage && <p className="pb-3 text-center text-muted-foreground text-xs">{t("page.events.loading-more")}</p>}
        {!q.hasNextPage && items.length > 0 && <p className="pb-3 text-center text-muted-foreground text-xs">{t("page.events.end")}</p>}
        </GridList>
      </div>

      <EventSheet eventId={quick.id} open={quick.open} onClose={() => setQuick((s) => ({ ...s, open: false }))} />
    </>
  );
}

export default function EventsPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <ExecutionsView />
    </Suspense>
  );
}
