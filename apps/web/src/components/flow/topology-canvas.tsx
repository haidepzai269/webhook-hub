"use client";

import "@xyflow/react/dist/style.css";
import "./flow.css";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  BaseEdge,
  type Edge,
  EdgeLabelRenderer,
  type EdgeProps,
  getBezierPath,
  Handle,
  MarkerType,
  type Node,
  type NodeProps,
  Position,
  ReactFlow,
  useEdgesState,
  useNodesState,
} from "@xyflow/react";
import type { DestinationFlowNode, FlowEdge, FlowNode, FlowTopology, Health, SourceFlowNode, SubscriptionFlowNode, TopologyWindow } from "@hub/flow";
import { CircleAlert, CircleCheck, CircleX, Gauge, LoaderCircle, Ellipsis, PowerOff, ShieldAlert, Unplug, Zap, ZapOff } from "lucide-react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogBody,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { type FlowItemKind, useFlowArchive, useFlowSetActive } from "@/lib/hub/flow-queries";
import { subscribeHubSocket } from "@/lib/hub/socket";
import type { MessageKey, TranslateFn } from "@/lib/i18n/dictionary";
import { useT } from "@/lib/i18n/use-t";

import { layoutLR } from "./layout";
import {
  emptyLive,
  liveApplyBatch,
  type LiveOp,
  type LiveResult,
  type LiveState,
  type LiveView,
  livePrune,
  liveView,
  reuseStable,
  sameShallow,
} from "./live-activity";
import { ProviderIcon } from "./provider-icon";
import { destinationIcon, HEALTH_TONE, HealthGlyph, ICON, ICON_SM, KIND_ICON, type Tone, TONE_VAR, toneStyle } from "./tokens";
import { disconnectedNote, groupActive, isDisconnected } from "./disconnected";
import { unusedDestinationIds } from "./unused-destinations";

const NODE_W = 236;
const NODE_H = 108;
const POS_KEY = "flow:v3:positions";
const MAX_PULSES_PER_SEC = 30;
/** Mảng rỗng dùng chung — `[]` mới mỗi lần sẽ phá giữ-nguyên-tham-chiếu của data cạnh (L-B2). */
const NO_PULSES: { id: number; tone: string }[] = [];
const PULSE_MS = 1400;

const WINDOW_SHORT: Record<TopologyWindow, string> = { "15m": "15m", "1h": "1h", "24h": "24h" };

type CardData = {
  node: FlowNode;
  window: TopologyWindow;
  onBadge: (href: string) => void;
  /** ADR-161: mở hộp "Ngắt / Xoá" cho node quản lý được (source, đích, subscription đơn). */
  onManage: (node: FlowNode) => void;
  live: LiveView;
  unused: boolean;
};

/** Node nào có nút thùng rác: source, đích, subscription ĐƠN (`sub:<uuid>` — không phải nhóm `subgroup:`). */
function manageableKind(node: FlowNode): FlowItemKind | null {
  if (node.kind === "source") return "source";
  if (node.kind === "destination") return "destination";
  if (node.kind === "subscription" && node.id.startsWith("sub:")) return "subscription";
  return null;
}

/** Id thật trong DB (bỏ tiền tố `src:` / `dst:` / `sub:` của node). */
function rawIdOf(node: FlowNode): string {
  return node.id.slice(4);
}


const KIND_NOUN: Record<FlowItemKind, MessageKey> = { source: "flow.kind.source", destination: "flow.kind.destination", subscription: "flow.kind.subscription" };
const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
type EdgeData = { edge: FlowEdge; window: TopologyWindow; pulses: { id: number; tone: string }[]; caption?: string; captionOff?: boolean; live: LiveView };

/** Tone của trạng thái sống trên chặng (live-activity). */
const LIVE_TONE: Record<LiveResult | "running", Tone> = { running: "progress", ok: "healthy", warn: "warning", fail: "crashed" };
const LIVE_BADGE: Record<LiveResult | "running", { label: MessageKey; Icon: typeof CircleCheck }> = {
  running: { label: "flow.live.running", Icon: LoaderCircle },
  ok: { label: "flow.live.ok", Icon: CircleCheck },
  warn: { label: "flow.live.warn", Icon: CircleAlert },
  fail: { label: "flow.live.fail", Icon: CircleX },
};

