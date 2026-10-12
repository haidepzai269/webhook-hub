import {
  DestinationFlowNode,
  edgeHealthOf,
  FlowEdge,
  FlowNode,
  FlowTopology,
  healthOf,
  providerLabel,
  SourceFlowNode,
  SubscriptionFlowNode,
  TopologyWindow,
} from './flow-lib';

export interface TopologyConfig {
  sources: { id: string; name: string; provider: string; sourceKey: string; isActive: boolean; connections?: { id: string }[] }[];
  subscriptions: { id: string; name: string; eventTypes: string[]; isActive: boolean; destinationId: string; sourceIds?: string[] }[];
  destinations: {
    id: string;
    name: string;
    type: string;
    /** ADR-161: false = "Ngắt" (vẽ mờ). Thiếu = true (dữ liệu/test cũ). */
    isActive?: boolean;
    /** ADR-161 (L2): endpoint do một service (API key) tạo — service có thể tạo lại khi khởi động. */
    createdByKeyId?: string | null;
    circuitState: 'CLOSED' | 'OPEN' | 'HALF_OPEN';
    rateLimitRps: number;
    verification?: 'PENDING' | 'VERIFIED' | 'FAILED';
    verificationError?: string | null;
  }[];
}

/** Nhãn gọn cho nhãn cạnh "chỉ từ …": tên provider nếu project chỉ có một source của provider đó, không thì tên source. */
function shortSourceLabel(sources: TopologyConfig['sources'], id: string): string {
  const s = sources.find((x) => x.id === id);
  if (!s) return id.slice(0, 8);
  const sameProvider = sources.filter((x) => x.provider === s.provider).length;
  return sameProvider === 1 ? providerLabel(s.provider) : s.name;
}

const round =(n: number | null | undefined) => (n === null || n === undefined || Number.isNaN(Number(n)) ? null : Math.round(Number(n)));
const pct = (ok: number, total: number) => (total > 0 ? Math.round((ok / total) * 1000) / 10 : null);

/**
 * Ghép kết quả các câu GROUP BY thành node + cạnh. THUẦN (unit test được). Health của mọi node/cạnh
 * do `healthOf` quyết định — UI chỉ tô màu.
 */
