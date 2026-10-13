// Hình dạng JSON trả về từ hub-api (`/api/v1/*`). Chỉ khai báo trường UI dùng tới.

export const DELIVERY_STATUSES = ["PENDING", "DELIVERING", "RETRYING", "SUCCEEDED", "DEAD"] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

// PK1 (ADR-202): `generic` = "Provider khác" — nguồn tự khai cách xác thực (GenericAdapter, S8).
export const PROVIDERS = ["github", "sepay", "payos", "stripe", "generic"] as const;
export type Provider = (typeof PROVIDERS)[number];

export const DESTINATION_TYPES = ["webhook", "telegram", "discord"] as const;
export type DestinationType = (typeof DESTINATION_TYPES)[number];

export interface Overview {
  totalSources: number;
  totalDestinations: number;
  totalEvents: number;
  totalDeliveries: number;
  deadDeliveries: number;
  /** null khi chưa có delivery nào (S2-2) — UI hiện "—". */
  successRate: number | null;
}

export interface TimeseriesBucket {
  bucket: string;
  events: number;
  succeeded: number;
  retrying: number;
  dead: number;
}

export type TimeseriesRange = "24h" | "7d";

export interface DeliveryAttempt {
  id: string;
  attemptNo: number;
  responseStatus: number | null;
  durationMs: number | null;
  error: string | null;
  createdAt: string;
}

export interface Destination {
  id: string;
  name: string;
  type: DestinationType;
  rateLimitRps: number;
  circuitState: "CLOSED" | "OPEN" | "HALF_OPEN";
  hasSigningSecret?: boolean;
  /** P2 (ADR-140): trạng thái challenge (ADR-040). Thiếu = API cũ, coi như VERIFIED. */
  verification?: "PENDING" | "VERIFIED" | "FAILED";
  verificationError?: string | null;
  verificationFix?: string | null;
  verifiedAt?: string | null;
  managedByService?: boolean;
  createdAt: string;
}

export interface Subscription {
  id: string;
  destinationId: string;
  name: string;
  eventTypes: string[];
  template: string | null;
  isActive: boolean;
  createdAt: string;
  destination?: Destination;
}

export interface Delivery {
  id: string;
  eventId: string;
  subscriptionId: string;
  attemptGeneration: number;
  status: DeliveryStatus;
  attemptCount: number;
  nextAttemptAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  event?: HubEvent;
  subscription?: Subscription;
  attempts?: DeliveryAttempt[];
}

export interface HubEvent {
  id: string;
  type: string;
  source: string;
  subject: string | null;
  data: unknown;
  origin: "webhook" | "reconciliation" | "replay" | "derived";
  correlationId: string;
  occurredAt: string;
  receivedAt: string;
  deliveries?: Delivery[];
}

export interface HubEventDetail extends HubEvent {
  rawEvent: {
    id: string;
    headers: Record<string, unknown>;
    body: unknown;
    signatureValid: boolean;
    status: "ACCEPTED" | "REJECTED" | "DUPLICATE";
    contentType: string | null;
    receivedAt: string;
  } | null;
}

export interface EventsPage {
  events: HubEvent[];
  nextCursor: string | null;
}

export interface Source {
  id: string;
  provider: Provider;
  name: string;
  sourceKey: string;
  isActive: boolean;
  createdAt: string;
  webhookUrl: string;
  secretVersions?: number;
  /** QT5/QT7 (E1): cờ "Giữ lâu" do user tự gắn — không gợi ý/không dọn tự động, còn nhận tới 110% khi LOCKED. */
  keepLonger?: boolean;
}

export interface HealthDependency {
  status: "up" | "down";
  message?: string;
}

export interface Health {
  status: "healthy" | "degraded" | "offline";
  timestamp?: string;
  dependencies?: Record<string, HealthDependency>;
}

export interface MetricsTick {
  timestamp: string;
  eventsPerMin: number;
  /** null khi 5s vừa qua chưa có delivery nào ra kết quả cuối (S2-2). */
  successRate: number | null;
}

export type CircuitState = Destination["circuitState"];

// --- Realtime (S2-2) — khớp libs/common/src/types.ts ---

export interface DeliveryAttemptNotice {
  tenantId: string;
  correlationId: string;
  eventId: string;
  deliveryId: string;
  destinationId: string;
  attemptNo: number;
  generation: number;
  status: "SUCCEEDED" | "RETRYING" | "DEAD" | "DEFERRED";
  httpStatus: number;
  ms: number;
  nextQueue?: string;
  nextAttemptAt?: string;
}

export interface CircuitChangedNotice {
  tenantId?: string;
  destinationId: string;
  from: CircuitState;
  to: CircuitState;
  failures: number;
  at: string;
}

export interface TraceIngestedNotice {
  correlationId: string;
  provider: string;
  sourceKey: string;
  httpStatus: number;
  outcome: "ACCEPTED" | "REJECTED" | "DUPLICATE" | "RATE_LIMITED" | "ERROR";
  rawEventId?: string;
  ms: number;
}

// --- Audit + replay hàng loạt (S2-3) ---

export interface AuditLog {
  id: string;
  action: string;
  entityType: string;
  entityId: string;
  actor: string;
  reason: string | null;
  metadata: unknown;
  createdAt: string;
}

/**
 * ADR-163: trang theo keyset `(created_at, id)`. `next` = cursor đi tới trang CŨ hơn (gửi lại làm `before`),
 * `prev` = cursor đi tới trang MỚI hơn (gửi lại làm `after`); null = hết phía đó.
 */
export interface CursorPage<T> {
  items: T[];
  next: string | null;
  prev: string | null;
}

export interface AuditLogsPage extends CursorPage<AuditLog> {
  /** Tên cũ của `next`. */
  nextBefore: string | null;
}

export interface AuditFacets {
  actions: string[];
  entityTypes: string[];
  actors: string[];
}

export interface ReplayBulkFilter {
  destinationId?: string;
  from?: string;
  to?: string;
  errorContains?: string;
  /** ADR-163: cùng "loại lỗi" với bảng DLQ. */
  errorKind?: string;
}

export interface ReplayBulkSampleRow {
  id: string;
  eventId: string;
  eventType: string;
  lastError: string | null;
  createdAt: string;
  destinationId: string;
  attemptGeneration: number;
}

/** ADR-163: lý do một id đã xem trước không được replay lúc chạy thật. */
export type ReplaySkipReason = "not_found" | "not_dead" | "already_replayed" | "destination_unavailable";

export type ReplayBulkResult =
  | {
      dryRun: true;
      count: number;
      limit: number;
      truncated: boolean;
      sample: ReplayBulkSampleRow[];
      /** ADR-163: đúng tập sẽ replay — gửi lại khi xác nhận. */
      ids: string[];
    }
  | {
      dryRun: false;
      count: number;
      batchId?: string;
      items: { deliveryId: string; newDeliveryId: string; generation: number }[];
      skipped: { count: number; byReason: Partial<Record<ReplaySkipReason, number>>; items: { id: string; reason: ReplaySkipReason }[] };
    };

/** Raw event ACCEPTED chưa sinh event nào (S1-3) — Postgres là trọng tài, không đọc DLQ broker. */
export interface OrphanRawEvent {
  id: string;
  sourceId: string;
  provider: Provider;
  sourceName: string;
  idempotencyKey: string;
  receivedAt: string;
}

export interface OrphanRawEventsPage {
  items: OrphanRawEvent[];
  total: number;
}
