/**
 * Hình dạng bản đồ luồng (V3, `GET /api/v1/flow/topology`) — dùng chung hub-api và web.
 * Số liệu do server đếm (GROUP BY có index); UI chỉ vẽ.
 */
import type { MultiServiceOptionalFields } from './stages';
import type { Health } from './health';

export type TopologyWindow = '15m' | '1h' | '24h';

export const TOPOLOGY_WINDOWS: Record<TopologyWindow, { label: string; seconds: number }> = {
  '15m': { label: '15 phút', seconds: 15 * 60 },
  '1h': { label: '1 giờ', seconds: 60 * 60 },
  '24h': { label: '24 giờ', seconds: 24 * 60 * 60 },
};

export type FlowNodeKind = 'source' | 'gate' | 'normalize' | 'subscription' | 'destination';

interface FlowNodeBase extends MultiServiceOptionalFields {
  id: string;
  kind: FlowNodeKind;
  label: string;
  /** Do server tính bằng `healthOf` (health.ts) — UI chỉ tô màu. */
  health: Health;
  /** Số đi qua trong cửa sổ (nhãn thẻ). */
  throughput: number;
  /** 0..100, null = chưa có gì kết thúc. */
  successPct: number | null;
  p95Ms: number | null;
}

export interface SourceFlowNode extends FlowNodeBase {
  kind: 'source';
  provider: string;
  active: boolean;
  sourceKey: string;
  accepted: number;
  rejected: number;
  /** Bản trùng không được lưu (ingest trả ACK duplicate, không ghi raw_events) → luôn 0 từ DB. */
  duplicate: number;
}

export interface GateFlowNode extends FlowNodeBase {
  kind: 'gate';
  accepted: number;
  rejected: number;
}

export interface NormalizeFlowNode extends FlowNodeBase {
  kind: 'normalize';
  events: number;
  unmapped: number;
  /** Raw event mồ côi trong cửa sổ = "DLQ normalize" theo Postgres (trọng tài, BB-2). */
  orphans: number;
  /** Đang chờ normalize (ACCEPTED < 120s, chưa có event). */
  pending: number;
  lagP50Ms: number | null;
  lagP95Ms: number | null;
}

export interface SubscriptionFlowNode extends FlowNodeBase {
  kind: 'subscription';
  destinationId: string;
  eventTypes: string[];
  active: boolean;
  deliveries: number;
}

export interface DestinationFlowNode extends FlowNodeBase {
  kind: 'destination';
  type: string;
  circuitState: 'CLOSED' | 'OPEN' | 'HALF_OPEN';
  throttleRps: number;
  deliveries: number;
  succeeded: number;
  /** null khi chưa có delivery nào xong trong cửa sổ. */
  successRate: number | null;
  attemptP95Ms: number | null;
  /** Hiện tại (không theo cửa sổ): đang RETRYING / DEAD trong DLQ. */
  retrying: number;
  dead: number;
}

export type FlowNode = SourceFlowNode | GateFlowNode | NormalizeFlowNode | SubscriptionFlowNode | DestinationFlowNode;

export interface FlowEdge {
  id: string;
  source: string;
  target: string;
  count: number;
  failed: number;
  retrying: number;
  /** p95 độ trễ của chặng (ms), null nếu không đo được. */
  latencyMs: number | null;
  health: Health;
}

export interface FlowTopology {
  window: TopologyWindow;
  generatedAt: string;
  nodes: FlowNode[];
  edges: FlowEdge[];
}
