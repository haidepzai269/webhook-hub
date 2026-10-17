"use client";

import "@xyflow/react/dist/style.css";
import "./flow.css";

import { memo, useMemo } from "react";

import {
  BaseEdge,
  type Edge,
  EdgeLabelRenderer,
  type EdgeProps,
  getBezierPath,
  getSmoothStepPath,
  Handle,
  MarkerType,
  type Node,
  type NodeProps,
  Position,
  ReactFlow,
} from "@xyflow/react";
import type { FlowBranch, StageAction, StageView } from "@hub/flow";
import { Settings2, RotateCcw, Skull } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { MessageKey } from "@/lib/i18n/dictionary";
import { useT } from "@/lib/i18n/use-t";

import { ProviderIcon } from "./provider-icon";
import { destinationIcon, ICON, ICON_SM, STATUS_TONE, StatusGlyph, stageIcon, stageLabelKey, TONE_VAR, toneStyle } from "./tokens";
import { clock, countdown, fmtMs, useNow } from "./time";

const W = 196;
const H = 112;
const GAP = 38;
const DW = 380; // node delivery (gồm chip các lần thử)
const DONE_W = 300;
const ROW_Y0 = 190; // nhánh bắt đầu dưới hàng chặng chính
const ROW = 158;

export type OnStageAction = (action: StageAction, stage: StageView, branch?: FlowBranch) => void;

interface StageData {
  stage: StageView;
  provider?: string;
  selected: boolean;
  onSelect: (s: StageView, b?: FlowBranch) => void;
  onAction: OnStageAction;
  branch?: FlowBranch;
  [k: string]: unknown;
}
interface DeliveryData {
  branch: FlowBranch;
  selectedId: string | null;
  onSelect: (s: StageView, b?: FlowBranch) => void;
  [k: string]: unknown;
}

const ACTION_LABEL: Record<StageAction, MessageKey> = {
  replay_delivery: "journey.action.replay-delivery",
  renormalize: "journey.action.renormalize",
  open_dlq: "journey.action.open-dlq",
  open_config: "journey.action.open-config",
};
const ACTION_ICON = { replay_delivery: RotateCcw, renormalize: RotateCcw, open_dlq: Skull, open_config: Settings2 } as const;

function NodeShell({ tone, selected, width, children, onClick }: { tone: string; selected: boolean; width: number; children: React.ReactNode; onClick: () => void }) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: node canvas, có role + bàn phím
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && onClick()}
      className={`flow-card relative cursor-pointer rounded-2xl px-3 py-2.5 ${selected ? "is-selected" : ""}`}
      data-tone={tone}
      style={{ ...toneStyle(tone as never), width, minHeight: H }}
    >
      <Handle id="l" type="target" position={Position.Left} />
      <Handle id="r" type="source" position={Position.Right} />
      <Handle id="t" type="target" position={Position.Top} />
      <Handle id="b" type="source" position={Position.Bottom} />
      {children}
    </div>
  );
}

