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
import { HEALTH_LABELS } from "@hub/flow";
import { CircleAlert, CircleCheck, CircleX, Gauge, LoaderCircle, PowerOff, ShieldAlert, Zap, ZapOff } from "lucide-react";
import { useRouter } from "next/navigation";

import { subscribeHubSocket } from "@/lib/hub/socket";

import { layoutLR } from "./layout";
import { emptyLive, type LiveResult, type LiveState, type LiveView, liveEnd, livePrune, liveStart, liveView } from "./live-activity";
import { ProviderIcon } from "./provider-icon";
import { destinationIcon, HEALTH_TONE, HealthGlyph, ICON, ICON_SM, KIND_ICON, type Tone, TONE_VAR, toneStyle } from "./tokens";
import { unusedDestinationIds } from "./unused-destinations";

const NODE_W = 236;
const NODE_H = 108;
const POS_KEY = "flow:v3:positions";
const MAX_PULSES_PER_SEC = 30;
const PULSE_MS = 1400;

const WINDOW_SHORT: Record<TopologyWindow, string> = { "15m": "15m", "1h": "1h", "24h": "24h" };

type CardData = { node: FlowNode; window: TopologyWindow; onBadge: (href: string) => void; live: LiveView; unused: boolean };
type EdgeData = { edge: FlowEdge; window: TopologyWindow; pulses: { id: number; tone: string }[]; caption?: string; live: LiveView };

