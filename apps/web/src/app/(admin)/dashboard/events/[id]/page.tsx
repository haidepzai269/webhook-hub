"use client";

import { useCallback, useEffect, useState } from "react";

import type { FlowBranch, StageAction, StageView } from "@hub/flow";
import { ArrowLeft, CalendarClock, ChevronDown, RotateCcw, Tag, WandSparkles } from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { toast } from "sonner";

import { CopyButton } from "@/components/admin/copy-button";
import { AttemptsCard, FlowCard, HeadersCard, PayloadCard, Waterfall } from "@/components/flow/detail-cards";
import { ExecutionStatusPill } from "@/components/flow/execution-bits";
import { JourneyCanvas, journeyHeight } from "@/components/flow/journey-canvas";
import { TonePill } from "@/components/flow/pills";
import { ProviderIcon } from "@/components/flow/provider-icon";
import { StageSheet } from "@/components/flow/stage-sheet";
import { ICON, ICON_SM } from "@/components/flow/tokens";
import { fullDate } from "@/components/flow/time";
import { PLAYGROUND_PREFILL_KEY } from "@/components/flow/prefill";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { HubApiError } from "@/lib/hub/client";
import { restoreFlowProject, useEventFlow, useFlowRenormalize, useFlowReplayDelivery } from "@/lib/hub/queries";
import { useRealtimeProject } from "@/lib/hub/socket";
import { useFlowProjectStore } from "@/lib/hub/flow-project";



function InfoCard({ icon, label, children }: { icon: React.ReactNode; label: string; children: React.ReactNode }) {
  return (
    <div className="flow-surface min-w-0 rounded-2xl px-4 py-3">
      <div className="flex items-center gap-1.5 text-muted-foreground text-xs">
        {icon}
        {label}
      </div>
      <div className="mt-1.5 min-w-0">{children}</div>
    </div>
  );
}

/**
 * V1 — Hành trình một event (SPEC-event-flow-ui §4, §0A.B). Mọi trạng thái do `GET /flow/events/:id`
 * (buildEventFlow ở server) quyết định; socket chỉ làm query cũ đi (invalidate prefix "flow", debounce).
 */
