"use client";

import { Suspense, useEffect, useMemo, useRef, useState } from "react";

import type { ExecutionStatus } from "@hub/flow";
import { Eye, Pause, Play, Search, X } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";

import { PageHeader } from "@/components/admin/page-header";
import { EXECUTION_TONE, ExecutionStatusPill, FailedAt, MiniPipeline } from "@/components/flow/execution-bits";
import { ProjectPicker } from "@/components/flow/project-picker";
import { ProviderIcon } from "@/components/flow/provider-icon";
import { clock } from "@/components/flow/time";
import { ICON, TONE_VAR } from "@/components/flow/tokens";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { formatRelative } from "@/lib/hub/format";
import type { ExecutionFilters } from "@/lib/hub/flow-types";
import { useDestinations, useExecutions, useFlowProjectStore, useSources } from "@/lib/hub/queries";

import { EventSheet } from "./_components/event-sheet";
import { OrphanBanner } from "./_components/orphan-banner";
import { TraceFeed } from "./_components/trace-feed";
import { useRealtimeProject } from "@/lib/hub/socket";

const TABS: { id: ExecutionStatus | "all"; label: string }[] = [
  { id: "all", label: "Tất cả" },
  { id: "in_progress", label: "Đang chạy" },
  { id: "failed", label: "Thất bại" },
  { id: "rejected", label: "Bị từ chối" },
  { id: "succeeded", label: "Thành công" },
];

const ALL = "__all";

/**
 * V2 — Danh sách hành trình (SPEC-event-flow-ui §4). Dùng `/flow/executions` (KHÔNG dùng
 * `/api/v1/events` để khỏi vướng S7 của đa service). Mỗi dòng có "đường ống mini" + cột "Hỏng ở"
 * do server dựng. Dòng mới chảy vào qua invalidate socket; "Tạm dừng" để đọc.
 */
