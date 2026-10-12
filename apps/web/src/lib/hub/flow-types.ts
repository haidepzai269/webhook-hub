// Event Flow (SPEC-event-flow-ui) — hình dạng response `/api/v1/flow/*`.
// Từ vựng chặng/health lấy từ libs/common/src/flow qua alias `@hub/flow` (một nguồn sự thật với hub-api).

import type { EventFlow, ExecutionStatus, FlowFailedAt, FlowSummaryDot } from "@hub/flow";

export type {
  ExecutionStatus,
  FlowBranch,
  FlowEdge,
  FlowFailedAt,
  FlowNode,
  FlowSummaryDot,
  FlowTopology,
  Health,
  StageKey,
  StageStatus,
  StageView,
  TopologyWindow,
} from "@hub/flow";

export interface EventFlowResponse extends EventFlow {
  id: string;
  event: {
    id: string;
    type: string;
    source: string;
    subject: string | null;
    normalized: boolean;
    origin: string;
    correlationId: string;
    occurredAt: string;
    receivedAt: string;
  } | null;
  raw: {
    id: string;
    status: "ACCEPTED" | "REJECTED" | "DUPLICATE";
    provider: string;
    providerLabel: string;
    sourceId: string;
    sourceName: string;
    receivedAt: string;
  } | null;
}

export interface ExecutionItem {
  id: string;
  eventId: string | null;
  rawEventId: string | null;
  receivedAt: string;
  provider: string;
  providerLabel: string;
  sourceId: string | null;
  sourceName: string | null;
  type: string | null;
  subject: string | null;
  /**
   * events.probe (ADR-159): request kiểm tra kết nối do ADAPTER đánh dấu (PayOS confirm-webhook, GitHub ping).
   * Tuỳ chọn: server cũ không gửi -> UI rớt về phỏng đoán theo tên kiểu (event-notes.expectedProbe).
   */
  probe?: boolean;
  status: ExecutionStatus;
  summary: FlowSummaryDot[];
  failedAt: FlowFailedAt | null;
}

export interface ExecutionsPage {
  items: ExecutionItem[];
  nextCursor: string | null;
}

export interface ExecutionFilters {
  status?: ExecutionStatus;
  source?: string;
  destination?: string;
  type?: string;
  /** ADR-163 */
  provider?: string;
  /** `hide` = bỏ request kiểm tra kết nối (lọc ở server theo events.probe). */
  probes?: "hide";
  from?: string;
  to?: string;
  /** Tiền tố event id / request id (≥ 4 ký tự). */
  q?: string;
}