/** Node một chặng: icon chặng, nhãn chặng, tiêu đề do server viết, icon + chữ trạng thái, lý do, nút hành động. */
const StageCard = memo(function StageCard({ data }: NodeProps<Node<StageData>>) {
  const { stage, provider, selected, onSelect, onAction, branch } = data;
  const t = useT();
  const now = useNow(1000);
  const tone = STATUS_TONE[stage.status];
  const Icon = stageIcon(stage.key, stage.status);
  const nextAt = typeof stage.detail?.nextAttemptAt === "string" ? (stage.detail.nextAttemptAt as string) : null;
  const tier = typeof stage.detail?.tier === "string" ? (stage.detail.tier as string) : null;
  const due = t("journey.due");
  const cd = countdown(nextAt, now, due);
  const showTime = stage.key === "persisted" || stage.key === "received" || stage.key === "done";
  const destType = branch?.destination.type;
  return (
    <NodeShell tone={tone} selected={selected} width={stage.key === "done" ? DONE_W : W} onClick={() => onSelect(stage, branch)}>
      <div className="flex items-center gap-2">
        <div className="flow-icon-box grid size-7 shrink-0 place-items-center rounded-lg" style={toneStyle(tone)}>
          {stage.key === "received" && provider ? (
            <ProviderIcon provider={provider} />
          ) : stage.key === "done" && destType ? (
            (() => {
              const D = destinationIcon(destType);
              return <D {...ICON} />;
            })()
          ) : (
            <Icon {...ICON} />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1 font-medium text-[11px] uppercase tracking-wide" style={{ color: TONE_VAR[tone] }}>
            <StatusGlyph status={stage.status} small />
            {t(stageLabelKey(stage.key))}
          </div>
        </div>
      </div>
      <div className="mt-1.5 font-semibold text-[13px] leading-[1.3]" title={stage.title}>
        {stage.title}
      </div>
      {stage.subtitle && (
        <div className="mt-0.5 line-clamp-2 break-words text-[11.5px] leading-4" style={{ color: "var(--flow-text-dim)" }} title={stage.subtitle}>
          {stage.subtitle}
        </div>
      )}
      {showTime && stage.endedAt && (
        <div className="mt-0.5 font-mono text-[11.5px] tabular-nums" style={{ color: "var(--flow-text-dim)" }}>
          {t("journey.at", { time: clock(stage.endedAt) })}
        </div>
      )}
      {nextAt && (
        <div className="mt-1.5 flex flex-wrap items-baseline gap-x-2 text-[12px] tabular-nums" style={{ color: TONE_VAR[tone] }}>
          <span className="font-semibold text-[14px]">{cd === due ? due : t("journey.remaining", { time: cd ?? "" })}</span>
          <span>
            {tier ? `${t("journey.tier", { tier })} · ` : ""}
            {t("journey.at", { time: clock(nextAt, false) })}
          </span>
        </div>
      )}
      {stage.reason && stage.status !== "ok" && (
        <div className="mt-1 text-[11.5px] leading-4" style={{ color: TONE_VAR[tone] }} title={stage.reason.message}>
          {stage.reason.message}
        </div>
      )}
      {stage.actions && stage.actions.length > 0 && (
        <div className="nodrag mt-1.5 flex flex-wrap gap-1">
          {stage.actions.map((a) => {
            const AI = ACTION_ICON[a];
            const primary = a === "replay_delivery" || a === "renormalize";
            return (
              primary ? (
                <Button
                  key={a}
                  type="button"
                  variant="replay"
                  size="xs"
                  onClick={(e) => {
                    e.stopPropagation();
                    onAction(a, stage, branch);
                  }}
                >
                  <AI {...ICON_SM} aria-hidden />
                  {t(ACTION_LABEL[a])}
                </Button>
              ) : (
                <button
                  key={a}
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onAction(a, stage, branch);
                  }}
                  className="flow-pill inline-flex h-6 cursor-pointer items-center gap-1 rounded-md px-2 font-medium text-[11px]"
                  style={toneStyle("idle")}
                >
                  <AI {...ICON_SM} aria-hidden />
                  {t(ACTION_LABEL[a])}
                </button>
              )
            );
          })}
        </div>
      )}
    </NodeShell>
  );
});

