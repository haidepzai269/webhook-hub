"use client";

import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { type InfiniteData, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronUp, EyeOff, Pause, Play, Terminal } from "lucide-react";

import { GridList, GridListRow } from "@/components/admin/grid-list";
import { CellTooltip } from "@/components/ui/cell-tooltip";
import { Button } from "@/components/ui/button";
import { SearchInput } from "@/components/admin/search-input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { ExecutionFilters, ExecutionStatus } from "@/lib/hub/flow-types";
import { EVENT_LOG_PARAMS, EXECUTION_STATUS_VALUES } from "@/lib/hub/list-url";
import type { ExecutionsPage } from "@/lib/hub/flow-types";
import { flowKeys, useExecutions, useFlowProjectStore, useSources } from "@/lib/hub/queries";
import { useUrlParams } from "@/lib/hub/use-url-params";
import { clock } from "./time";
import { useT } from "@/lib/i18n/use-t";
import { useUnroll } from "@/lib/ui/use-unroll";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

import { shouldAutoLoadMore, shouldResetHead } from "./event-log-logic";
import { describeEvent, expectedProbe, noDestination, type NoteTone } from "./event-notes";
import { EXECUTION_LABEL_KEY, EXECUTION_TONE, FailedAt, failedAtText, MiniPipeline } from "./execution-bits";
import {
  clampLogHeight,
  LOG_COLUMNS,
  logGridTemplate,
  logHeightAria,
  logMinWidth,
  readLogHeight,
  stepLogHeight,
  writeLogHeight,
} from "./log-layout";
import { ProviderIcon } from "./provider-icon";
import { UnverifiedBadge } from "./unverified-badge";
import { ICON, TONE_VAR } from "./tokens";

/** localStorage có thể ném (chế độ riêng tư, site data bị chặn) → null, trang vẫn chạy. */
function viewerStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

const ALL = "__all";
/** Trang (50 dòng) giữ trong bộ nhớ của ngăn nhật ký — 250 dòng, đủ đọc, không phình theo giờ. */
const LOG_MAX_PAGES = 5;

const GRID_TEMPLATE = logGridTemplate();
const MIN_WIDTH = logMinWidth();

/** Màu chữ cột "Ghi chú": bình thường / đúng thiết kế thì nhạt (muted), cần xem cấu hình thì vàng, hỏng thì đỏ. */
const NOTE_COLOR: Record<NoteTone, string> = {
  neutral: "var(--muted-foreground)",
  expected: "var(--muted-foreground)",
  attention: TONE_VAR.warning,
  error: TONE_VAR.crashed,
};

/**
 * Nhật ký sự kiện trực tiếp (SPEC §0A.C): ngăn dưới kiểu console trên V3. Mỗi dòng = một hành trình
 * rút gọn (cùng `/flow/executions` với V2), màu theo kết quả, bấm → V1. Cập nhật bằng invalidate
 * socket (không tự ghép trạng thái); "Tạm dừng" ngừng nhận dòng mới để đọc.
 * Kéo mép trên để đổi chiều cao (25%–85% viewport, nhớ theo người xem); lưới cột cố định (log-layout.ts).
 * ADR-163: lọc provider / kết quả / "Ẩn request kiểm tra" (cờ events.probe ở SERVER) nằm trên URL (`logProvider`,
 * `logStatus`, `logProbes`); dòng mới trực tiếp vào trên cùng, cuộn xuống đáy nạp trang cũ hơn (cursor keyset);
 * chỉ dòng mới nạp/mới chèn "mở ra" (styles/unroll.css).
 */
export function EventLog() {
  return (
    <Suspense fallback={null}>
      <EventLogPanel />
    </Suspense>
  );
}

