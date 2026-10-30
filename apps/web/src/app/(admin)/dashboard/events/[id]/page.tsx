"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { FlowBranch, StageAction, StageView } from "@hub/flow";
import { ArrowLeft, CalendarClock, ChevronDown, RotateCcw, Tag, WandSparkles } from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { toast } from "sonner";

import { PageHeader } from "@/components/admin/page-header";
import { CopyButton } from "@/components/admin/copy-button";
import { ErrorState } from "@/components/admin/state";
import { AttemptsCard, FlowCard, HeadersCard, PayloadCard, Waterfall } from "@/components/flow/detail-cards";
import { ExecutionStatusPill } from "@/components/flow/execution-bits";
import { expectedProbe, noDestination } from "@/components/flow/event-notes";
import { JourneyView } from "@/components/flow/journey-view";
import { TonePill } from "@/components/flow/pills";
import { ProviderIcon } from "@/components/flow/provider-icon";
import { StageSheet } from "@/components/flow/stage-sheet";
import { UnverifiedBadge } from "@/components/flow/unverified-badge";
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
import { DetailSkeleton } from "@/components/admin/skeletons";
import { formatDateTime, shortId } from "@/lib/hub/format";
import { HubApiError } from "@/lib/hub/client";
import { restoreFlowProject, useEventFlow, useFlowRenormalize, useFlowReplayDelivery } from "@/lib/hub/queries";
import { useRealtimeProject } from "@/lib/hub/socket";
import { useFlowProjectStore } from "@/lib/hub/flow-project";
import { journeyUnverified } from "@/lib/hub/unverified";
import { errorTextOf } from "@/lib/hub/ui-logic";
import { useLocale, useT } from "@/lib/i18n/use-t";



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
  const t = useT();
  const locale = useLocale();
  // F7: project đang xem (chọn ở V2/V3, nhớ trong localStorage) → `?projectId=` cho mọi gọi của trang.
  useEffect(() => restoreFlowProject(), []);
  const router = useRouter();
  const { data, isLoading, error, refetch } = useEventFlow(id ? decodeURIComponent(id) : null);
  useRealtimeProject(useFlowProjectStore((st) => st.projectId)); // R-5: socket theo project đang xem
  const [selected, setSelected] = useState<{ stage: StageView; branch?: FlowBranch } | null>(null);
  const replay = useFlowReplayDelivery();
  const renormalize = useFlowRenormalize();
  const [replaying, setReplaying] = useState<string | null>(null);
  // Khoá ĐỒNG BỘ: hai click liên tiếp chạy trước khi state `replaying` kịp cập nhật → không được sinh hai generation.
  const replayLock = useRef(false);

  const doReplay = useCallback(
    async (b: FlowBranch) => {
      if (replayLock.current) return;
      replayLock.current = true;
      setReplaying(b.deliveryId);
      try {
        const r = await replay.mutateAsync({ id: b.deliveryId, reason: t("page.events.detail.replay-reason") });
        toast.success(
          t("page.events.detail.replayed", {
            destination: b.destination.name,
            generation: r.generation ?? t("page.events.detail.generation-new"),
          }),
        );
      } catch (e) {
        toast.error(e instanceof HubApiError ? e.message : t("page.events.detail.replay-failed"));
      } finally {
        replayLock.current = false;
        setReplaying(null);
      }
    },
    [replay, t],
  );

  const onAction = useCallback(
    (action: StageAction, _stage: StageView, branch?: FlowBranch) => {
      if (action === "replay_delivery" && branch) void doReplay(branch);
      else if (action === "renormalize" && data?.raw) {
        renormalize.mutate(
          { reason: t("page.events.detail.renormalize-reason"), ids: [data.raw.id] },
          {
            onSuccess: (r) =>
              toast.success(r.queued ? t("page.events.detail.requeued") : t("page.events.detail.not-orphan")),
            onError: (e) => toast.error(errorTextOf(e, t)),
          },
        );
      } else if (action === "open_dlq") router.push("/dashboard/dlq");
      else if (action === "open_config") router.push(_stage.key === "verified" ? "/dashboard/sources" : "/dashboard/subscriptions");
    },
    [doReplay, renormalize, data, router, t],
  );

  const onSelect = useCallback((stage: StageView, branch?: FlowBranch) => setSelected({ stage, branch }), []);

  if (isLoading) return <DetailSkeleton rows={6} />;
  if (error) return <ErrorState message={t("page.events.load-error", { message: error.message })} onRetry={() => void refetch()} />;
  if (!data)
    return (
      <div className="space-y-3">
        <Link href="/dashboard/events" className="inline-flex items-center gap-1 text-muted-foreground text-sm hover:text-foreground">
          <ArrowLeft {...ICON} /> {t("common.back")}
        </Link>
        <p className="text-muted-foreground text-sm">{t("page.events.detail.not-found")}</p>
      </div>
    );

  const { event, raw, stages, branches } = data;
  const receivedStage = stages.find((s) => s.key === "received");
  const normStage = stages.find((s) => s.key === "normalized");
  const replayable = branches.filter((b) => b.stages[b.stages.length - 1].actions?.includes("replay_delivery"));
  const displayId = event?.id ?? raw?.id ?? data.id;
  const selectedId = selected?.stage.id ?? null;
  // Cùng quy tắc với danh sách: ping/probe -> pill "Kiểm tra kết nối"; không subscription -> "Đã nhận · không có đích".
  const pillCtx = {
    type: event?.type ?? null,
    provider: raw?.provider ?? "",
    summary: data.summary,
    failedAt: data.failedAt,
    probe: stages.find((s) => s.key === "routed")?.reason?.code === "provider_probe",
  };

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
        <PageHeader
          className="mb-0"
          back={{ href: "/dashboard/events", label: t("page.events.detail.back") }}
          title={t("page.events.detail.title")}
          adornment={
            <>
              <ExecutionStatusPill status={data.executionStatus} probe={expectedProbe(pillCtx)} noDest={noDestination(pillCtx)} />
              {/* PK5 khoá 2 (REVIEW-PK5 TB-1): hub không kiểm chữ ký nguồn này — chặng "Xác thực" cũng là cảnh báo, không xanh. */}
              <UnverifiedBadge of={journeyUnverified(data) ? { verified: false } : null} />
            </>
          }
          meta={
            <span className="flex items-center gap-1 font-mono">
              <span className="truncate">{displayId}</span>
              <CopyButton value={displayId} label={t("page.events.detail.copy-id")} />
            </span>
          }
          actions={
            <>
            <Button variant="outline" size="sm" className="max-md:min-h-10" onClick={createFrom} disabled={!raw}>
              <WandSparkles {...ICON} />
              {t("page.events.detail.create-from")}
            </Button>
            {/* QT7 (§5.1, §9): event đã Dọn -> KHÔNG có nút Replay (server 409 event_trimmed). */}
            {!event?.trimmedAt && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="replay" className="max-md:min-h-10">
                  <RotateCcw {...ICON} />
                  {t("page.events.detail.replay")}
                  <ChevronDown {...ICON} />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-72">
                <DropdownMenuLabel>{t("page.events.detail.replay-menu")}</DropdownMenuLabel>
                <DropdownMenuItem
                  disabled={replayable.length === 0}
                  onSelect={() => replayable.forEach((b) => void doReplay(b))}
                >
                  {t("page.events.detail.replay-all", { count: replayable.length })}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                {branches.map((b) => {
                  const ok = replayable.includes(b);
                  return (
                    <DropdownMenuItem key={b.deliveryId} disabled={!ok} onSelect={() => void doReplay(b)}>
                      <span className="truncate">→ {b.destination.name}</span>
                      <span className="ml-auto text-muted-foreground text-xs">{ok ? t("page.events.detail.dead") : b.stages[b.stages.length - 1].title}</span>
                    </DropdownMenuItem>
                  );
                })}
                {branches.length === 0 && <DropdownMenuItem disabled>{t("page.events.detail.no-deliveries")}</DropdownMenuItem>}
              </DropdownMenuContent>
            </DropdownMenu>
            )}
            </>
          }
        />
        {event?.trimmedAt && (
          <p role="note" className="rounded-md border border-dashed px-3 py-2 text-muted-foreground text-sm">
            {t("page.storage.trimmed", { at: formatDateTime(event.trimmedAt, locale) })}
          </p>
        )}
      </div>

      {/* 2. Ba thẻ thông tin */}
      <div className="grid gap-3 md:grid-cols-3">
        <InfoCard icon={<Tag {...ICON_SM} />} label={t("page.events.detail.event-type")}>
          <div className="flex flex-wrap items-center gap-1.5">
            <TonePill tone="idle" className="font-mono">
              {event?.type ?? t("page.events.detail.no-event")}
            </TonePill>
            {event && (
              <TonePill tone={event.normalized ? "healthy" : "warning"}>{event.normalized ? t("page.events.detail.normalized") : t("page.events.detail.raw")}</TonePill>
            )}
          </div>
          {event?.subject && <div className="mt-1 truncate font-mono text-muted-foreground text-xs">{event.subject}</div>}
        </InfoCard>
        <InfoCard icon={raw ? <ProviderIcon provider={raw.provider} name={raw.sourceName} size={13} /> : <Tag {...ICON_SM} />} label={t("page.events.detail.source")}>
          <div className="truncate font-medium text-sm">{raw ? `${raw.providerLabel} · ${raw.sourceName}` : (event?.source ?? "—")}</div>
          <div className="mt-0.5 truncate font-mono text-muted-foreground text-xs" title={t("page.events.detail.no-ip")}>
            {t("page.events.detail.ip-line", { id: event?.correlationId ? shortId(event.correlationId) : "—" })}
          </div>
        </InfoCard>
        <InfoCard icon={<CalendarClock {...ICON_SM} />} label={t("page.events.detail.received")}>
          <div className="font-medium text-sm tabular-nums">{fullDate(raw?.receivedAt ?? event?.receivedAt, locale)}</div>
          <div className="mt-0.5 text-muted-foreground text-xs">
            {raw ? t("page.events.detail.raw-status", { status: raw.status }) : t("page.events.detail.no-raw")} ·{" "}
            {t("page.events.detail.origin", { origin: event?.origin ?? "webhook" })}
          </div>
        </InfoCard>
      </div>

      {/* 3. Dải hành trình */}
      <FlowCard
        title={t("page.events.detail.journey")}
        right={<span className="text-muted-foreground text-xs">{t("page.events.detail.journey-hint")}</span>}
      >
        <JourneyView
          stages={stages}
          branches={branches}
          provider={raw?.provider}
          selectedId={selectedId}
          onSelect={onSelect}
          onAction={onAction}
          replaying={replaying}
          ctx={pillCtx}
        />
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