/** Node một delivery: đích + chip từng lần thử (Lần 1 → Lần 2 → …), bấm chip mở panel attempt. */
const DeliveryCard = memo(function DeliveryCard({ data }: NodeProps<Node<DeliveryData>>) {
  const { branch, selectedId, onSelect } = data;
  const t = useT();
  const queued = branch.stages[0];
  const attempts = branch.stages.filter((s) => s.id.includes(":attempt:"));
  const tone = attempts.length ? STATUS_TONE[attempts[attempts.length - 1].status] : STATUS_TONE[queued.status];
  const D = destinationIcon(branch.destination.type);
  const circuit = String(queued.detail?.circuitState ?? "CLOSED");
  return (
    <NodeShell tone={tone} selected={selectedId === queued.id} width={DW} onClick={() => onSelect(queued, branch)}>
      <div className="flex items-center gap-2">
        <div className="flow-icon-box grid size-7 shrink-0 place-items-center rounded-lg" style={toneStyle(tone)}>
          <D {...ICON} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="font-semibold text-[13.5px] leading-tight">{branch.destination.name}</div>
          <div className="text-[11.5px] leading-4" style={{ color: "var(--flow-text-dim)" }}>
            {branch.subscription.name} · {t("journey.generation", { n: branch.generation })}
            {circuit !== "CLOSED" ? ` · ${t("journey.circuit", { state: circuit })}` : ""}
          </div>
        </div>
      </div>
      <div className="nodrag mt-2 flex flex-wrap items-center gap-1">
        {attempts.length === 0 && (
          <span className="text-[11px]" style={{ color: "var(--flow-text-dim)" }}>
            {t("journey.no-attempts")}
          </span>
        )}
        {attempts.map((a, i) => {
          const aTone = STATUS_TONE[a.status];
          const http = a.detail?.httpStatus as number | null | undefined;
          return (
            <span key={a.id} className="inline-flex items-center gap-1">
              {i > 0 && <span className="h-px w-1.5" style={{ background: "var(--flow-card-border)" }} />}
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onSelect(a, branch);
                }}
                className={`flow-pill inline-flex h-7 items-center gap-1 rounded-md px-2 text-[12px] tabular-nums ${selectedId === a.id ? "ring-1 ring-current" : ""}`}
                style={toneStyle(aTone)}
                title={`${a.title} · ${a.subtitle ?? ""}`}
              >
                <StatusGlyph status={a.status} small />
                {a.status === "in_progress" ? `#${i + 1}` : `#${String(a.detail?.attemptNo ?? i + 1)} ${http ?? "—"}`}
                {a.durationMs !== null && <span className="opacity-70">{fmtMs(a.durationMs)}</span>}
              </button>
            </span>
          );
        })}
      </div>
    </NodeShell>
  );
});