function EventLogPanel() {
  const t = useT();
  const [open, setOpen] = useState(true);
  const [paused, setPaused] = useState(false);
  const [q, setQ] = useState("");
  const url = useUrlParams(EVENT_LOG_PARAMS);
  const { logProvider, logStatus, logProbes } = url.values;
  const filters: ExecutionFilters = useMemo(
    () => ({ provider: logProvider, status: logStatus as ExecutionStatus | undefined, probes: logProbes === "hide" ? "hide" : undefined }),
    [logProvider, logStatus, logProbes],
  );
  // Cuộn xa khỏi đỉnh = tạm dừng luồng (như nút Tạm dừng): dòng mới không đẩy chỗ đang đọc; về đỉnh thì chạy tiếp.
  const [awayFromTop, setAwayFromTop] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const live = !paused && !awayFromTop;
  let liveLabel = t("journey.log.live");
  if (paused) liveLabel = t("journey.log.paused");
  else if (awayFromTop) liveLabel = t("journey.log.paused-scroll");
  const { data, isLoading, hasNextPage, isFetchingNextPage, fetchNextPage, refetch } = useExecutions(filters, {
    paused: !live,
    maxPages: LOG_MAX_PAGES,
  });
  const projectId = useFlowProjectStore((s) => s.projectId);
  const qc = useQueryClient();
  // Thu gọn ngăn / đổi bộ lọc -> vùng cuộn về đỉnh -> trực tiếp lại.
  // biome-ignore lint/correctness/useExhaustiveDependencies: chạy lại đúng khi open / bộ lọc đổi (không đọc chúng)
  useEffect(() => {
    setAwayFromTop(false);
    scroller.current?.scrollTo({ top: 0 });
  }, [open, filters]);
  // maxPages đã bỏ trang đầu (cuộn sâu) -> CHỈ ở bước chuyển thật "không trực tiếp -> trực tiếp" (về đỉnh, hoặc bấm
  // Tiếp tục khi đã ở đỉnh) mới nạp lại từ trang mới nhất (TB1).
  const headDropped = data !== undefined && data.pageParams[0] != null;
  const wasLive = useRef(live);
  useEffect(() => {
    const prev = wasLive.current;
    wasLive.current = live;
    if (!shouldResetHead({ wasLive: prev, live, headDropped })) return;
    qc.setQueryData<InfiniteData<ExecutionsPage, string | null>>(flowKeys.executions(filters, projectId), (d) =>
      d ? { pages: d.pages.slice(0, 1), pageParams: [null] } : d,
    );
    void refetch();
  }, [live, headDropped, qc, filters, projectId, refetch]);
  const sources = useSources(projectId);
  const providers = useMemo(() => {
    const set = new Set<string>((sources.data ?? []).map((s) => s.provider));
    set.add("api");
    if (logProvider) set.add(logProvider);
    return [...set].sort();
  }, [sources.data, logProvider]);
  const [height, setHeight] = useState<number | null>(null);
  const heightRef = useRef<number | null>(null);
  heightRef.current = height;
  const drag = useRef<{ startY: number; startH: number } | null>(null);
  const [viewportH, setViewportH] = useState<number | null>(null);

  // Đọc chiều cao đã nhớ sau khi mount (tránh lệch hydrate); viewport đổi → kẹp lại trong 25–85%.
  useEffect(() => {
    setHeight(readLogHeight(viewerStorage(), window.innerHeight));
    setViewportH(window.innerHeight);
    const onResize = () => {
      setViewportH(window.innerHeight);
      setHeight((h) => (h === null ? h : clampLogHeight(h, window.innerHeight)));
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const onDragStart = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { startY: e.clientY, startH: heightRef.current ?? window.innerHeight * 0.25 };
    setOpen(true);
  }, []);
  const onDragMove = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    setHeight(clampLogHeight(d.startH + (d.startY - e.clientY), window.innerHeight));
  }, []);
  const onDragEnd = useCallback(() => {
    if (!drag.current) return;
    drag.current = null;
    if (heightRef.current !== null) writeLogHeight(viewerStorage(), heightRef.current);
  }, []);
  /** Bàn phím (L-B3): ↑/↓ 5% viewport, Home/End = min/max; nhớ ngay như khi thả chuột. */
  const onResizeKey = useCallback((e: ReactKeyboardEvent<HTMLDivElement>) => {
    const vh = window.innerHeight;
    const next = stepLogHeight(heightRef.current ?? vh * 0.25, e.key, vh);
    if (next === null) return;
    e.preventDefault();
    setOpen(true);
    setHeight(next);
    writeLogHeight(viewerStorage(), next);
  }, []);
  const aria = height !== null && viewportH ? logHeightAria(height, viewportH) : null;
  const all = useMemo(() => data?.pages.flatMap((p) => p.items) ?? [], [data]);
  const items = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return needle ? all.filter((i) => [i.type, i.provider, i.sourceName, i.subject, i.id].some((v) => v?.toLowerCase().includes(needle))) : all;
  }, [all, q]);
  // Số phận "mở ra" tính trên TOÀN BỘ dòng đã nạp (không phải tập đã lọc client) — gõ lọc không làm dòng cũ chạy lại.
  const unroll = useUnroll(
    all.map((i) => i.id),
    { resetKey: `${projectId ?? ""}|${logProvider ?? ""}|${logStatus ?? ""}|${logProbes ?? ""}` },
  );

  // Cuộn tới đáy ngăn -> nạp trang cũ hơn (cursor). Root = vùng cuộn của chính ngăn.
  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !open) return;
    const io = new IntersectionObserver(
      (es) => {
        const go = shouldAutoLoadMore({ visible: Boolean(es[0]?.isIntersecting), hasNextPage: Boolean(hasNextPage), fetching: isFetchingNextPage, clientFilter: q });
        if (go) void fetchNextPage();
      },
      { root: scroller.current, rootMargin: "120px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [open, hasNextPage, isFetchingNextPage, fetchNextPage, q]);

  return (
    <div
      className="flow-surface relative flex min-h-0 shrink-0 flex-col overflow-hidden rounded-xl"
      style={open ? { height: height ?? "25svh" } : undefined}
    >
      {/* Tay kéo mép trên: hover hiện con trỏ row-resize + vạch nhỏ. */}
      <Tooltip>
        <TooltipTrigger asChild>
          {/* biome-ignore lint/a11y/useSemanticElements: <hr> không nhận pointer kéo; separator ngang là vai trò đúng */}
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label={t("journey.log.resize-aria")}
        aria-valuenow={aria?.now}
        aria-valuemin={aria?.min}
        aria-valuemax={aria?.max}
        aria-valuetext={aria ? t("journey.log.resize-value", { n: aria.now }) : undefined}
        tabIndex={0}
        className="flow-log-resizer absolute inset-x-0 top-0 z-10 h-2 cursor-row-resize touch-none"
        onPointerDown={onDragStart}
        onPointerMove={onDragMove}
        onPointerUp={onDragEnd}
        onPointerCancel={onDragEnd}
        onKeyDown={onResizeKey}
      />
        </TooltipTrigger>
        <TooltipContent>{t("journey.log.resize-title")}</TooltipContent>
      </Tooltip>
      <div className="flex shrink-0 items-center gap-2 border-b px-3 py-1.5" style={{ borderColor: "var(--flow-card-border)" }}>
        <Terminal {...ICON} className="text-muted-foreground" aria-hidden />
        <span className="font-medium text-sm">{t("journey.log.title")}</span>
        <span className="text-muted-foreground text-xs" aria-live="polite">
          {liveLabel}
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          {open && (
            <>
              <Select value={logProvider ?? ALL} onValueChange={(v) => url.setFilter({ logProvider: v === ALL ? null : v })}>
                <SelectTrigger size="sm" className="w-40 text-xs" aria-label={t("journey.log.filter-provider")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>{t("journey.log.all-providers")}</SelectItem>
                  {providers.map((p) => (
                    <SelectItem key={p} value={p}>
                      {p}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={logStatus ?? ALL} onValueChange={(v) => url.setFilter({ logStatus: v === ALL ? null : v })}>
                <SelectTrigger size="sm" className="w-32 text-xs" aria-label={t("journey.log.filter-outcome")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>{t("journey.log.all-outcomes")}</SelectItem>
                  {EXECUTION_STATUS_VALUES.map((st) => (
                    <SelectItem key={st} value={st}>
                      {t(EXECUTION_LABEL_KEY[st])}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant={logProbes === "hide" ? "secondary" : "ghost"}
                    size="sm"
                    aria-pressed={logProbes === "hide"}
                    onClick={() => url.setFilter({ logProbes: logProbes === "hide" ? null : "hide" })}
                  >
                    <EyeOff {...ICON} />
                    {t("journey.log.hide-probes")}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{t("journey.log.hide-probes-title")}</TooltipContent>
              </Tooltip>
            </>
          )}
          {open && (
            <SearchInput
              size="sm"
              wrapperClassName="w-52"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={t("journey.log.search-placeholder")}
              aria-label={t("journey.log.search-placeholder")}
              className="text-xs"
            />
          )}
          <Button variant="ghost" size="sm" onClick={() => setPaused((p) => !p)} aria-pressed={paused}>
            {paused ? <Play {...ICON} /> : <Pause {...ICON} />}
            {paused ? t("journey.log.resume") : t("journey.log.pause")}
          </Button>
          <Button variant="ghost" size="icon-sm" onClick={() => setOpen((o) => !o)} aria-label={open ? t("journey.log.collapse") : t("journey.log.expand")}>
            {open ? <ChevronDown {...ICON} /> : <ChevronUp {...ICON} />}
          </Button>
        </div>
      </div>
      {open && (
        <div
          ref={scroller}
          className="min-h-0 flex-1 overflow-auto font-mono text-[12px]"
          onScroll={(e) => setAwayFromTop(e.currentTarget.scrollTop > 24)}
        >
          {/* Hẹp hơn tổng min cột → cuộn ngang trong ngăn (log-layout.ts) thay vì đè chữ. */}
          <GridList
            template={GRID_TEMPLATE}
            minWidth={MIN_WIDTH}
            density="sm"
            sticky
            headerStyle={{ borderBottomColor: "var(--flow-card-border)", background: "var(--flow-card-solid)" }}
            headers={LOG_COLUMNS.map((c) => t(c.labelKey))}
            loading={isLoading}
            isEmpty={items.length === 0}
            emptyText={t("journey.log.empty")}
          >
            {items.map((i) => {
              // Request kiểm tra kết nối của provider đúng thiết kế (ADR-159) → viền + nhãn trung tính, không "Thành công" xanh.
              const probe = expectedProbe(i);
              // "Không có đích" (ADR-259): đã nhận nhưng không subscription nào khớp → trung tính, không "Thành công" xanh.
              const noDest = !probe && i.status === "succeeded" && noDestination(i);
              const color = probe || noDest ? TONE_VAR.idle : TONE_VAR[EXECUTION_TONE[i.status]];
              const resultLabel = probe ? t(probe.label) : noDest ? t("journey.exec.no-destination") : t(EXECUTION_LABEL_KEY[i.status]);
              const note = describeEvent(i, t);
              const anim = unroll(i.id);
              return (
                <GridListRow
                  key={i.id}
                  href={`/dashboard/events/${encodeURIComponent(i.id)}`}
                  className={anim.className}
                  tone={color}
                  style={anim.style}
                >
                  <span className="truncate text-muted-foreground tabular-nums">{clock(i.receivedAt)}</span>
                  <CellTooltip text={i.providerLabel}>
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span className="shrink-0 text-muted-foreground">
                        <ProviderIcon provider={i.provider} name={i.sourceName ?? undefined} size={14} />
                      </span>
                      <span data-cell-text className="truncate">{i.providerLabel}</span>
                    </span>
                  </CellTooltip>
                  <span className="min-w-0 overflow-hidden">
                    <MiniPipeline summary={i.summary} context={i} decorative />
                  </span>
                  <CellTooltip text={i.type ?? resultLabel}>
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span data-cell-text className="truncate">{i.type ?? <span style={{ color }}>{resultLabel}</span>}</span>
                      {/* PK5 khoá 2 (REVIEW-PK5-R2 T-a): nhãn chữ, không chỉ chấm mini decorative. */}
                      <UnverifiedBadge of={i} />
                    </span>
                  </CellTooltip>
                  <CellTooltip text={failedAtText(i.failedAt, t) ?? resultLabel}>
                    <span data-cell-text className="min-w-0 truncate">
                      {i.failedAt ? (
                        <FailedAt failedAt={i.failedAt} status={i.status} />
                      ) : (
                        <span style={{ color }} className="font-sans text-xs">
                          {resultLabel}
                        </span>
                      )}
                    </span>
                  </CellTooltip>
                  <CellTooltip text={note.text}>
                    <span data-cell-text className="min-w-0 truncate font-sans text-xs" style={{ color: NOTE_COLOR[note.tone] }}>
                      {note.text}
                    </span>
                  </CellTooltip>
                </GridListRow>
              );
            })}
            <div ref={sentinel} className="h-4" />
            {isFetchingNextPage && <div className="px-3 py-1 font-sans text-muted-foreground text-xs">{t("journey.log.loading-more")}</div>}
            {/* Đang lọc client: không tự nạp (TB1) — người xem chủ động nạp trang cũ hơn để tìm tiếp. */}
            {q.trim() !== "" && hasNextPage && !isFetchingNextPage && (
              <div className="px-3 py-1 font-sans text-xs">
                <Button variant="ghost" size="sm" onClick={() => void fetchNextPage()}>
                  {t("journey.log.load-more")}
                </Button>
              </div>
            )}
            {!hasNextPage && all.length > 0 && <div className="px-3 py-1 font-sans text-muted-foreground text-xs">{t("journey.log.end")}</div>}
          </GridList>
        </div>
      )}
    </div>
  );
}
