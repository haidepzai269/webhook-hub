export type ProviderType = 'payos' | 'sepay' | 'github' | 'stripe';

export type RawEventStatus = 'ACCEPTED' | 'REJECTED' | 'DUPLICATE';

export type EventOrigin = 'webhook' | 'reconciliation' | 'replay' | 'derived';

export type DestinationType = 'webhook' | 'telegram' | 'discord';

export type DeliveryStatus = 'PENDING' | 'DELIVERING' | 'RETRYING' | 'SUCCEEDED' | 'DEAD';

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface RawWebhookRequest {
  provider: ProviderType;
  sourceKey: string;
  headers: Record<string, string | string[] | undefined>;
  rawBody: Buffer;
  body: any;
  contentType?: string;
  ip?: string;
}

export interface IngestResult {
  accepted: boolean;
  status: number;
  message?: string;
  rawEventId?: string;
  idempotencyKey?: string;
  isDuplicate?: boolean;
}

export interface NormalizedEvent {
  id: string; // ULID
  tenantId: string;
  type: string; // vd: repo.push, payment.succeeded, bank.transfer.received
  source: ProviderType;
  sourceId: string;
  subject?: string;
  data: Record<string, any>;
  occurredAt: string; // ISO string
  receivedAt: string; // ISO string
  correlationId: string;
  rawEventId?: string;
  parentEventId?: string;
  origin: EventOrigin;
}

/**
 * Message delivery CHỈ mang tham chiếu (S1-1, ADR-042). Không bao giờ chứa cấu hình đích,
 * signing secret hay nội dung event: worker nạp lại từ Postgres (đã scope tenant) và giải mã
 * cấu hình ngay lúc gửi. Nhờ vậy outbox, hàng đợi retry và DLQ không giữ secret nào.
 */
export interface DeliveryMessage {
  deliveryId: string;
  tenantId: string;
  attemptGeneration: number;
  attemptCount: number;
  correlationId: string;
}

export interface OutboxPayload {
  rawEventId: string;
  sourceId: string;
  tenantId: string;
  provider: ProviderType;
  correlationId: string;
}

// --- Realtime (S2-2, ADR-049) — hợp đồng giữa worker (publish) và hub-api (emit Socket.IO) ---

/** `delivery.attempt` — kênh Redis `hub:realtime:deliveries`. DEFERRED (circuit hoãn) không được publish. */
export interface DeliveryAttemptNotice {
  tenantId: string;
  correlationId: string;
  eventId: string;
  deliveryId: string;
  destinationId: string;
  attemptNo: number;
  generation: number;
  status: 'SUCCEEDED' | 'RETRYING' | 'DEAD' | 'DEFERRED';
  httpStatus: number;
  ms: number;
  nextQueue?: string;
  nextAttemptAt?: string;
}

/** `event.received` — kênh `hub:realtime:events`, MỘT publish cho mỗi raw event (gộp mảng). */
export interface EventReceivedNotice {
  tenantId: string;
  correlationId: string;
  rawEventId: string;
  events: { id: string; type: string; source: string }[];
  deliveries: { deliveryId: string; eventId: string; destinationId: string; destinationName: string; destinationType: string }[];
}

/** `circuit.changed` — kênh `hub:realtime:circuit`. */
export interface CircuitChangedNotice {
  tenantId: string;
  destinationId: string;
  from: CircuitState;
  to: CircuitState;
  failures: number;
  at: string;
}

/** `trace.ingested` — phát IN-PROCESS từ hub-api (không qua Redis). Gộp chặng ①–④. */
export interface TraceIngestedNotice {
  correlationId: string;
  provider: string;
  sourceKey: string;
  httpStatus: number;
  outcome: 'ACCEPTED' | 'REJECTED' | 'DUPLICATE' | 'RATE_LIMITED' | 'ERROR';
  rawEventId?: string;
  ms: number;
}