type EdgeData = { label: string | null; tone: string; animated: boolean; step?: boolean };
const JourneyEdge = memo(function JourneyEdge(props: EdgeProps<Edge<EdgeData>>) {
  const { sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, markerEnd } = props;
  const [path, lx, ly] = data?.step
    ? getSmoothStepPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, borderRadius: 14, offset: 22 })
    : getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, curvature: 0.3 });
  const color = TONE_VAR[(data?.tone ?? "idle") as keyof typeof TONE_VAR];
  return (
    <>
      <BaseEdge path={path} markerEnd={markerEnd} style={{ stroke: color, strokeWidth: 2, opacity: 0.9 }} />
      {data?.animated && <path d={path} fill="none" stroke={color} strokeWidth={2} className="flow-edge-animated" />}
      {data?.label && (
        <EdgeLabelRenderer>
          <div
            className="flow-edge-label nodrag nopan pointer-events-none absolute rounded-md px-2 py-0.5 font-mono font-semibold text-[12px] tabular-nums"
            style={{ ...toneStyle((data.tone ?? "idle") as never), transform: `translate(-50%, -50%) translate(${lx}px, ${ly}px)` }}
          >
            {data.label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
});

const nodeTypes = { stage: StageCard, delivery: DeliveryCard };
const edgeTypes = { journey: JourneyEdge };

function delta(prev: StageView | undefined, cur: StageView): string | null {
  if (cur.offsetMs === null) return null;
  const base = prev?.offsetMs ?? 0;
  const d = Math.max(0, cur.offsetMs - base);
  return `+${fmtMs(d)}`;
}

export function journeyHeight(branchCount: number): number {
  return ROW_Y0 + Math.max(0, branchCount) * ROW + 30;
}

/**
 * Dải hành trình V1: Nhận → Xác thực → COMMIT → Normalize → Định tuyến → toả nhánh mỗi đích
 * (Delivery [lần 1 → lần 2 …] → Kết thúc). Bố cục cố định trái → phải (không kéo thả), nhãn `+ms` trên cạnh.
 */
export function JourneyCanvas({
  stages,
  branches,
  provider,
  selectedId,
  onSelect,
  onAction,
}: {
  stages: StageView[];
  branches: FlowBranch[];
  provider?: string;
  selectedId: string | null;
  onSelect: (s: StageView, b?: FlowBranch) => void;
  onAction: OnStageAction;
}) {
  const { nodes, edges } = useMemo(() => {
    const nodes: Node[] = [];
    const edges: Edge<EdgeData>[] = [];
    // Hàng chặng chính ở trên; mỗi delivery một hàng bên dưới, căn phải theo node Định tuyến ("toả nhánh").
    stages.forEach((s, i) => {
      nodes.push({
        id: s.id,
        type: "stage",
        position: { x: i * (W + GAP), y: 0 },
        data: { stage: s, provider, selected: selectedId === s.id, onSelect, onAction },
        draggable: false,
      });
      if (i > 0) {
        const tone = STATUS_TONE[s.status];
        edges.push({
          id: `j:${stages[i - 1].id}->${s.id}`,
          source: stages[i - 1].id,
          target: s.id,
          sourceHandle: "r",
          targetHandle: "l",
          type: "journey",
          markerEnd: { type: MarkerType.ArrowClosed, color: TONE_VAR[tone], width: 14, height: 14 },
          data: { label: delta(stages[i - 1], s), tone, animated: s.status === "in_progress" },
        });
      }
    });
    const routed = stages[stages.length - 1];
    const rightEdge = Math.max(stages.length, 1) * (W + GAP) - GAP;
    const bx = Math.max(0, rightEdge - (DW + GAP + DONE_W));
    branches.forEach((b, r) => {
      const queued = b.stages[0];
      const attempts = b.stages.filter((s) => s.id.includes(":attempt:"));
      const done = b.stages[b.stages.length - 1];
      const dId = `${b.deliveryId}:delivery`;
      const lastAtt = attempts[attempts.length - 1];
      const dTone = lastAtt ? STATUS_TONE[lastAtt.status] : STATUS_TONE[queued.status];
      const y = ROW_Y0 + r * ROW;
      nodes.push({ id: dId, type: "delivery", position: { x: bx, y }, data: { branch: b, selectedId, onSelect }, draggable: false });
      nodes.push({
        id: done.id,
        type: "stage",
        position: { x: bx + DW + GAP, y },
        data: { stage: done, selected: selectedId === done.id, onSelect, onAction, branch: b },
        draggable: false,
      });
      if (routed) {
        const first = attempts[0];
        edges.push({
          id: `j:${routed.id}->${dId}`,
          source: routed.id,
          target: dId,
          sourceHandle: "b",
          targetHandle: "l",
          type: "journey",
          markerEnd: { type: MarkerType.ArrowClosed, color: TONE_VAR[dTone], width: 14, height: 14 },
          // Thời gian từ định tuyến tới lúc bắt đầu lần gửi đầu (relay outbox + hàng đợi).
          data: {
            label: first
              ? delta(routed, { ...first, offsetMs: first.offsetMs !== null && first.durationMs !== null ? first.offsetMs - first.durationMs : first.offsetMs })
              : null,
            tone: dTone,
            animated: false,
            step: true,
          },
        });
      }
      const doneTone = STATUS_TONE[done.status];
      edges.push({
        id: `j:${dId}->${done.id}`,
        source: dId,
        target: done.id,
        sourceHandle: "r",
        targetHandle: "l",
        type: "journey",
        markerEnd: { type: MarkerType.ArrowClosed, color: TONE_VAR[doneTone], width: 14, height: 14 },
        data: {
          label: lastAtt?.durationMs !== null && lastAtt?.durationMs !== undefined ? fmtMs(lastAtt.durationMs) : null,
          tone: doneTone,
          animated: done.status === "in_progress" || done.status === "warning",
        },
      });
    });
    return { nodes, edges };
  }, [stages, branches, provider, selectedId, onSelect, onAction]);

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      fitView
      fitViewOptions={{ padding: 0.05, maxZoom: 1, minZoom: 0.6 }}
      minZoom={0.4}
      maxZoom={1.5}
      nodesConnectable={false}
      nodesDraggable={false}
      elementsSelectable={false}
      proOptions={{ hideAttribution: true }}
      zoomOnScroll={false}
      preventScrolling={false}
    />
  );
}
