"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { ExecutionStatus } from "@hub/flow";
import { Eye, Pause, Play, Search, X } from "lucide-react";
import { useRouter } from "next/navigation";

import { PageHeader } from "@/components/admin/page-header";
import { expectedProbe } from "@/components/flow/event-notes";
import { EXECUTION_TONE, ExecutionStatusPill, FailedAt, MiniPipeline } from "@/components/flow/execution-bits";
import { ProjectPicker } from "@/components/flow/project-picker";
import { ProviderIcon } from "@/components/flow/provider-icon";
import { clock } from "@/components/flow/time";
import { ICON, TONE_VAR } from "@/components/flow/tokens";
import { UnverifiedBadge } from "@/components/flow/unverified-badge";
import { Button } from "@/components/ui/button";
import { CellTooltip } from "@/components/ui/cell-tooltip";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { TimeRange } from "@/components/admin/time-range";
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
const GRID_COLS = "grid-cols-[7rem_7.5rem_minmax(0,1fr)_9rem_7.5rem_minmax(0,1fr)_2rem]";

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
        <div className="inline-flex rounded-lg border p-0.5" role="tablist">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={status === tab.id}
              onClick={() => url.setFilter({ status: tab.id === "all" ? null : tab.id })}
              className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1 text-sm ${status === tab.id ? "bg-muted font-medium" : "text-muted-foreground hover:text-foreground"}`}
            >
              {tab.id !== "all" && <span className="size-1.5 rounded-full" style={{ background: TONE_VAR[EXECUTION_TONE[tab.id]] }} />}
              {t(tab.label)}
            </button>
          ))}
        </div>
        <Select value={source || ALL} onValueChange={(x) => url.setFilter({ source: x === ALL ? null : x })}>
          <SelectTrigger size="sm" className="w-48">
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
          <SelectTrigger size="sm" className="w-52">
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
        <div className="relative">
          <Search size={14} strokeWidth={1.75} className="-translate-y-1/2 absolute top-1/2 left-2 text-muted-foreground" aria-hidden />
          <Input value={typeInput} onChange={(e) => setTypeInput(e.target.value)} placeholder={t("page.events.filter.type")} className="h-8 w-48 pl-7 font-mono text-xs" />
        </div>
        <div className="relative">
          <Search size={14} strokeWidth={1.75} className="-translate-y-1/2 absolute top-1/2 left-2 text-muted-foreground" aria-hidden />
          <Input
            value={idInput}
            onChange={(e) => setIdInput(e.target.value)}
            placeholder={t("page.events.filter.id")}
            title={t("page.events.filter.id-hint")}
            className="h-8 w-48 pl-7 font-mono text-xs"
          />
        </div>
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
        <div className={`grid ${GRID_COLS} items-center gap-3 border-b bg-muted/40 px-4 py-2 font-medium text-muted-foreground text-xs`}>
          <span>{t("page.events.col.time")}</span>
          <span>{t("page.events.col.provider")}</span>
          <span>{t("page.events.col.type")}</span>
          <span>{t("page.events.col.pipeline")}</span>
          <span>{t("page.events.col.status")}</span>
          <span>{t("page.events.col.failed-at")}</span>
          <span />
        </div>
        {q.isLoading && (
          <div className="space-y-2 p-4">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-8 w-full" />
            ))}
          </div>
        )}
        {q.error && <p className="p-4 text-destructive text-sm">{t("page.events.load-error", { message: q.error.message })}</p>}
        {!q.isLoading && items.length === 0 && <p className="p-6 text-center text-muted-foreground text-sm">{t("page.events.no-match")}</p>}
        {items.map((i) => {
          // Request kiểm tra kết nối của provider (ADR-159) → viền xám + pill "Kiểm tra kết nối", như ngăn Nhật ký.
          const probe = expectedProbe(i);
          const anim = unroll(i.id);
          return (
            // biome-ignore lint/a11y/useSemanticElements: hàng bảng bấm được
            <div
              key={i.id}
              role="button"
              tabIndex={0}
              onClick={() => router.push(`/dashboard/events/${encodeURIComponent(i.id)}`)}
              onKeyDown={(e) => e.key === "Enter" && router.push(`/dashboard/events/${encodeURIComponent(i.id)}`)}
              className={`grid cursor-pointer ${GRID_COLS} items-center gap-3 border-b border-l-2 px-4 py-2 text-sm last:border-b-0 hover:bg-muted/40 ${anim.className ?? ""}`}
              style={{
                borderLeftColor: probe ? TONE_VAR.idle : TONE_VAR[EXECUTION_TONE[i.status]],
                contentVisibility: "auto",
                containIntrinsicSize: "auto 44px",
                ...anim.style,
              }}
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
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={t("page.events.quick-view")}
                    title={t("page.events.quick-view")}
                    onClick={(e) => {
                      e.stopPropagation();
                      setQuick({ id: i.eventId, open: true });
                    }}
                  >
                    <Eye />
                  </Button>
                )}
              </span>
            </div>
          );
        })}
        <div ref={sentinel} className="h-6" />
        {q.isFetchingNextPage && <p className="pb-3 text-center text-muted-foreground text-xs">{t("page.events.loading-more")}</p>}
        {!q.hasNextPage && items.length > 0 && <p className="pb-3 text-center text-muted-foreground text-xs">{t("page.events.end")}</p>}
      </div>

      <EventSheet eventId={quick.id} open={quick.open} onClose={() => setQuick((s) => ({ ...s, open: false }))} />
    </>
  );
}

export default function EventsPage() {
  return (
    <Suspense fallback={<Skeleton className="h-96 w-full" />}>
      <ExecutionsView />
    </Suspense>
  );
}