export default function EventJourneyPage() {
  const { id } = useParams<{ id: string }>();
  // F7: project đang xem (chọn ở V2/V3, nhớ trong localStorage) → `?projectId=` cho mọi gọi của trang.
  useEffect(() => restoreFlowProject(), []);
  const router = useRouter();
  const { data, isLoading, error } = useEventFlow(id ? decodeURIComponent(id) : null);
  useRealtimeProject(useFlowProjectStore((st) => st.projectId)); // R-5: socket theo project đang xem
  const [selected, setSelected] = useState<{ stage: StageView; branch?: FlowBranch } | null>(null);
  const replay = useFlowReplayDelivery();
  const renormalize = useFlowRenormalize();
  const [replaying, setReplaying] = useState<string | null>(null);

  const doReplay = useCallback(
    async (b: FlowBranch) => {
      setReplaying(b.deliveryId);
      try {
        const r = await replay.mutateAsync({ id: b.deliveryId, reason: "Replay từ Hành trình sự kiện (V1)" });
        toast.success(`Đã replay → ${b.destination.name} (generation ${r.generation ?? "mới"})`);
      } catch (e) {
        toast.error(e instanceof HubApiError ? e.message : "Replay thất bại");
      } finally {
        setReplaying(null);
      }
    },
    [replay],
  );

  const onAction = useCallback(
    (action: StageAction, _stage: StageView, branch?: FlowBranch) => {
      if (action === "replay_delivery" && branch) void doReplay(branch);
      else if (action === "renormalize" && data?.raw) {
        renormalize.mutate(
          { reason: "Renormalize từ Hành trình sự kiện (V1)", ids: [data.raw.id] },
          {
            onSuccess: (r) => toast.success(r.queued ? "Đã xếp lại vào q.normalize" : "Raw event không còn mồ côi"),
            onError: (e) => toast.error(e.message),
          },
        );
      } else if (action === "open_dlq") router.push("/dashboard/dlq");
      else if (action === "open_config") router.push(_stage.key === "verified" ? "/dashboard/sources" : "/dashboard/subscriptions");
    },
    [doReplay, renormalize, data, router],
  );

  const onSelect = useCallback((stage: StageView, branch?: FlowBranch) => setSelected({ stage, branch }), []);

  if (isLoading) return <Skeleton className="h-[70vh] w-full rounded-2xl" />;
  if (error) return <p className="text-destructive text-sm">Không tải được: {error.message}</p>;
  if (!data)
    return (
      <div className="space-y-3">
        <Link href="/dashboard/events" className="inline-flex items-center gap-1 text-muted-foreground text-sm hover:text-foreground">
          <ArrowLeft {...ICON} /> Quay lại
        </Link>
        <p className="text-muted-foreground text-sm">Không tìm thấy hành trình trong project đang chọn (có thể thuộc project khác — đổi project ở Bản đồ luồng / Hành trình sự kiện).</p>
      </div>
    );

  const { event, raw, stages, branches } = data;
  const receivedStage = stages.find((s) => s.key === "received");
  const normStage = stages.find((s) => s.key === "normalized");
  const replayable = branches.filter((b) => b.stages[b.stages.length - 1].actions?.includes("replay_delivery"));
  const displayId = event?.id ?? raw?.id ?? data.id;
  const selectedId = selected?.stage.id ?? null;

  const createFrom = () => {
    try {
      sessionStorage.setItem(
        PLAYGROUND_PREFILL_KEY,
        JSON.stringify({ sourceId: raw?.sourceId ?? null, body: receivedStage?.detail?.body ?? null }),
      );
    } catch {}
    router.push("/dashboard/playground?from=event");
  };

  return (
    <div className="space-y-4">
      {/* 1. Dòng trên cùng */}
      <div className="space-y-2">
        <Link href="/dashboard/events" className="inline-flex items-center gap-1 text-muted-foreground text-sm hover:text-foreground">
          <ArrowLeft {...ICON} /> Quay lại Hành trình sự kiện
        </Link>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="font-semibold text-xl tracking-tight">Chi tiết sự kiện</h1>
              <ExecutionStatusPill status={data.executionStatus} />
            </div>
            <div className="mt-0.5 flex items-center gap-1 font-mono text-muted-foreground text-xs">
              <span className="truncate">{displayId}</span>
              <CopyButton value={displayId} label="Sao chép id" />
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={createFrom} disabled={!raw}>
              <WandSparkles {...ICON} />
              Tạo từ event này
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button type="button" className="flow-replay-btn inline-flex h-8 items-center gap-1.5 rounded-lg px-3 font-medium text-sm">
                  <RotateCcw {...ICON} />
                  Replay
                  <ChevronDown {...ICON} />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-72">
                <DropdownMenuLabel>Replay delivery DEAD (generation + 1)</DropdownMenuLabel>
                <DropdownMenuItem
                  disabled={replayable.length === 0}
                  onSelect={() => replayable.forEach((b) => void doReplay(b))}
                >
                  Replay tất cả đích hỏng ({replayable.length})
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                {branches.map((b) => {
                  const ok = replayable.includes(b);
                  return (
                    <DropdownMenuItem key={b.deliveryId} disabled={!ok} onSelect={() => void doReplay(b)}>
                      <span className="truncate">→ {b.destination.name}</span>
                      <span className="ml-auto text-muted-foreground text-xs">{ok ? "DEAD" : b.stages[b.stages.length - 1].title}</span>
                    </DropdownMenuItem>
                  );
                })}
                {branches.length === 0 && <DropdownMenuItem disabled>Không có delivery</DropdownMenuItem>}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </div>

      {/* 2. Ba thẻ thông tin */}
      <div className="grid gap-3 md:grid-cols-3">
        <InfoCard icon={<Tag {...ICON_SM} />} label="Event Type">
          <div className="flex flex-wrap items-center gap-1.5">
            <TonePill tone="idle" className="font-mono">
              {event?.type ?? "— (chưa có event)"}
            </TonePill>
            {event && (
              <TonePill tone={event.normalized ? "healthy" : "warning"}>{event.normalized ? "chuẩn" : "thô"}</TonePill>
            )}
          </div>
          {event?.subject && <div className="mt-1 truncate font-mono text-muted-foreground text-xs">{event.subject}</div>}
        </InfoCard>
        <InfoCard icon={raw ? <ProviderIcon provider={raw.provider} size={13} /> : <Tag {...ICON_SM} />} label="Source">
          <div className="truncate font-medium text-sm">{raw ? `${raw.providerLabel} · ${raw.sourceName}` : (event?.source ?? "—")}</div>
          <div className="mt-0.5 truncate font-mono text-muted-foreground text-xs" title="Hub không lưu IP người gửi">
            IP: không lưu · corr {event?.correlationId?.slice(0, 8) ?? "—"}
          </div>
        </InfoCard>
        <InfoCard icon={<CalendarClock {...ICON_SM} />} label="Received">
          <div className="font-medium text-sm tabular-nums">{fullDate(raw?.receivedAt ?? event?.receivedAt)}</div>
          <div className="mt-0.5 text-muted-foreground text-xs">
            {raw ? `raw ${raw.status}` : "không có raw event"} · origin {event?.origin ?? "webhook"}
          </div>
        </InfoCard>
      </div>

      {/* 3. Dải hành trình */}
      <FlowCard
        title="Hành trình"
        right={<span className="text-muted-foreground text-xs">Bấm một node để xem Vào / Ra / Chi tiết</span>}
      >
        <div className="flow-canvas overflow-hidden rounded-xl border" style={{ height: journeyHeight(branches.length) + 30, borderColor: "var(--flow-card-border)" }}>
          <JourneyCanvas
            stages={stages}
            branches={branches}
            provider={raw?.provider}
            selectedId={selectedId}
            onSelect={onSelect}
            onAction={onAction}
          />
        </div>
        <div className="mt-3">
          <Waterfall stages={stages} branches={branches} />
        </div>
      </FlowCard>

      {/* 4. Payload + Headers */}
      <div className="grid gap-4 lg:grid-cols-2">
        <PayloadCard
          data={normStage?.detail?.data}
          dataTruncated={Boolean(normStage?.detail?.dataTruncated)}
          raw={receivedStage?.detail?.body}
          rawTruncated={Boolean(receivedStage?.detail?.bodyTruncated)}
        />
        <HeadersCard headers={receivedStage?.detail?.headers as Record<string, unknown> | null} />
      </div>

      {/* 5. Delivery Attempts */}
      <AttemptsCard branches={branches} onReplay={(b) => void doReplay(b)} replaying={replaying} />

      <StageSheet stage={selected?.stage ?? null} branch={selected?.branch} onClose={() => setSelected(null)} />
    </div>
  );
}
