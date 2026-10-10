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
import { Gauge, Zap, ZapOff } from "lucide-react";
import { useRouter } from "next/navigation";

import { subscribeHubSocket } from "@/lib/hub/socket";

import { layoutLR } from "./layout";
import { ProviderIcon } from "./provider-icon";
import { destinationIcon, HEALTH_TONE, HealthGlyph, ICON, ICON_SM, KIND_ICON, TONE_VAR, toneStyle } from "./tokens";

const NODE_W = 214;
const NODE_H = 96;
const POS_KEY = "flow:v3:positions";
const MAX_PULSES_PER_SEC = 30;
const PULSE_MS = 1400;

const WINDOW_SHORT: Record<TopologyWindow, string> = { "15m": "15m", "1h": "1h", "24h": "24h" };

type CardData = { node: FlowNode; window: TopologyWindow; onBadge: (href: string) => void };
type EdgeData = { edge: FlowEdge; window: TopologyWindow; pulses: { id: number; tone: string }[] };

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
    case "subscription":
      return (node as SubscriptionFlowNode).eventTypes.join(", ");
    case "destination":
      return (node as DestinationFlowNode).type;
  }
}

/** Thẻ node kiểu ảnh mẫu A: icon trong ô, tên, `● Healthy`; hàng dưới `● 99.1% | 105ms lat`. */
const TopologyCard = memo(function TopologyCard({ data, selected }: NodeProps<Node<CardData>>) {
  const { node, onBadge } = data;
  const tone = HEALTH_TONE[node.health];
  const dst = node.kind === "destination" ? (node as DestinationFlowNode) : null;
  const src = node.kind === "source" ? (node as SourceFlowNode) : null;
  const sub = node.kind === "subscription" ? (node as SubscriptionFlowNode) : null;
  const crashedBadge = dst?.circuitState === "OPEN" ? "CIRCUIT OPEN" : node.health === "crashed" ? "CRASHED" : null;

  return (
    <div
      className={`flow-card relative rounded-2xl px-3 py-2.5 ${selected ? "is-selected" : ""}`}
      data-tone={tone}
      style={{ ...toneStyle(tone), width: NODE_W, minHeight: NODE_H }}
    >
      <Handle type="target" position={Position.Left} />
      <Handle type="source" position={Position.Right} />
      {crashedBadge && (
        <span
          className="flow-pill -top-2.5 absolute right-3 inline-flex h-5 items-center gap-1 rounded-full px-2 font-semibold text-[10px] tracking-wide"
          style={toneStyle("crashed")}
        >
          <ZapOff {...ICON_SM} aria-hidden />
          {crashedBadge}
        </span>
      )}
      <div className="flex items-start gap-2.5">
        <div className="flow-icon-box grid size-9 shrink-0 place-items-center rounded-xl" style={toneStyle(tone)}>
          <NodeIcon node={node} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate font-semibold text-[13.5px] leading-5" title={node.label}>
            {node.label}
          </div>
          <div className="flex items-center gap-1 text-[12px] leading-4" style={{ color: TONE_VAR[tone] }}>
            <HealthGlyph health={node.health} small />
            <span>{HEALTH_LABELS[node.health]}</span>
            <span className="ml-1 truncate text-[11px]" style={{ color: "var(--flow-text-dim)" }} title={subtitleOf(node)}>
              · {subtitleOf(node)}
            </span>
          </div>
        </div>
      </div>
      <div className="mt-2 flex items-center gap-2 border-t pt-1.5 text-[12px] tabular-nums" style={{ borderColor: "var(--flow-card-border)" }}>
        <span className="inline-flex items-center gap-1">
          <span className="size-1.5 rounded-full" style={{ background: TONE_VAR[tone] }} />
          {node.successPct === null ? "—" : `${node.successPct}%`}
        </span>
        <span className="h-3 w-px" style={{ background: "var(--flow-card-border)" }} />
        <span style={{ color: "var(--flow-text-dim)" }}>{node.p95Ms === null ? "— lat" : `${node.p95Ms}ms lat`}</span>
        <span className="ml-auto" style={{ color: "var(--flow-text-dim)" }}>
          {fmtCount(node.throughput)} ev
        </span>
      </div>
      {(dst || src || sub) && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1">
          {dst && (
            <>
              <span className="flow-pill inline-flex h-[18px] items-center gap-1 rounded-full px-1.5 text-[10px]" style={toneStyle(dst.circuitState === "CLOSED" ? "healthy" : dst.circuitState === "OPEN" ? "crashed" : "warning")}>
                {dst.circuitState === "CLOSED" ? <Zap {...ICON_SM} aria-hidden /> : <ZapOff {...ICON_SM} aria-hidden />}
                {dst.circuitState}
              </span>
              {dst.throttleRps > 0 && (
                <span className="flow-pill inline-flex h-[18px] items-center gap-1 rounded-full px-1.5 text-[10px]" style={toneStyle("idle")}>
                  <Gauge {...ICON_SM} aria-hidden />≤{dst.throttleRps} rps
                </span>
              )}
              {dst.retrying > 0 && (
                <button
                  type="button"
                  className="flow-pill nodrag inline-flex h-[18px] items-center rounded-full px-1.5 text-[10px] hover:brightness-110"
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
                  className="flow-pill nodrag inline-flex h-[18px] items-center rounded-full px-1.5 text-[10px] hover:brightness-110"
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
              <span className="text-[10.5px] tabular-nums" style={{ color: "var(--flow-text-dim)" }}>
                {src.accepted} nhận · {src.duplicate} trùng
              </span>
              {src.rejected > 0 && (
                <button
                  type="button"
                  className="flow-pill nodrag inline-flex h-[18px] items-center gap-1 rounded-full px-1.5 text-[10px]"
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
            <span className="flow-pill inline-flex h-[18px] items-center rounded-full px-1.5 text-[10px]" style={toneStyle("idle")}>
              đang tắt
            </span>
          )}
        </div>
      )}
    </div>
  );
});

/** Cạnh cong, nét đứt chạy khi có traffic, nhãn `120 ev/15m · 12ms`, chấm sáng theo socket. */
const TopologyEdge = memo(function TopologyEdge(props: EdgeProps<Edge<EdgeData>>) {
  const { sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, markerEnd } = props;
  const [path, lx, ly] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, curvature: 0.35 });
  if (!data) return null;
  const { edge, window, pulses } = data;
  const tone = HEALTH_TONE[edge.health];
  const color = TONE_VAR[tone];
  const width = Math.min(1.5 + Math.log2(edge.count + 1) * 0.55, 5);
  const live = edge.count > 0;
  return (
    <>
      <BaseEdge path={path} markerEnd={markerEnd} style={{ stroke: color, strokeWidth: width, opacity: live ? 0.35 : 0.5 }} />
      {live && <path d={path} fill="none" stroke={color} strokeWidth={width} className="flow-edge-animated" style={{ filter: `drop-shadow(0 0 4px ${color})` }} />}
      {pulses.map((p) => (
        <circle key={p.id} r={3.6} fill={p.tone} style={{ filter: `drop-shadow(0 0 6px ${p.tone})` }}>
          <animateMotion dur={`${PULSE_MS}ms`} path={path} fill="freeze" />
        </circle>
      ))}
      {live && (
        <EdgeLabelRenderer>
          <div
            className="flow-edge-label nodrag nopan pointer-events-none absolute rounded-md px-1.5 py-0.5 text-center font-medium text-[10.5px] leading-tight tabular-nums"
            style={{ ...toneStyle(tone), transform: `translate(-50%, -50%) translate(${lx}px, ${ly}px)` }}
          >
            {fmtCount(edge.count)} ev/{WINDOW_SHORT[window]}
            {edge.latencyMs !== null && (
              <>
                <br />
                {edge.latencyMs}ms
              </>
            )}
            {edge.failed > 0 && (
              <>
                <br />
                <span style={{ color: "var(--flow-crashed)" }}>{edge.failed} lỗi</span>
              </>
            )}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
});

const nodeTypes = { card: TopologyCard };
const edgeTypes = { flow: TopologyEdge };

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
}

export function TopologyCanvas({ topology, showPulses, collapseSubs, sourceFilter, layoutVersion, hideInactive }: TopologyCanvasProps) {
  const router = useRouter();
  const topo = useMemo(() => {
    let t = topology;
    if (hideInactive) {
      const off = new Set(t.nodes.filter((n) => n.kind === "subscription" && !(n as SubscriptionFlowNode).active).map((n) => n.id));
      const edges = t.edges.filter((e) => !off.has(e.source) && !off.has(e.target));
      // Đích không còn cạnh vào mà idle thì ẩn theo (nếu không dagre đặt nó lạc sang cột source).
      // Đích có vấn đề (crashed/warning) vẫn hiện dù subscription đã tắt.
      const orphanIdle = new Set(
        t.nodes.filter((n) => n.kind === "destination" && n.health === "idle" && !edges.some((e) => e.target === n.id)).map((n) => n.id),
      );
      t = { ...t, nodes: t.nodes.filter((n) => !off.has(n.id) && !orphanIdle.has(n.id)), edges };
    }
    t = collapseIfLarge(t, collapseSubs);
    if (!sourceFilter) return t;
    const keep = (id: string) => !id.startsWith("src:") || id === `src:${sourceFilter}`;
    return { ...t, nodes: t.nodes.filter((n) => keep(n.id)), edges: t.edges.filter((e) => keep(e.source)) };
  }, [topology, collapseSubs, sourceFilter, hideInactive]);

  const [pulses, setPulses] = useState<Record<string, { id: number; tone: string }[]>>({});
  const onBadge = useCallback((href: string) => router.push(href), [router]);

  const structureKey = topo.nodes.map((n) => n.id).join("|") + topo.edges.map((e) => e.id).join("|");
  const positions = useMemo(() => {
    const auto = layoutLR(
      topo.nodes.map((n) => ({ id: n.id, width: NODE_W, height: n.kind === "destination" || n.kind === "source" ? NODE_H + 24 : NODE_H })),
      topo.edges,
      { ranksep: 66, nodesep: 22 },
    );
    const saved = typeof window !== "undefined" && layoutVersion >= 0 ? readPositions() : {};
    return { ...auto, ...saved };
    // biome-ignore lint/correctness/useExhaustiveDependencies: chỉ bố cục lại khi CẤU TRÚC đổi
  }, [structureKey, layoutVersion]);

  const [nodes, setNodes, onNodesChange] = useNodesState<Node<CardData>>([]);
  const [edges, setEdges] = useEdgesState<Edge<EdgeData>>([]);

  useEffect(() => {
    setNodes((prev) =>
      topo.nodes.map((n) => {
        const old = prev.find((p) => p.id === n.id);
        return {
          id: n.id,
          type: "card",
          position: old?.position ?? positions[n.id] ?? { x: 0, y: 0 },
          data: { node: n, window: topo.window, onBadge },
        };
      }),
    );
  }, [topo, positions, setNodes, onBadge]);

  useEffect(() => {
    setEdges(
      topo.edges.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        type: "flow",
        markerEnd: { type: MarkerType.ArrowClosed, color: TONE_VAR[HEALTH_TONE[e.health]], width: 16, height: 16 },
        data: { edge: e, window: topo.window, pulses: pulses[e.id] ?? [] },
      })),
    );
  }, [topo, pulses, setEdges]);

  // Layout đổi (nút "Sắp lại") → áp vị trí auto mới.
  useEffect(() => {
    setNodes((prev) => prev.map((n) => ({ ...n, position: positions[n.id] ?? n.position })));
  }, [positions, setNodes]);

  // --- Chấm sáng chạy dọc cạnh (socket), tối đa 30/giây; vượt thì gộp (bỏ chấm thừa) ---
  const budget = useRef({ sec: 0, n: 0 });
  const seq = useRef(0);
  const topoRef = useRef(topo);
  topoRef.current = topo;
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
      t().nodes.filter((n): n is SubscriptionFlowNode => n.kind === "subscription" && n.destinationId === destinationId && n.active);
    const offTrace = subscribeHubSocket("trace.ingested", (n) => {
      lastTrace.current = Date.now();
      const src = t().nodes.find((x): x is SourceFlowNode => x.kind === "source" && x.sourceKey === n.sourceKey);
      if (!src) return;
      const bad = n.outcome === "REJECTED" || n.outcome === "ERROR" || n.outcome === "RATE_LIMITED";
      pulse([`e:${src.id}`], bad ? "var(--flow-crashed)" : "var(--flow-healthy)");
      if (n.outcome === "ACCEPTED") setTimeout(() => pulse(["e:gate"], "var(--flow-healthy)"), 500);
    });
    const offEvent = subscribeHubSocket("event.received", (n) => {
      // trace.ingested chỉ tới client nối CÙNG instance hub-api — thiếu thì chạy chấm từ source theo provider.
      if (Date.now() - lastTrace.current > 5000) {
        const provs = new Set(n.events.map((e) => e.source));
        pulse(t().nodes.filter((x): x is SourceFlowNode => x.kind === "source" && provs.has(x.provider)).map((x) => `e:${x.id}`), "var(--flow-healthy)");
        setTimeout(() => pulse(["e:gate"], "var(--flow-healthy)"), 450);
      }
      const dests = [...new Set(n.deliveries.map((d) => d.destinationId))];
      setTimeout(() => pulse(dests.flatMap((d) => subsOfDest(d).map((s) => `e:norm:${s.id.slice(4)}`).concat(`e:norm:subgroup:${d}`)), "var(--flow-healthy)"), 900);
    });
    const offAttempt = subscribeHubSocket("delivery.attempt", (n) => {
      const tone =
        n.status === "SUCCEEDED" ? "var(--flow-healthy)" : n.status === "DEAD" ? "var(--flow-crashed)" : "var(--flow-warning)";
      pulse(subsOfDest(n.destinationId).map((s) => `e:sub:${s.id.slice(4)}`).concat(`e:sub:subgroup:${n.destinationId}`), tone);
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
      fitViewOptions={{ padding: 0.12, maxZoom: 1 }}
      minZoom={0.3}
      maxZoom={1.6}
      proOptions={{ hideAttribution: true }}
      nodesConnectable={false}
      edgesFocusable={false}
    />
  );
}