function ExecutionsView() {
  const router = useRouter();
  const sp = useSearchParams();
  const [status, setStatus] = useState<ExecutionStatus | "all">((sp.get("status") as ExecutionStatus) ?? "all");
  const [source, setSource] = useState<string>(sp.get("source") ?? "");
  const [destination, setDestination] = useState<string>(sp.get("destination") ?? "");
  const [typeInput, setTypeInput] = useState(sp.get("type") ?? "");
  const [type, setType] = useState(sp.get("type") ?? "");
  const [paused, setPaused] = useState(false);
  const [quick, setQuick] = useState<{ id: string | null; open: boolean }>({ id: null, open: false });

  useEffect(() => {
    const t = setTimeout(() => setType(/^[a-z0-9_.*]*$/.test(typeInput.trim()) ? typeInput.trim() : ""), 350);
    return () => clearTimeout(t);
  }, [typeInput]);

  const filters: ExecutionFilters = useMemo(
    () => ({ status: status === "all" ? undefined : status, source: source || undefined, destination: destination || undefined, type: type || undefined }),
    [status, source, destination, type],
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
    setSource("");
    setDestination("");
  }, [projectId]);
  const items = useMemo(() => q.data?.pages.flatMap((p) => p.items) ?? [], [q.data]);

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
        title="Hành trình sự kiện"
        description="Mỗi dòng là một lần provider gọi vào hub: đi qua chặng nào, hỏng ở đâu. Bấm dòng để mở hành trình đầy đủ."
        actions={
          <>
          <ProjectPicker />
          <Button variant={paused ? "default" : "outline"} size="sm" onClick={() => setPaused((p) => !p)} aria-pressed={paused}>
            {paused ? <Play {...ICON} /> : <Pause {...ICON} />}
            {paused ? "Tiếp tục luồng" : "Tạm dừng luồng"}
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
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={status === t.id}
              onClick={() => setStatus(t.id)}
              className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1 text-sm ${status === t.id ? "bg-muted font-medium" : "text-muted-foreground hover:text-foreground"}`}
            >
              {t.id !== "all" && <span className="size-1.5 rounded-full" style={{ background: TONE_VAR[EXECUTION_TONE[t.id]] }} />}
              {t.label}
            </button>
          ))}
        </div>
        <Select value={source || ALL} onValueChange={(v) => setSource(v === ALL ? "" : v)}>
          <SelectTrigger size="sm" className="w-48">
            <SelectValue placeholder="Source" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Mọi source</SelectItem>
            {sources.data?.map((s) => (
              <SelectItem key={s.id} value={s.id}>
                {s.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={destination || ALL} onValueChange={(v) => setDestination(v === ALL ? "" : v)}>
          <SelectTrigger size="sm" className="w-52">
            <SelectValue placeholder="Đích" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Mọi đích</SelectItem>
            {destinations.data?.map((d) => (
              <SelectItem key={d.id} value={d.id}>
                {d.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="relative">
          <Search size={14} strokeWidth={1.75} className="-translate-y-1/2 absolute top-1/2 left-2 text-muted-foreground" aria-hidden />
          <Input value={typeInput} onChange={(e) => setTypeInput(e.target.value)} placeholder="type, vd payment.*" className="h-8 w-48 pl-7 font-mono text-xs" />
        </div>
        {(source || destination || type || status !== "all") && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setStatus("all");
              setSource("");
              setDestination("");
              setTypeInput("");
            }}
          >
            <X {...ICON} />
            Bỏ lọc
          </Button>
        )}
        <span className="ml-auto text-muted-foreground text-xs">{paused ? "Đã tạm dừng — dữ liệu đứng yên" : "Trực tiếp"}</span>
      </div>

      <div className="flow-surface overflow-hidden rounded-2xl">
        <div className="grid grid-cols-[7rem_8rem_minmax(10rem,1fr)_auto_7.5rem_minmax(12rem,1.2fr)_2rem] items-center gap-3 border-b bg-muted/40 px-4 py-2 font-medium text-muted-foreground text-xs">
          <span>Thời gian</span>
          <span>Provider</span>
          <span>Type · subject</span>
          <span>Đường ống</span>
          <span>Trạng thái</span>
          <span>Hỏng ở</span>
          <span />
        </div>
        {q.isLoading && (
          <div className="space-y-2 p-4">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-8 w-full" />
            ))}
          </div>
        )}
        {q.error && <p className="p-4 text-destructive text-sm">Không tải được: {q.error.message}</p>}
        {!q.isLoading && items.length === 0 && <p className="p-6 text-center text-muted-foreground text-sm">Không có hành trình nào khớp bộ lọc.</p>}
        {items.map((i) => (
          // biome-ignore lint/a11y/useSemanticElements: hàng bảng bấm được
          <div
            key={i.id}
            role="button"
            tabIndex={0}
            onClick={() => router.push(`/dashboard/events/${encodeURIComponent(i.id)}`)}
            onKeyDown={(e) => e.key === "Enter" && router.push(`/dashboard/events/${encodeURIComponent(i.id)}`)}
            className="grid cursor-pointer grid-cols-[7rem_8rem_minmax(10rem,1fr)_auto_7.5rem_minmax(12rem,1.2fr)_2rem] items-center gap-3 border-b border-l-2 px-4 py-2 text-sm last:border-b-0 hover:bg-muted/40"
            style={{ borderLeftColor: TONE_VAR[EXECUTION_TONE[i.status]], contentVisibility: "auto", containIntrinsicSize: "auto 44px" }}
          >
            <span className="text-xs tabular-nums" title={formatRelative(i.receivedAt)}>
              {clock(i.receivedAt)}
            </span>
            <span className="inline-flex min-w-0 items-center gap-1.5">
              <span className="text-muted-foreground">
                <ProviderIcon provider={i.provider} size={14} />
              </span>
              <span className="truncate">{i.providerLabel}</span>
            </span>
            <span className="min-w-0">
              <span className="block truncate font-mono text-xs">{i.type ?? "—"}</span>
              {i.subject && <span className="block truncate text-muted-foreground text-xs">{i.subject}</span>}
            </span>
            <MiniPipeline summary={i.summary} />
            <ExecutionStatusPill status={i.status} />
            <FailedAt failedAt={i.failedAt} status={i.status} />
            <span>
              {i.eventId && (
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Xem nhanh (Dấu vết)"
                  title="Xem nhanh (Dấu vết)"
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
        ))}
        <div ref={sentinel} className="h-6" />
        {q.isFetchingNextPage && <p className="pb-3 text-center text-muted-foreground text-xs">Đang tải thêm…</p>}
        {!q.hasNextPage && items.length > 0 && <p className="pb-3 text-center text-muted-foreground text-xs">Hết.</p>}
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
