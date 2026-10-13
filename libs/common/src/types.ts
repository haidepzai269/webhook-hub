export type ProviderType = 'payos' | 'sepay' | 'github' | 'stripe' | 'generic' | 'api';

export type RawEventStatus = 'ACCEPTED' | 'REJECTED' | 'DUPLICATE';

export type EventOrigin = 'webhook' | 'api' | 'reconciliation' | 'replay' | 'derived';

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
  type: string; // kiểu chuẩn (payment.received, repo.push…) hoặc <provider>.<kiểu gốc> (github.ping…)
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
  /**
   * S3-2 (ADR-053): true = `data` theo catalog kiểu chuẩn (`libs/common/src/canonical`), đã qua
   * validator. false = kiểu chưa có ánh xạ, `data = { raw }`. Thiếu = true (event cũ trước S3-2).
   */
  normalized?: boolean;
  /**
   * KQ1 (ADR-159): true = request KIỂM TRA của chính provider (vd PayOS `confirm-webhook` bắn bộ mẫu cố định), không phải
   * sự kiện nghiệp vụ. Lõi LƯU event (console/inspect thấy) nhưng KHÔNG định tuyến (0 delivery, kể cả subscription `*`) và
   * polling không trả. Chỉ adapter quyết (từ vựng provider ở adapter — BB-1); lõi chỉ đọc cờ, không hỏi provider nào.
   * Thiếu = false.
   */
  probe?: boolean;
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
  /**
   * BP2 (ADR-196): GỢI Ý để gate circuit/throttle TRƯỚC khi nạp DB. Tuỳ chọn — message cũ không có vẫn chạy đường cũ.
   * `destinationId` là tham chiếu; `rateLimitRps` là bản chụp cấu hình (không bí mật). Worker luôn kiểm lại với row
   * thật sau khi nạp — lệch thì gate lại với giá trị thật trước khi gửi.
   */
  destinationId?: string;
  rateLimitRps?: number;
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