/** Tone của trạng thái sống trên chặng (live-activity). */
const LIVE_TONE: Record<LiveResult | "running", Tone> = { running: "progress", ok: "healthy", warn: "warning", fail: "crashed" };
const LIVE_BADGE: Record<LiveResult | "running", { label: string; Icon: typeof CircleCheck }> = {
  running: { label: "Đang xử lý", Icon: LoaderCircle },
  ok: { label: "Vừa xong", Icon: CircleCheck },
  warn: { label: "Thử lại", Icon: CircleAlert },
  fail: { label: "Lỗi", Icon: CircleX },
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

function subtitleOf(node: FlowNode): string {
  switch (node.kind) {
    case "source":
      return (node as SourceFlowNode).provider.toUpperCase();
    case "gate":
      return "verify · COMMIT · ACK";
    case "normalize":
      return "q.normalize → events";
    case "subscription": {
      const sub = node as SubscriptionFlowNode;
      const from = sub.sourceLabels?.length ? ` · chỉ từ ${sub.sourceLabels.join(", ")}` : "";
      return sub.eventTypes.join(", ") + from;
    }
    case "destination":
      return (node as DestinationFlowNode).type;
  }
}

/** Thẻ node kiểu ảnh mẫu A: icon trong ô, tên, `● Healthy`; hàng dưới `● 99.1% | 105ms lat`. */
const TopologyCard = memo(function TopologyCard({ data, selected }: NodeProps<Node<CardData>>) {
  const { node, onBadge, live, unused } = data;
  // Đích không dùng: xám, không glow đỏ. Đang có sự kiện trên node: tô theo trạng thái sống (n8n).
  const tone: Tone = unused ? "idle" : live !== "idle" ? LIVE_TONE[live] : HEALTH_TONE[node.health];
  const healthTone: Tone = unused ? "idle" : HEALTH_TONE[node.health];
  const dst = node.kind === "destination" ? (node as DestinationFlowNode) : null;
  const src = node.kind === "source" ? (node as SourceFlowNode) : null;
  const sub = node.kind === "subscription" ? (node as SubscriptionFlowNode) : null;
  const crashedBadge = unused ? null : dst?.circuitState === "OPEN" ? "CIRCUIT OPEN" : node.health === "crashed" ? "CRASHED" : null;
  const liveBadge = !unused && live !== "idle" ? LIVE_BADGE[live] : null;

  return (
    <div
      className={`flow-card relative rounded-2xl px-3 py-2.5 ${selected ? "is-selected" : ""}`}
      data-tone={tone}
      data-unused={unused || undefined}
      style={{ ...toneStyle(tone), width: NODE_W, minHeight: NODE_H }}
      title={unused ? "Đích không dùng: không còn subscription nào đang bật trỏ tới. Bật lại hoặc xoá ở trang Đích." : undefined}
    >
      <Handle type="target" position={Position.Left} />
      <Handle type="source" position={Position.Right} />
      {liveBadge && live !== "idle" && (
        <span
          className="flow-pill -top-2.5 absolute left-3 inline-flex h-5 items-center gap-1 rounded-full px-2 font-semibold text-[10px] tracking-wide"
          style={{ ...toneStyle(LIVE_TONE[live]), background: "var(--flow-card-solid)" }}
        >
          <liveBadge.Icon {...ICON_SM} className={live === "running" ? "flow-spin" : undefined} aria-hidden />
          {liveBadge.label}
        </span>
      )}
      {unused && (
        <span
          className="flow-pill -top-2.5 absolute right-3 inline-flex h-5 items-center gap-1 rounded-full px-2 font-semibold text-[10px] tracking-wide"
          style={{ ...toneStyle("idle"), background: "var(--flow-card-solid)" }}
        >
          <PowerOff {...ICON_SM} aria-hidden />
          KHÔNG DÙNG
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
            {unused ? (
              <>
                <PowerOff {...ICON_SM} aria-hidden />
                <span>Không dùng · chưa có subscription</span>
              </>
            ) : (
              <>
                <HealthGlyph health={node.health} small />
                <span>{HEALTH_LABELS[node.health]}</span>
              </>
            )}
          </div>
          <div className="mt-0.5 truncate text-[11.5px]" style={{ color: "var(--flow-text-dim)" }} title={subtitleOf(node)}>
            {subtitleOf(node)}
          </div>
        </div>
      </div>
      <div className="mt-2.5 flex items-center gap-2.5 border-t pt-2 text-[13px] tabular-nums" style={{ borderColor: "var(--flow-card-border)" }}>
        {node.throughput === 0 && node.successPct === null ? (
          <span className="text-[12px]" style={{ color: "var(--flow-text-dim)" }}>
            chưa có traffic
          </span>
        ) : (
          <>
            <span className="inline-flex items-center gap-1.5 font-medium">
              <span className="size-2 rounded-full" style={{ background: TONE_VAR[healthTone] }} />
              {node.successPct === null ? `${fmtCount(node.throughput)} ev` : `${node.successPct}%`}
            </span>
            {node.p95Ms !== null && (
              <>
                <span className="h-3.5 w-px" style={{ background: "var(--flow-card-border)" }} />
                <span style={{ color: "var(--flow-text-dim)" }}>{node.p95Ms}ms lat</span>
              </>
            )}
          </>
        )}
      </div>
      {((dst && ((dst.verification && dst.verification !== "VERIFIED") || dst.circuitState !== "CLOSED" || dst.throttleRps > 0 || dst.retrying > 0 || dst.dead > 0)) || (src && src.rejected > 0) || (sub && !sub.active)) && (
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
                  {dst.verification === "FAILED" ? "XÁC MINH LỖI" : "CHƯA XÁC MINH"}
                </span>
              )}
              {dst.circuitState !== "CLOSED" && (
                <span className="flow-pill inline-flex h-5 items-center gap-1 rounded-full px-2 text-[11px]" style={toneStyle(dst.circuitState === "OPEN" ? "crashed" : "warning")}>
                  {dst.circuitState === "OPEN" ? <ZapOff {...ICON_SM} aria-hidden /> : <Zap {...ICON_SM} aria-hidden />}
                  {dst.circuitState}
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
                  {dst.retrying} RETRYING
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
                  {dst.dead} DEAD
                </button>
              )}
            </>
          )}
          {src && (
            <>
              {src.rejected > 0 && (
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
                  {src.rejected} từ chối
                </button>
              )}
            </>
          )}
          {sub && !sub.active && (
            <span className="flow-pill inline-flex h-5 items-center rounded-full px-2 text-[11px]" style={toneStyle("idle")}>
              đang tắt
            </span>
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
  const [path, lx, ly] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, curvature: 0.35 });
  if (!data) return null;
  const { edge, window, pulses, caption, live: view } = data;
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
      {live && (
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
                {fmtCount(edge.count)} ev/{WINDOW_SHORT[window]}
                {edge.latencyMs !== null && <span className="font-medium opacity-80"> · {edge.latencyMs}ms</span>}
              </div>
            ) : (
              <div className="font-medium opacity-70">chưa có traffic</div>
            )}
            {edge.failed > 0 && <div style={{ color: "var(--flow-crashed)" }}>{edge.failed} lỗi</div>}
            {edge.failed === 0 && edge.retrying > 0 && <div style={{ color: "var(--flow-warning)" }}>{edge.retrying} đang thử lại</div>}
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
function foldSubscriptions(topo: FlowTopology): { topo: FlowTopology; captions: Record<string, string> } {
  const subs = topo.nodes.filter((n): n is SubscriptionFlowNode => n.kind === "subscription");
  const captions: Record<string, string> = {};
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
    captions[id] =
      (group.length > 1 ? `${group.length} sub · ${patterns.join(", ")}` : patterns.join(", ")) +
      (from.length ? `${CAPTION_SEP}chỉ từ: ${from.join(", ")}` : "");
  }
  return { topo: { ...topo, nodes: topo.nodes.filter((n) => n.kind !== "subscription"), edges }, captions };
}

/** > 60 node: gộp các subscription cùng đích thành một node (SPEC §5). */
function collapseIfLarge(topo: FlowTopology, force: boolean): FlowTopology {
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
    nodes.push({ ...group[0], id, label: `${group.length} subscription`, eventTypes: group.flatMap((g) => g.eventTypes), deliveries: total, throughput: total, health: worst });
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
  /** Ẩn subscription đang tắt (mặc định) — bớt node idle, thẻ to hơn. */
  hideInactive: boolean;
  /** Hiện cột Subscription riêng; tắt (mặc định) = gộp vào nhãn cạnh. */
  showSubscriptions: boolean;
  /** Hiện đích không dùng (không còn subscription bật) — vẽ mờ "KHÔNG DÙNG"; tắt = ẩn (header vẫn đếm). */
  showUnused: boolean;
}

export function TopologyCanvas({ topology, showPulses, collapseSubs, sourceFilter, layoutVersion, hideInactive, showSubscriptions, showUnused }: TopologyCanvasProps) {
  const router = useRouter();
  const unused = useMemo(() => unusedDestinationIds(topology), [topology]);
  const topo = useMemo(() => {
    let t = topology;
    if (!showUnused) t = { ...t, nodes: t.nodes.filter((n) => !unused.has(n.id)), edges: t.edges.filter((e) => !unused.has(e.target)) };
    if (hideInactive) {
      // Chỉ ẩn subscription tắt mà KHÔNG còn lưu lượng/thử lại trong cửa sổ — tắt mà còn delivery đang chạy thì vẫn phải thấy.
      const busy = (id: string) => t.edges.some((e) => (e.source === id || e.target === id) && (e.count > 0 || e.retrying > 0));
      const off = new Set(
        t.nodes.filter((n) => n.kind === "subscription" && !(n as SubscriptionFlowNode).active && !busy(n.id)).map((n) => n.id),
      );
      const edges = t.edges.filter((e) => !off.has(e.source) && !off.has(e.target));
      // Đích mất hết subscription = "không dùng" → tuỳ chọn showUnused quyết định (vẽ mờ / ẩn), không ẩn lặng lẽ ở đây.
      t = { ...t, nodes: t.nodes.filter((n) => !off.has(n.id)), edges };
    }
    let captions: Record<string, string> = {};
    if (showSubscriptions) t = collapseIfLarge(t, collapseSubs);
    else ({ topo: t, captions } = foldSubscriptions(t));
    if (sourceFilter) {
      const keep = (id: string) => !id.startsWith("src:") || id === `src:${sourceFilter}`;
      t = { ...t, nodes: t.nodes.filter((n) => keep(n.id)), edges: t.edges.filter((e) => keep(e.source)) };
    }
    return { ...t, captions };
  }, [topology, collapseSubs, sourceFilter, hideInactive, showSubscriptions, showUnused, unused]);

  const [pulses, setPulses] = useState<Record<string, { id: number; tone: string }[]>>({});
  const onBadge = useCallback((href: string) => router.push(href), [router]);

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
    setNodes((prev) =>
      topo.nodes.map((n) => {
        const old = prev.find((p) => p.id === n.id);
        return {
          id: n.id,
          type: "card",
          position: old?.position ?? positions[n.id] ?? { x: 0, y: 0 },
          data: { node: n, window: topo.window, onBadge, live: liveView(live, n.id, now), unused: unused.has(n.id) },
        };
      }),
    );
  }, [topo, positions, setNodes, onBadge, live, unused]);

  useEffect(() => {
    const now = Date.now();
    setEdges(
      topo.edges.map((e) => {
        const view = liveView(live, e.id, now);
        const markerColor = view === "idle" ? TONE_VAR[HEALTH_TONE[e.health]] : TONE_VAR[LIVE_TONE[view]];
        return {
          id: e.id,
          source: e.source,
          target: e.target,
          type: "flow",
          markerEnd: { type: MarkerType.ArrowClosed, color: markerColor, width: 16, height: 16 },
          data: { edge: e, window: topo.window, pulses: pulses[e.id] ?? [], caption: topo.captions[e.id], live: view },
        };
      }),
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
    const start = (keys: string[], token: string) => setLive((s) => liveStart(s, keys, token, Date.now()));
    const end = (keys: string[], token: string, kind: LiveResult) => setLive((s) => liveEnd(s, keys, token, kind, Date.now()));
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
      offTrace();
      offEvent();
      offAttempt();
    };
  }, [pulse]);

  return (
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
  );
}