function fmtCount(n: number) {
  return n >= 10_000 ? `${(n / 1000).toFixed(0)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function NodeIcon({ node }: { node: FlowNode }) {
  if (node.kind === "source") return <ProviderIcon provider={(node as SourceFlowNode).provider} size={18} />;
  if (node.kind === "destination") {
    const I = destinationIcon((node as DestinationFlowNode).type);
    return <I size={18} strokeWidth={ICON.strokeWidth} />;
  }
  const I = KIND_ICON[node.kind];
  return I ? <I size={18} strokeWidth={ICON.strokeWidth} /> : null;
}

function subtitleOf(node: FlowNode, t: TranslateFn): string {
  switch (node.kind) {
    case "source":
      return (node as SourceFlowNode).provider.toUpperCase();
    case "gate":
      return t("flow.node.subtitle.gate");
    case "normalize":
      return "q.normalize → events";
    case "subscription": {
      const sub = node as SubscriptionFlowNode;
      const from = sub.sourceLabels?.length ? ` · ${t("flow.node.only-from", { list: sub.sourceLabels.join(", ") })}` : "";
      return sub.eventTypes.join(", ") + from;
    }
    case "destination":
      return (node as DestinationFlowNode).type;
  }
}

/** Thẻ node kiểu ảnh mẫu A: icon trong ô, tên, `● Healthy`; hàng dưới `● 99.1% | 105ms lat`. */
const TopologyCard = memo(function TopologyCard({ data, selected }: NodeProps<Node<CardData>>) {
  const { node, onBadge, onManage, live } = data;
  const t = useT();
  // ADR-161: mục đã "Ngắt" — mờ, badge "ĐÃ NGẮT" thay mọi badge khác (không còn là "không dùng" hay sự cố).
  const disconnected = isDisconnected(node);
  const unused = data.unused && !disconnected;
  const quiet = unused || disconnected;
  const manageKind = manageableKind(node);
  // Đích không dùng: xám, không glow đỏ. Đang có sự kiện trên node: tô theo trạng thái sống (n8n).
  const tone: Tone = quiet ? "idle" : live !== "idle" ? LIVE_TONE[live] : HEALTH_TONE[node.health];
  const healthTone: Tone = quiet ? "idle" : HEALTH_TONE[node.health];
  const dst = node.kind === "destination" ? (node as DestinationFlowNode) : null;
  const src = node.kind === "source" ? (node as SourceFlowNode) : null;
  const crashedBadge = quiet ? null : dst?.circuitState === "OPEN" ? t("flow.node.badge.circuit-open") : node.health === "crashed" ? t("flow.node.badge.crashed") : null;
  const liveBadge = !quiet && live !== "idle" ? LIVE_BADGE[live] : null;

  return (
    <div
      className={`flow-card relative rounded-2xl px-3 py-2.5 ${selected ? "is-selected" : ""}`}
      data-tone={tone}
      data-unused={unused || undefined}
      data-disconnected={disconnected || undefined}
      style={{ ...toneStyle(tone), width: NODE_W, minHeight: NODE_H }}
      title={
        disconnected
          ? manageKind
            ? t("flow.node.disconnected-title", { noun: t(KIND_NOUN[manageKind]) })
            : t("flow.node.group-disconnected-title")
          : unused
            ? t("flow.node.unused-title")
            : undefined
      }
    >
      <Handle type="target" position={Position.Left} />
      <Handle type="source" position={Position.Right} />
      {liveBadge && live !== "idle" && (
        <span
          className="flow-pill -top-2.5 absolute left-3 inline-flex h-5 items-center gap-1 rounded-full px-2 font-semibold text-[10px] tracking-wide"
          style={{ ...toneStyle(LIVE_TONE[live]), background: "var(--flow-card-solid)" }}
        >
          <liveBadge.Icon {...ICON_SM} className={live === "running" ? "flow-spin" : undefined} aria-hidden />
          {t(liveBadge.label)}
        </span>
      )}
      {disconnected && (
        <span
          className="flow-pill -top-2.5 absolute right-3 inline-flex h-5 items-center gap-1 rounded-full px-2 font-semibold text-[10px] tracking-wide"
          style={{ ...toneStyle("idle"), background: "var(--flow-card-solid)" }}
        >
          <Unplug {...ICON_SM} aria-hidden />
          {t("flow.node.badge.disconnected")}
        </span>
      )}
      {unused && (
        <span
          className="flow-pill -top-2.5 absolute right-3 inline-flex h-5 items-center gap-1 rounded-full px-2 font-semibold text-[10px] tracking-wide"
          style={{ ...toneStyle("idle"), background: "var(--flow-card-solid)" }}
        >
          <PowerOff {...ICON_SM} aria-hidden />
          {t("flow.node.badge.unused")}
        </span>
      )}
      {crashedBadge && (
        <span
          className="flow-pill -top-2.5 absolute right-3 inline-flex h-5 items-center gap-1 rounded-full px-2 font-semibold text-[10px] tracking-wide"
          style={toneStyle("crashed")}
        >
          <ZapOff {...ICON_SM} aria-hidden />
          {crashedBadge}
        </span>
      )}
      <div className="flex items-start gap-3">
        <div className="flow-icon-box grid size-10 shrink-0 place-items-center rounded-xl" style={toneStyle(tone)}>
          <NodeIcon node={node} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="line-clamp-2 break-words font-semibold text-[14.5px] leading-[1.25]" title={node.label}>
            {node.label}
          </div>
          <div className="mt-0.5 flex items-center gap-1 font-medium text-[12.5px] leading-4" style={{ color: TONE_VAR[healthTone] }}>
            {disconnected ? (
              <>
                <Unplug {...ICON_SM} aria-hidden />
                <span>{t("flow.node.disconnected")}</span>
              </>
            ) : unused ? (
              <>
                <PowerOff {...ICON_SM} aria-hidden />
                <span>{t("flow.node.unused")}</span>
              </>
            ) : (
              <>
                <HealthGlyph health={node.health} small />
                <span>{t(`flow.health.${node.health}`)}</span>
              </>
            )}
          </div>
          <div className="mt-0.5 truncate text-[11.5px]" style={{ color: "var(--flow-text-dim)" }} title={subtitleOf(node, t)}>
            {subtitleOf(node, t)}
          </div>
        </div>
      </div>
      <div
        className={`mt-2.5 flex items-center gap-2.5 border-t pt-2 text-[13px] tabular-nums ${manageKind ? "pr-7" : ""}`}
        style={{ borderColor: "var(--flow-card-border)" }}
      >
        {node.throughput === 0 && node.successPct === null ? (
          <span className="text-[12px]" style={{ color: "var(--flow-text-dim)" }}>
            {t("flow.node.no-traffic")}
          </span>
        ) : (
          <>
            <span className="inline-flex items-center gap-1.5 font-medium">
              <span className="size-2 rounded-full" style={{ background: TONE_VAR[healthTone] }} />
              {node.successPct === null ? t("flow.node.throughput", { count: fmtCount(node.throughput) }) : `${node.successPct}%`}
            </span>
            {node.p95Ms !== null && (
              <>
                <span className="h-3.5 w-px" style={{ background: "var(--flow-card-border)" }} />
                <span style={{ color: "var(--flow-text-dim)" }}>{t("flow.node.latency", { ms: node.p95Ms })}</span>
              </>
            )}
          </>
        )}
      </div>
      {manageKind && (
        // L4: nút mở hộp "Ngắt / Kết nối lại / Xoá" — nằm NGOÀI phần bị làm mờ của thẻ đã ngắt (flow.css) nên luôn đủ tương phản.
        <button
          type="button"
          className="flow-manage-btn nodrag nopan absolute right-2 bottom-2 grid size-6 place-items-center rounded-md transition hover:bg-[var(--flow-card-border)]"
          style={{ color: "var(--flow-text-dim)" }}
          aria-label={t(disconnected ? "flow.node.manage-aria-connect" : "flow.node.manage-aria-disconnect", {
            noun: t(KIND_NOUN[manageKind]),
            label: node.label,
          })}
          title={t(disconnected ? "flow.node.manage-title-connect" : "flow.node.manage-title-disconnect")}
          onClick={(e) => {
            e.stopPropagation();
            onManage(node);
          }}
        >
          <Ellipsis {...ICON_SM} aria-hidden />
        </button>
      )}
      {((dst && ((dst.verification && dst.verification !== "VERIFIED") || dst.circuitState !== "CLOSED" || dst.throttleRps > 0 || dst.retrying > 0 || dst.dead > 0)) || (src && src.rejected > 0)) && (
        <div className="mt-2 flex flex-wrap items-center gap-1">
          {dst && (
            <>
              {dst.verification && dst.verification !== "VERIFIED" && (
                <span
                  className="flow-pill inline-flex h-5 items-center gap-1 rounded-full px-2 text-[11px]"
                  style={toneStyle(unused ? "idle" : dst.verification === "FAILED" ? "crashed" : "warning")}
                  title={dst.verificationError ?? undefined}
                >
                  <ShieldAlert {...ICON_SM} aria-hidden />
                  {dst.verification === "FAILED" ? t("flow.node.verify-failed") : t("flow.node.unverified")}
                </span>
              )}
              {dst.circuitState !== "CLOSED" && (
                <span className="flow-pill inline-flex h-5 items-center gap-1 rounded-full px-2 text-[11px]" style={toneStyle(dst.circuitState === "OPEN" ? "crashed" : "warning")}>
                  {dst.circuitState === "OPEN" ? <ZapOff {...ICON_SM} aria-hidden /> : <Zap {...ICON_SM} aria-hidden />}
                  {dst.circuitState === "OPEN" ? t("flow.node.circuit.open") : dst.circuitState === "HALF_OPEN" ? t("flow.node.circuit.half-open") : dst.circuitState}
                </span>
              )}
              {dst.throttleRps > 0 && (
                <span className="flow-pill inline-flex h-5 items-center gap-1 rounded-full px-2 text-[11px]" style={toneStyle("idle")}>
                  <Gauge {...ICON_SM} aria-hidden />≤{dst.throttleRps} rps
                </span>
              )}
              {dst.retrying > 0 && (
                <button
                  type="button"
                  className="flow-pill nodrag inline-flex h-5 items-center rounded-full px-2 text-[11px] hover:brightness-110"
                  style={toneStyle("warning")}
                  onClick={(e) => {
                    e.stopPropagation();
                    onBadge(`/dashboard/events?status=in_progress&destination=${dst.id.slice(4)}`);
                  }}
                >
                  {t("flow.node.retrying", { count: dst.retrying })}
                </button>
              )}
              {dst.dead > 0 && (
                <button
                  type="button"
                  className="flow-pill nodrag inline-flex h-5 items-center rounded-full px-2 text-[11px] hover:brightness-110"
                  style={toneStyle("crashed")}
                  onClick={(e) => {
                    e.stopPropagation();
                    onBadge(`/dashboard/events?status=failed&destination=${dst.id.slice(4)}`);
                  }}
                >
                  {t("flow.node.dead", { count: dst.dead })}
                </button>
              )}
            </>
          )}
          {src && src.rejected > 0 && (
            <button
              type="button"
              className="flow-pill nodrag inline-flex h-5 items-center gap-1 rounded-full px-2 text-[11px]"
              style={toneStyle("crashed")}
              onClick={(e) => {
                e.stopPropagation();
                onBadge(`/dashboard/events?status=rejected&source=${src.id.slice(4)}`);
              }}
            >
              <span className="size-1.5 rounded-full" style={{ background: "var(--flow-crashed)" }} />
              {t("flow.node.rejected", { count: src.rejected })}
            </button>
          )}
        </div>
      )}
    </div>
  );
});

/**
 * Cạnh cong kiểu n8n: nét đứt chạy CHỈ khi có sự kiện đang bay trên chặng (live = running); vừa xong →
 * liền xanh (lỗi đỏ, thử lại vàng) rồi lắng; không có gì → liền, mờ theo health cửa sổ.
 * Nhãn `120 ev/15m · 12ms` (số cửa sổ do server đếm) giữ nguyên; chấm sáng theo socket là tuỳ chọn riêng.
 */
const TopologyEdge = memo(function TopologyEdge(props: EdgeProps<Edge<EdgeData>>) {
  const { sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, markerEnd } = props;
  const t = useT();
  const [path, lx, ly] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, curvature: 0.35 });
  if (!data) return null;
  const { edge, window, pulses, caption, captionOff, live: view } = data;
  // ADR-161: nhãn gộp có dòng "… đã ngắt" (disconnectedNote) thì luôn hiện, kể cả chưa có traffic.
  const hasDisconnectedNote = Boolean(captionOff);
  const tone = HEALTH_TONE[edge.health];
  const color = TONE_VAR[tone];
  const width = Math.min(2 + Math.log2(edge.count + 1) * 0.6, 6);
  const live = edge.count > 0;
  const liveColor = view === "idle" ? color : TONE_VAR[LIVE_TONE[view]];
  return (
    <>
      <BaseEdge
        path={path}
        markerEnd={markerEnd}
        className="flow-edge-live"
        style={{
          stroke: liveColor,
          strokeWidth: width,
          opacity: view === "idle" ? 0.45 : view === "running" ? 0.25 : 1,
          filter: view !== "idle" && view !== "running" ? `drop-shadow(0 0 4px ${liveColor})` : undefined,
        }}
      />
      {view === "running" && (
        <path d={path} fill="none" stroke={liveColor} strokeWidth={width} className="flow-edge-animated" style={{ filter: `drop-shadow(0 0 4px ${liveColor})` }} />
      )}
      {pulses.map((p) => (
        <circle key={p.id} r={3.6} fill={p.tone} style={{ filter: `drop-shadow(0 0 6px ${p.tone})` }}>
          <animateMotion dur={`${PULSE_MS}ms`} path={path} fill="freeze" />
        </circle>
      ))}
      {(live || hasDisconnectedNote) && (
        <EdgeLabelRenderer>
          <div
            className="flow-edge-label nodrag nopan pointer-events-none absolute rounded-lg px-2 py-1 text-center font-semibold text-[12px] leading-[1.35] tabular-nums shadow-sm"
            style={{ ...toneStyle(tone), transform: `translate(-50%, -50%) translate(${lx}px, ${ly}px)` }}
          >
            {caption?.split(CAPTION_SEP).map((line, i) => (
              <div key={line} className={`max-w-48 truncate font-medium text-[11px] opacity-90 ${i === 0 ? "font-mono" : ""}`} title={line}>
                {line}
              </div>
            ))}
            {live ? (
              <div>
                {t("flow.edge.rate", { count: fmtCount(edge.count), window: WINDOW_SHORT[window] })}
                {edge.latencyMs !== null && <span className="font-medium opacity-80"> · {edge.latencyMs}ms</span>}
              </div>
            ) : (
              <div className="font-medium opacity-70">{t("flow.node.no-traffic")}</div>
            )}
            {edge.failed > 0 && <div style={{ color: "var(--flow-crashed)" }}>{t("flow.edge.failed", { count: edge.failed })}</div>}
            {edge.failed === 0 && edge.retrying > 0 && <div style={{ color: "var(--flow-warning)" }}>{t("flow.edge.retrying", { count: edge.retrying })}</div>}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
});

const nodeTypes = { card: TopologyCard };
const edgeTypes = { flow: TopologyEdge };

/**
 * Gộp cột Subscription vào NHÃN cạnh Normalize → Đích (mặc định): bản đồ còn 4 cột nên thẻ đủ to để đọc
 * (giống ảnh mẫu). Cạnh gộp mang tổng số + health xấu nhất của các cạnh subscription → đích (server tính).
 */
const CAPTION_SEP = "|";
const HEALTH_RANK: Record<Health, number> = { crashed: 3, warning: 2, healthy: 1, idle: 0 };
function foldSubscriptions(
  topo: FlowTopology,
  t: TranslateFn,
): { topo: FlowTopology; captions: Record<string, string>; captionOff: Set<string> } {
  const subs = topo.nodes.filter((n): n is SubscriptionFlowNode => n.kind === "subscription");
  const captions: Record<string, string> = {};
  const captionOff = new Set<string>();
  const edges: FlowEdge[] = topo.edges.filter((e) => !e.source.startsWith("sub:") && !e.target.startsWith("sub:"));
  const byDest = new Map<string, SubscriptionFlowNode[]>();
  for (const s of subs) byDest.set(s.destinationId, [...(byDest.get(s.destinationId) ?? []), s]);
  for (const [dest, group] of byDest) {
    const outs = topo.edges.filter((e) => group.some((g) => e.source === g.id));
    if (!outs.length) continue;
    const id = `e:fold:${dest}`;
    const worst = outs.reduce((w, e) => (HEALTH_RANK[e.health] > HEALTH_RANK[w] ? e.health : w), "idle" as Health);
    edges.push({
      id,
      source: "normalize",
      target: `dst:${dest}`,
      count: outs.reduce((a, e) => a + e.count, 0),
      failed: outs.reduce((a, e) => a + e.failed, 0),
      retrying: outs.reduce((a, e) => a + e.retrying, 0),
      latencyMs: outs[0].latencyMs,
      health: worst,
    });
    const patterns = [...new Set(group.flatMap((g) => g.eventTypes))];
    // §6A: subscription chỉ nhận từ một số source (sourceIds) → ghi rõ trên nhãn cạnh.
    const from = [...new Set(group.flatMap((g) => g.sourceLabels ?? []))];
    // ADR-161: subscription đã ngắt gộp vào nhãn vẫn phải thấy được.
    const off = disconnectedNote(group, t);
    if (off) captionOff.add(id);
    captions[id] =
      (group.length > 1 ? t("flow.edge.sub-group", { count: group.length, patterns: patterns.join(", ") }) : patterns.join(", ")) +
      (from.length ? `${CAPTION_SEP}${t("flow.edge.only-from", { list: from.join(", ") })}` : "") +
      (off ? `${CAPTION_SEP}${off}` : "");
  }
  return { topo: { ...topo, nodes: topo.nodes.filter((n) => n.kind !== "subscription"), edges }, captions, captionOff };
}

/** > 60 node: gộp các subscription cùng đích thành một node (SPEC §5). */
function collapseIfLarge(topo: FlowTopology, force: boolean, t: TranslateFn): FlowTopology {
  if (!force && topo.nodes.length <= 60) return topo;
  const subs = topo.nodes.filter((n): n is SubscriptionFlowNode => n.kind === "subscription");
  const byDest = new Map<string, SubscriptionFlowNode[]>();
  for (const s of subs) byDest.set(s.destinationId, [...(byDest.get(s.destinationId) ?? []), s]);
  const nodes: FlowNode[] = topo.nodes.filter((n) => n.kind !== "subscription");
  const edges: FlowEdge[] = topo.edges.filter((e) => !e.source.startsWith("sub:") && !e.target.startsWith("sub:"));
  const rank: Record<Health, number> = { crashed: 3, warning: 2, healthy: 1, idle: 0 };
  for (const [dest, group] of byDest) {
    const id = `subgroup:${dest}`;
    const worst = group.reduce((w, s) => (rank[s.health] > rank[w] ? s.health : w), "idle" as Health);
    const total = group.reduce((a, s) => a + s.deliveries, 0);
    // ADR-161: nhóm vẽ mờ "ĐÃ NGẮT" khi mọi subscription trong nhóm đã ngắt.
    nodes.push({ ...group[0], id, label: t("flow.node.sub-group", { count: group.length }), eventTypes: group.flatMap((g) => g.eventTypes), deliveries: total, throughput: total, health: worst, active: groupActive(group) });
    const inEdges = topo.edges.filter((e) => group.some((g) => e.target === g.id));
    const outEdges = topo.edges.filter((e) => group.some((g) => e.source === g.id));
    const sum = (es: FlowEdge[], k: "count" | "failed" | "retrying") => es.reduce((a, e) => a + e[k], 0);
    const worstEdge = (es: FlowEdge[]) => es.reduce((w, e) => (rank[e.health] > rank[w] ? e.health : w), "idle" as Health);
    edges.push({ id: `e:norm:${id}`, source: "normalize", target: id, count: sum(inEdges, "count"), failed: sum(inEdges, "failed"), retrying: sum(inEdges, "retrying"), latencyMs: null, health: worstEdge(inEdges) });
    edges.push({ id: `e:sub:${id}`, source: id, target: `dst:${dest}`, count: sum(outEdges, "count"), failed: sum(outEdges, "failed"), retrying: sum(outEdges, "retrying"), latencyMs: outEdges[0]?.latencyMs ?? null, health: worstEdge(outEdges) });
  }
  return { ...topo, nodes, edges };
}

function readPositions(): Record<string, { x: number; y: number }> {
  try {
    return JSON.parse(localStorage.getItem(POS_KEY) ?? "{}");
  } catch {
    return {};
  }
}

export interface TopologyCanvasProps {
  topology: FlowTopology;
  showPulses: boolean;
  collapseSubs: boolean;
  sourceFilter: string | null;
  layoutVersion: number;
  /** Hiện cột Subscription riêng; tắt (mặc định) = gộp vào nhãn cạnh. */
  showSubscriptions: boolean;
  /** Hiện đích không dùng (không còn subscription bật) — vẽ mờ "KHÔNG DÙNG"; tắt = ẩn (header vẫn đếm). */
  showUnused: boolean;
}

export function TopologyCanvas({ topology, showPulses, collapseSubs, sourceFilter, layoutVersion, showSubscriptions, showUnused }: TopologyCanvasProps) {
  const router = useRouter();
  const tr = useT();
  const unused = useMemo(() => unusedDestinationIds(topology), [topology]);
  const topo = useMemo(() => {
    let t = topology;
    if (!showUnused) {
      // ADR-161: mục đã "Ngắt" LUÔN ở lại bản đồ (vẽ mờ) — đích tự ngắt hoặc có subscription đã ngắt không bị ẩn
      // như "không dùng". (Bỏ tuỳ chọn ẩn subscription tắt: tắt = ngắt, phải thấy được.)
      const keep = new Set<string>();
      for (const n of t.nodes) {
        if (!isDisconnected(n)) continue;
        keep.add(n.id);
        if (n.kind === "subscription") keep.add(`dst:${(n as SubscriptionFlowNode).destinationId}`);
      }
      const hide = (id: string) => unused.has(id) && !keep.has(id);
      t = { ...t, nodes: t.nodes.filter((n) => !hide(n.id)), edges: t.edges.filter((e) => !hide(e.target)) };
    }
    let captions: Record<string, string> = {};
    let captionOff = new Set<string>();
    if (showSubscriptions) t = collapseIfLarge(t, collapseSubs, tr);
    else ({ topo: t, captions, captionOff } = foldSubscriptions(t, tr));
    if (sourceFilter) {
      const keep = (id: string) => !id.startsWith("src:") || id === `src:${sourceFilter}`;
      t = { ...t, nodes: t.nodes.filter((n) => keep(n.id)), edges: t.edges.filter((e) => keep(e.source)) };
    }
    return { ...t, captions, captionOff };
  }, [topology, collapseSubs, sourceFilter, showSubscriptions, showUnused, unused, tr]);

  const [pulses, setPulses] = useState<Record<string, { id: number; tone: string }[]>>({});
  const onBadge = useCallback((href: string) => router.push(href), [router]);
  // ADR-161: node đang mở hộp "Ngắt / Xoá" (null = đóng).
  const [managing, setManaging] = useState<FlowNode | null>(null);
  const onManage = useCallback((n: FlowNode) => setManaging(n), []);

  const structureKey = topo.nodes.map((n) => n.id).join("|") + topo.edges.map((e) => e.id).join("|");
  const positions = useMemo(() => {
    // Đích không có cạnh vào (không dùng) → cạnh ẢO chỉ cho dagre để nó nằm ở cột đích, không lạc sang cột source.
    const layoutEdges: { source: string; target: string }[] = [...topo.edges];
    for (const n of topo.nodes) {
      if (n.kind === "destination" && !topo.edges.some((e) => e.target === n.id)) layoutEdges.push({ source: "normalize", target: n.id });
    }
    const auto = layoutLR(
      topo.nodes.map((n) => ({ id: n.id, width: NODE_W, height: NODE_H + 30 })),
      layoutEdges,
      { ranksep: showSubscriptions ? 70 : 118, nodesep: 46 },
    );
    const saved = typeof window !== "undefined" && layoutVersion >= 0 ? readPositions() : {};
    return { ...auto, ...saved };
    // biome-ignore lint/correctness/useExhaustiveDependencies: chỉ bố cục lại khi CẤU TRÚC đổi
  }, [structureKey, layoutVersion, showSubscriptions]);

  const [nodes, setNodes, onNodesChange] = useNodesState<Node<CardData>>([]);
  const [edges, setEdges] = useEdgesState<Edge<EdgeData>>([]);

  // --- Trạng thái sống từng chặng (live-activity.ts): chạy chỉ khi có sự kiện đang bay, TTL tự lắng ---
  const [live, setLive] = useState<LiveState>(emptyLive);
  useEffect(() => {
    const now = Date.now();
    const { nextWakeAt } = livePrune(live, now);
    if (nextWakeAt === null) return;
    const timer = setTimeout(() => setLive((s) => livePrune(s, Date.now()).state), Math.max(0, nextWakeAt - now) + 20);
    return () => clearTimeout(timer);
  }, [live]);

  useEffect(() => {
    const now = Date.now();
    // L-B2: node không đổi gì giữ nguyên object (TopologyCard memo không render lại).
    setNodes((prev) => {
      const byId = new Map(prev.map((p) => [p.id, p]));
      return reuseStable(
        prev,
        topo.nodes.map((n) => {
          const old = byId.get(n.id);
          return {
            id: n.id,
            type: "card",
            position: old?.position ?? positions[n.id] ?? { x: 0, y: 0 },
            data: { node: n, window: topo.window, onBadge, onManage, live: liveView(live, n.id, now), unused: unused.has(n.id) },
          };
        }),
        (o, n) => o.position === n.position && sameShallow(o.data, n.data),
      );
    });
  }, [topo, positions, setNodes, onBadge, onManage, live, unused]);

  useEffect(() => {
    const now = Date.now();
    // L-B2: cạnh không đổi gì giữ nguyên object (TopologyEdge memo không render lại).
    setEdges((prev) =>
      reuseStable(
        prev,
        topo.edges.map((e) => {
        const view = liveView(live, e.id, now);
        const markerColor = view === "idle" ? TONE_VAR[HEALTH_TONE[e.health]] : TONE_VAR[LIVE_TONE[view]];
        return {
          id: e.id,
          source: e.source,
          target: e.target,
          type: "flow",
          markerEnd: { type: MarkerType.ArrowClosed, color: markerColor, width: 16, height: 16 },
          data: { edge: e, window: topo.window, pulses: pulses[e.id] ?? NO_PULSES, caption: topo.captions[e.id], captionOff: topo.captionOff.has(e.id), live: view },
        };
      }),
        (o, n) =>
          o.source === n.source &&
          o.target === n.target &&
          (o.markerEnd as { color?: string } | undefined)?.color === (n.markerEnd as { color?: string } | undefined)?.color &&
          !!o.data &&
          !!n.data &&
          sameShallow(o.data, n.data),
      ),
    );
  }, [topo, pulses, setEdges, live]);

  // Layout đổi (nút "Sắp lại") → áp vị trí auto mới.
  useEffect(() => {
    setNodes((prev) => prev.map((n) => ({ ...n, position: positions[n.id] ?? n.position })));
  }, [positions, setNodes]);

  // --- Chấm sáng chạy dọc cạnh (socket), tối đa 30/giây; vượt thì gộp (bỏ chấm thừa) ---
  const budget = useRef({ sec: 0, n: 0 });
  const seq = useRef(0);
  const topoRef = useRef(topo);
  topoRef.current = topo;
  const fullRef = useRef(topology);
  fullRef.current = topology;
  const lastTrace = useRef(0);

  const pulse = useCallback(
    (edgeIds: string[], toneVar: string) => {
      if (!showPulses) return;
      const sec = Math.floor(Date.now() / 1000);
      if (budget.current.sec !== sec) budget.current = { sec, n: 0 };
      const ids = edgeIds.filter((id) => topoRef.current.edges.some((e) => e.id === id));
      if (!ids.length || budget.current.n >= MAX_PULSES_PER_SEC) return;
      budget.current.n += 1;
      const id = ++seq.current;
      setPulses((p) => {
        const next = { ...p };
        for (const eid of ids) next[eid] = [...(next[eid] ?? []).slice(-4), { id, tone: toneVar }];
        return next;
      });
      setTimeout(
        () =>
          setPulses((p) => {
            const next: typeof p = {};
            for (const [k, v] of Object.entries(p)) {
              const rest = v.filter((x) => x.id !== id);
              if (rest.length) next[k] = rest;
            }
            return next;
          }),
        PULSE_MS + 100,
      );
    },
    [showPulses],
  );

  useEffect(() => {
    const t = () => topoRef.current;
    const subsOfDest = (destinationId: string) =>
      fullRef.current.nodes.filter((n): n is SubscriptionFlowNode => n.kind === "subscription" && n.destinationId === destinationId && n.active);
    // L-B2: gom mốc socket theo khung hình → một setLive / frame dù burst vài trăm ev/s.
    let queue: LiveOp[] = [];
    let frame: number | null = null;
    const flush = () => {
      frame = null;
      const ops = queue;
      queue = [];
      if (ops.length) setLive((s) => liveApplyBatch(s, ops));
    };
    const enqueue = (o: LiveOp) => {
      queue.push(o);
      if (frame === null) frame = requestAnimationFrame(flush);
    };
    const start = (keys: string[], token: string) => enqueue({ op: "start", keys, token, at: Date.now() });
    const end = (keys: string[], token: string, kind: LiveResult) => enqueue({ op: "end", keys, token, kind, at: Date.now() });
    // Chặng "giao" của một đích: mọi biến thể id cạnh (gộp nhãn / cột subscription / gộp nhóm) + node đích.
    const deliverKeys = (d: string) =>
      subsOfDest(d)
        .map((s) => `e:sub:${s.id.slice(4)}`)
        .concat(`e:sub:subgroup:${d}`, `e:fold:${d}`, `dst:${d}`);
    // Chặng normalize → subscription (khi hiện cột Subscription): xong ngay khi delivery được tạo.
    const routedKeys = (d: string) =>
      subsOfDest(d)
        .flatMap((s) => [`e:norm:${s.id.slice(4)}`, s.id])
        .concat(`e:norm:subgroup:${d}`, `subgroup:${d}`);
    const offTrace = subscribeHubSocket("trace.ingested", (n) => {
      lastTrace.current = Date.now();
      const src = t().nodes.find((x): x is SourceFlowNode => x.kind === "source" && x.sourceKey === n.sourceKey);
      if (!src) return;
      const bad = n.outcome === "REJECTED" || n.outcome === "ERROR" || n.outcome === "RATE_LIMITED";
      // trace tới SAU khi ingest đã COMMIT + ACK → chặng source→cổng kết thúc; ACCEPTED thì normalize bắt đầu bay.
      end([`e:${src.id}`, src.id, "gate"], n.correlationId, n.outcome === "RATE_LIMITED" ? "warn" : bad ? "fail" : "ok");
      if (n.outcome === "ACCEPTED") start(["e:gate", "normalize"], n.rawEventId ?? n.correlationId);
      pulse([`e:${src.id}`], bad ? "var(--flow-crashed)" : "var(--flow-healthy)");
      if (n.outcome === "ACCEPTED") setTimeout(() => pulse(["e:gate"], "var(--flow-healthy)"), 500);
    });
    const offEvent = subscribeHubSocket("event.received", (n) => {
      // trace.ingested chỉ tới client nối CÙNG instance hub-api — thiếu thì chạy chấm từ source theo provider.
      if (Date.now() - lastTrace.current > 5000) {
        const provs = new Set(n.events.map((e) => e.source));
        const srcs = t().nodes.filter((x): x is SourceFlowNode => x.kind === "source" && provs.has(x.provider));
        pulse(srcs.map((x) => `e:${x.id}`), "var(--flow-healthy)");
        setTimeout(() => pulse(["e:gate"], "var(--flow-healthy)"), 450);
        end(srcs.flatMap((x) => [`e:${x.id}`, x.id]).concat("gate"), n.correlationId, "ok");
      }
      // Normalize + route xong (delivery đã tạo) → chặng cổng→normalize kết thúc; mỗi delivery bắt đầu bay tới đích.
      end(["e:gate", "normalize"], n.rawEventId, "ok");
      end(["e:gate", "normalize"], n.correlationId, "ok");
      for (const d of n.deliveries) {
        end(routedKeys(d.destinationId), d.deliveryId, "ok");
        start(deliverKeys(d.destinationId), d.deliveryId);
      }
      const dests = [...new Set(n.deliveries.map((d) => d.destinationId))];
      setTimeout(() => pulse(dests.flatMap((d) => subsOfDest(d).map((s) => `e:norm:${s.id.slice(4)}`).concat(`e:norm:subgroup:${d}`, `e:fold:${d}`)), "var(--flow-healthy)"), 900);
    });
    const offAttempt = subscribeHubSocket("delivery.attempt", (n) => {
      const tone =
        n.status === "SUCCEEDED" ? "var(--flow-healthy)" : n.status === "DEAD" ? "var(--flow-crashed)" : "var(--flow-warning)";
      end(deliverKeys(n.destinationId), n.deliveryId, n.status === "SUCCEEDED" ? "ok" : n.status === "DEAD" ? "fail" : "warn");
      pulse(subsOfDest(n.destinationId).map((s) => `e:sub:${s.id.slice(4)}`).concat(`e:sub:subgroup:${n.destinationId}`, `e:fold:${n.destinationId}`), tone);
    });
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      offTrace();
      offEvent();
      offAttempt();
    };
  }, [pulse]);

  return (
    <>
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      onNodesChange={onNodesChange}
      onNodeDragStop={(_, node) => {
        try {
          const saved = readPositions();
          saved[node.id] = node.position;
          localStorage.setItem(POS_KEY, JSON.stringify(saved));
        } catch {
          /* localStorage bị chặn → chỉ không nhớ vị trí */
        }
      }}
      onNodeClick={(_, node) => {
        const id = node.id;
        if (id.startsWith("src:")) router.push("/dashboard/sources");
        else if (id.startsWith("dst:")) router.push("/dashboard/destinations");
        else if (id.startsWith("sub")) router.push("/dashboard/subscriptions");
        else if (id === "normalize") router.push("/dashboard/events?status=failed");
        else if (id === "gate") router.push("/dashboard/events?status=rejected");
      }}
      fitView
      fitViewOptions={{ padding: 0.05, maxZoom: 1 }}
      minZoom={0.3}
      maxZoom={1.6}
      proOptions={{ hideAttribution: true }}
      nodesConnectable={false}
      edgesFocusable={false}
    />
    <ManageNodeDialog node={managing} topology={topology} onClose={() => setManaging(null)} />
    </>
  );
}

/**
 * ADR-161: hộp "Ngắt / Xoá" của một node. Ngắt = PATCH isActive=false (node ở lại, vẽ mờ); node đã ngắt thì nút
 * thành "Kết nối lại". Xoá = LƯU TRỮ phía hub (biến khỏi bản đồ + danh sách) — nói thật: lịch sử vẫn giữ.
 */
function ManageNodeDialog({ node, topology, onClose }: { node: FlowNode | null; topology: FlowTopology; onClose: () => void }) {
  const t = useT();
  const setActive = useFlowSetActive();
  const archive = useFlowArchive();
  const kind = node ? manageableKind(node) : null;
  const disconnected = node ? isDisconnected(node) : false;
  const busy = setActive.isPending || archive.isPending;
  const noun = kind ? t(KIND_NOUN[kind]) : "";
  const cascade =
    kind === "destination"
      ? ` ${t("flow.manage.cascade-destination")}`
      : kind === "source"
        ? ` ${t("flow.manage.cascade-source")}`
        : "";
  // L4: kết nối lại subscription mà đích của nó đang Ngắt -> vẫn chưa giao được gì.
  const dstOfSub =
    node?.kind === "subscription"
      ? (topology.nodes.find((n) => n.id === `dst:${(node as SubscriptionFlowNode).destinationId}`) as DestinationFlowNode | undefined)
      : undefined;
  const destStillOff = disconnected && dstOfSub?.active === false;
  // L2: mục do service tạo qua /v1/p (vd Shop `ensure`) — service có thể tạo lại khi khởi động lại.
  const serviceManaged =
    (node?.kind === "destination" && (node as DestinationFlowNode).managedByService) || (node?.kind === "subscription" && dstOfSub?.managedByService);

  const toggle = () => {
    if (!node || !kind) return;
    setActive.mutate(
      { kind, id: rawIdOf(node), isActive: disconnected },
      {
        onSuccess: () => {
          toast.success(t(disconnected ? "flow.toast.connected" : "flow.toast.disconnected", { label: node.label }));
          onClose();
        },
        onError: (err) =>
          toast.error(t(disconnected ? "flow.toast.connect-failed" : "flow.toast.disconnect-failed", { message: err.message })),
      },
    );
  };
  const remove = () => {
    if (!node || !kind) return;
    archive.mutate(
      { kind, id: rawIdOf(node) },
      {
        onSuccess: (r) => {
          const subs = kind !== "subscription" ? r.archivedSubscriptionIds.length : 0;
          toast.success(
            subs
              ? t("flow.toast.deleted-with-subs", { label: node.label, count: subs })
              : t("flow.toast.deleted", { label: node.label }),
          );
          onClose();
        },
        onError: (err) => toast.error(t("flow.toast.delete-failed", { message: err.message })),
      },
    );
  };

  return (
    <AlertDialog open={Boolean(node && kind)} onOpenChange={(o) => !o && !busy && onClose()}>
      {/* UI-MS: footer 3 nút + ghi chú dài -> cỡ md; thân cuộn, nút đứng yên */}
      <AlertDialogContent size="md">
        <AlertDialogBody>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t(disconnected ? "flow.manage.title-connect" : "flow.manage.title-disconnect", { noun, label: node?.label ?? "" })}
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2">
              <p>
                <strong>{t(disconnected ? "flow.manage.connect" : "flow.manage.disconnect")}:</strong>{" "}
                {t(disconnected ? "flow.manage.connect-desc" : "flow.manage.disconnect-desc", { noun: capitalize(noun) })}
              </p>
              <p>
                <strong>{t("flow.manage.delete-label")}</strong> {t("flow.manage.delete-desc", { noun })}
                {cascade} {t("flow.manage.history-kept")}
              </p>
              {node?.kind === "source" && (node as SourceFlowNode).providerConnected && (
                <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-amber-700 dark:text-amber-300">
                  <strong>{t("flow.manage.note")}</strong> {t("flow.manage.provider-note-1")}{" "}
                  <strong>{t("flow.manage.provider-note-btn")}</strong> {t("flow.manage.provider-note-2")}{" "}
                  <a className="underline" href="/dashboard/sources">
                    {t("flow.manage.provider-note-link")}
                  </a>{" "}
                  {t("flow.manage.provider-note-3")}
                </p>
              )}
              {destStillOff && (
                <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-amber-700 dark:text-amber-300">
                  <strong>{t("flow.manage.note")}</strong> {t("flow.manage.dest-off-note", { label: dstOfSub?.label ?? "" })}
                </p>
              )}
              {serviceManaged && (
                <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-amber-700 dark:text-amber-300">
                  <strong>{t("flow.manage.note")}</strong> {t("flow.manage.service-note")}
                </p>
              )}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        </AlertDialogBody>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>{t("common.cancel")}</AlertDialogCancel>
          <Button variant="outline" disabled={busy} onClick={toggle}>
            {setActive.isPending ? t("common.saving") : t(disconnected ? "flow.manage.connect" : "flow.manage.disconnect")}
          </Button>
          <Button variant="destructive" disabled={busy} onClick={remove}>
            {archive.isPending ? t("flow.manage.deleting") : t("common.delete")}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