export function assembleTopology(
  window: TopologyWindow,
  cfg: TopologyConfig,
  raws: { sourceId: string; status: string; n: number }[],
  norm: { events: number; unmapped: number; p50: number | null; p95: number | null; orphans: number; pending: number },
  bySub: { subscriptionId: string; total: number; succeeded: number; dead: number; retrying: number; active: number }[],
  attempts: { destinationId: string; attempts: number; p95: number | null }[],
  backlog: { destinationId: string; retrying: number; dead: number; deadInWindow: number }[],
  now = new Date(),
): FlowTopology {
  const nodes: FlowNode[] = [];
  const edges: FlowEdge[] = [];

  // --- Sources → cổng xác thực ---
  let gateAccepted = 0;
  let gateRejected = 0;
  for (const s of cfg.sources) {
    const count = (st: string) => raws.filter((r) => r.sourceId === s.id && r.status === st).reduce((a, r) => a + Number(r.n), 0);
    const accepted = count('ACCEPTED');
    const rejected = count('REJECTED');
    const duplicate = count('DUPLICATE');
    gateAccepted += accepted;
    gateRejected += rejected;
    const total = accepted + rejected;
    const node: SourceFlowNode = {
      id: `src:${s.id}`,
      kind: 'source',
      label: s.name,
      provider: s.provider,
      active: s.isActive,
      providerConnected: (s.connections?.length ?? 0) > 0,
      sourceKey: s.sourceKey,
      accepted,
      rejected,
      duplicate,
      health: healthOf({ events: total, rejected }),
      throughput: total,
      successPct: pct(accepted, total),
      p95Ms: null,
    };
    nodes.push(node);
    edges.push({ id: `e:src:${s.id}`, source: node.id, target: 'gate', count: total, failed: rejected, retrying: 0, latencyMs: null, health: edgeHealthOf(total, rejected) });
  }
  const gateTotal = gateAccepted + gateRejected;
  nodes.push({
    id: 'gate',
    kind: 'gate',
    label: 'Cổng xác thực',
    accepted: gateAccepted,
    rejected: gateRejected,
    health: healthOf({ events: gateTotal, rejected: gateRejected }),
    throughput: gateTotal,
    successPct: pct(gateAccepted, gateTotal),
    p95Ms: null,
  });

  // --- Normalize ---
  const events = Number(norm.events) || 0;
  const orphans = Number(norm.orphans) || 0;
  const pending = Number(norm.pending) || 0;
  nodes.push({
    id: 'normalize',
    kind: 'normalize',
    label: 'Normalize + Route',
    events,
    unmapped: Number(norm.unmapped) || 0,
    orphans,
    pending,
    lagP50Ms: round(norm.p50),
    lagP95Ms: round(norm.p95),
    health: healthOf({ events: events + orphans, failed: orphans, p95Ms: round(norm.p95) }),
    throughput: events,
    successPct: pct(events, events + orphans),
    p95Ms: round(norm.p95),
  });
  edges.push({
    id: 'e:gate',
    source: 'gate',
    target: 'normalize',
    count: gateAccepted,
    failed: orphans,
    retrying: pending,
    latencyMs: round(norm.p95),
    health: edgeHealthOf(gateAccepted, orphans),
  });

  // --- Subscriptions + Destinations ---
  const destAgg = new Map<string, { total: number; succeeded: number; dead: number }>();
  for (const sub of cfg.subscriptions) {
    const c = bySub.find((b) => b.subscriptionId === sub.id) ?? { total: 0, succeeded: 0, dead: 0, retrying: 0, active: 0 };
    const agg = destAgg.get(sub.destinationId) ?? { total: 0, succeeded: 0, dead: 0 };
    destAgg.set(sub.destinationId, { total: agg.total + c.total, succeeded: agg.succeeded + c.succeeded, dead: agg.dead + c.dead });
    const done = c.succeeded + c.dead;
    const node: SubscriptionFlowNode = {
      id: `sub:${sub.id}`,
      kind: 'subscription',
      label: sub.name,
      destinationId: sub.destinationId,
      eventTypes: sub.eventTypes,
      // §6A: subscription chỉ nhận từ các source này (rỗng = mọi source). UI ghi nhãn trên cạnh.
      sourceIds: sub.sourceIds ?? [],
      sourceLabels: (sub.sourceIds ?? []).map((id) => shortSourceLabel(cfg.sources, id)),
      active: sub.isActive,
      deliveries: c.total,
      health: sub.isActive ? healthOf({ events: c.total, failed: c.dead, retrying: c.retrying }) : 'idle',
      throughput: c.total,
      successPct: pct(c.succeeded, done),
      p95Ms: null,
    };
    nodes.push(node);
    edges.push({ id: `e:norm:${sub.id}`, source: 'normalize', target: node.id, count: c.total, failed: c.dead, retrying: c.retrying, latencyMs: null, health: node.health });
  }

  for (const d of cfg.destinations) {
    const agg = destAgg.get(d.id) ?? { total: 0, succeeded: 0, dead: 0 };
    const att = attempts.find((a) => a.destinationId === d.id);
    const bl = backlog.find((b) => b.destinationId === d.id) ?? { retrying: 0, dead: 0, deadInWindow: 0 };
    const done = agg.succeeded + agg.dead;
    const successRate = done > 0 ? agg.succeeded / done : null;
    const node: DestinationFlowNode = {
      id: `dst:${d.id}`,
      kind: 'destination',
      label: d.name,
      type: d.type,
      active: d.isActive !== false,
      managedByService: !!d.createdByKeyId,
      circuitState: d.circuitState,
      throttleRps: d.rateLimitRps,
      deliveries: agg.total,
      succeeded: agg.succeeded,
      successRate,
      attemptP95Ms: round(att?.p95),
      retrying: bl.retrying,
      dead: bl.dead,
      verification: d.verification ?? 'VERIFIED',
      verificationError: d.verificationError ?? null,
      health: healthOf({
        verification: d.verification,
        events: agg.total,
        successRate,
        p95Ms: round(att?.p95),
        circuit: d.circuitState,
        retrying: bl.retrying,
        dlqDelta: bl.deadInWindow,
      }),
      throughput: agg.total,
      successPct: successRate === null ? null : Math.round(successRate * 1000) / 10,
      p95Ms: round(att?.p95),
    };
    nodes.push(node);
  }
  for (const sub of cfg.subscriptions) {
    const c = bySub.find((b) => b.subscriptionId === sub.id) ?? { total: 0, dead: 0, retrying: 0 };
    const dst = nodes.find((n) => n.id === `dst:${sub.destinationId}`);
    if (!dst) continue;
    edges.push({
      id: `e:sub:${sub.id}`,
      source: `sub:${sub.id}`,
      target: dst.id,
      count: c.total,
      failed: c.dead,
      retrying: c.retrying,
      latencyMs: dst.p95Ms,
      // Cạnh vào đích crashed (circuit OPEN) cũng đỏ — luồng này đang chết dù cửa sổ chưa có DEAD.
      health: dst.health === 'crashed' && c.total > 0 ? 'crashed' : edgeHealthOf(c.total, c.dead, c.retrying),
    });
  }

  return { window, generatedAt: now.toISOString(), nodes, edges };
}

