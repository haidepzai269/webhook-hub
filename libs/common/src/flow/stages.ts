/**
 * Từ vựng chặng của Event Flow (SPEC-event-flow-ui §2) — MỘT nguồn sự thật cho cả hub-api lẫn web.
 *
 * File này THUẦN TS: không import Node, Prisma, pino hay bất cứ thứ gì chỉ chạy ở server, vì
 * `apps/web` import thẳng qua path alias `@hub/flow` (ADR nháp EF-1). UI chỉ VẼ những gì ở đây;
 * mọi trạng thái do `buildEventFlow` (server) quyết định, client không tự suy ra.
 */

export type StageKey =
  | 'received' // request tới /hooks (provider, source, size, correlationId)
  | 'verified' // chữ ký: ok | invalid → REJECTED
  | 'persisted' // raw_events ACCEPTED + outbox trong cùng tx (BB-3); duplicate → dừng ở đây
  | 'normalized' // adapter → event chuẩn | lỗi schema / DLQ normalize
  | 'routed' // subscription khớp / bị bỏ qua kèm lý do
  | 'delivering' // MỘT nhánh cho mỗi delivery: các attempt, tầng retry, circuit, throttle
  | 'done'; // SUCCEEDED | DEAD | RETRYING(next_attempt_at) | DEFERRED(circuit)

export const STAGE_KEYS: readonly StageKey[] = ['received', 'verified', 'persisted', 'normalized', 'routed', 'delivering', 'done'];

/** Tên chặng tiếng Việt — dùng cho nhãn node, cột "Hỏng ở", waterfall. */
export const STAGE_LABELS: Record<StageKey, string> = {
  received: 'Nhận',
  verified: 'Xác thực',
  persisted: 'Lưu (COMMIT)',
  normalized: 'Normalize',
  routed: 'Định tuyến',
  delivering: 'Giao',
  done: 'Kết thúc',
};

export type StageStatus = 'ok' | 'failed' | 'skipped' | 'pending' | 'in_progress' | 'warning';

export const STAGE_STATUSES: readonly StageStatus[] = ['ok', 'failed', 'skipped', 'pending', 'in_progress', 'warning'];

/** Nhãn trạng thái (đi kèm icon ở UI — không bao giờ chỉ có màu). */
export const STAGE_STATUS_LABELS: Record<StageStatus, string> = {
  ok: 'Thành công',
  failed: 'Thất bại',
  skipped: 'Bỏ qua',
  pending: 'Chờ',
  in_progress: 'Đang chạy',
  warning: 'Cảnh báo',
};

export type StageAction = 'replay_delivery' | 'renormalize' | 'open_dlq' | 'open_config';

/**
 * Catalog lý do. `endpoint_unverified`, `source_filtered` đến từ đợt đa service — khai báo sẵn,
 * trước khi đa service merge chúng không bao giờ xuất hiện.
 */
export const REASON_CODES = {
  signature_invalid: 'Chữ ký không hợp lệ — hub trả 401, không lưu sự kiện',
  duplicate: 'Trùng — đã nhận trước đó, hub trả ACK duplicate',
  rate_limited: 'Vượt tần suất cho phép',
  schema_mismatch: 'Dữ liệu sai khuôn kiểu chuẩn (lỗi vĩnh viễn)',
  normalize_dlq: 'Normalize thất bại — raw event mồ côi, nằm trong DLQ normalize',
  normalize_skipped: 'Adapter không sinh event nào từ raw event này',
  unmapped_type: 'Kiểu chưa ánh xạ vào catalog — data giữ nguyên dạng { raw }',
  no_subscription: 'Không có subscription nào khớp kiểu sự kiện',
  subscription_inactive: 'Subscription khớp kiểu nhưng đang tắt',
  endpoint_unverified: 'Endpoint chưa xác minh (challenge)',
  source_filtered: 'Subscription không nhận từ source này',
  http_5xx: 'Đích trả lỗi máy chủ (5xx)',
  http_4xx: 'Đích từ chối (4xx) — lỗi cấu hình, không thử lại',
  http_408: 'Đích hết thời gian chờ (408)',
  http_429: 'Đích báo quá tải (429)',
  timeout: 'Hết thời gian chờ (5s)',
  network_error: 'Lỗi mạng khi gọi đích',
  circuit_open: 'Circuit breaker đang mở — hoãn gửi, không tính một lần thử',
  throttled: 'Bị throttle — vượt RPS của đích',
  max_attempts: 'Hết lượt thử — delivery DEAD, nằm trong DLQ',
} as const;

export type ReasonCode = keyof typeof REASON_CODES;

export interface StageReason {
  code: ReasonCode;
  message: string;
}

export interface StageView {
  /** Id node ổn định (dùng làm key React Flow): `received`, `<deliveryId>:attempt:2`… */
  id: string;
  key: StageKey;
  status: StageStatus;
  startedAt: string | null; // ISO
  endedAt: string | null;
  durationMs: number | null;
  /** ms từ lúc nhận (received) tới `endedAt` — nhãn `+Xms` trên cạnh và trục waterfall. */
  offsetMs: number | null;
  title: string; // "Chữ ký PayOS hợp lệ"
  /** Dòng phụ ngắn dưới tiêu đề node (vd "HTTP 500 · 84ms", "thử lại lúc 10:08:00"). */
  subtitle?: string;
  reason?: StageReason;
  /** Dữ liệu panel "Vào/Ra/Chi tiết" — ĐÃ che bí mật ở server. */
  detail?: Record<string, unknown>;
  actions?: StageAction[];
  branchId?: string; // deliveryId, với chặng 'delivering' và 'done'
}

/** Trường tuỳ chọn để đợt đa service điền mà không đổi hình dạng (SPEC §6). */
export interface MultiServiceOptionalFields {
  projectId?: string;
  verification?: 'PENDING' | 'VERIFIED' | 'FAILED';
  sourceIds?: string[];
}

export interface FlowDestinationRef extends MultiServiceOptionalFields {
  id: string;
  name: string;
  type: string;
}

export interface FlowBranchHistory {
  deliveryId: string;
  generation: number;
  status: string;
  attemptCount: number;
  lastError: string | null;
  createdAt: string;
}

export interface FlowBranch {
  deliveryId: string;
  subscription: { id: string; name: string; eventTypes: string[] };
  destination: FlowDestinationRef;
  generation: number;
  /** Trạng thái cuối của nhánh (= status của node `done`). */
  status: StageStatus;
  stages: StageView[];
  /** Các generation cũ hơn của cùng (event, subscription) — UI gập lại. */
  history: FlowBranchHistory[];
}

/** Một chấm của "đường ống mini" (V2). Chặng `delivering` gộp mọi nhánh: `okCount/total`. */
export interface FlowSummaryDot {
  stage: StageKey;
  status: StageStatus;
  okCount?: number;
  total?: number;
}

export interface FlowFailedAt {
  stage: StageKey;
  reason: StageReason;
  destinationName?: string;
  attemptNo?: number;
  maxAttempts?: number;
  httpStatus?: number | null;
}

export type ExecutionStatus = 'succeeded' | 'failed' | 'in_progress' | 'rejected';

export const EXECUTION_STATUSES: readonly ExecutionStatus[] = ['in_progress', 'failed', 'rejected', 'succeeded'];

/** 1 lần đầu + 5 tầng retry (libs/messaging RETRY_TIERS). Service truyền giá trị thật vào builder. */
export const DEFAULT_RETRY_TIER_TTLS_MS: readonly number[] = [10_000, 60_000, 300_000, 1_800_000, 7_200_000];

/** Raw event ACCEPTED phải "nguội" bao lâu mới tính là mồ côi (khớp ORPHAN_MIN_AGE_SECONDS). */
export const DEFAULT_ORPHAN_MIN_AGE_SECONDS = 120;

/** Không bao giờ trả body lớn hơn mức này ra UI (SPEC §3). */
export const FLOW_BODY_MAX_BYTES = 16 * 1024;

export function formatTierLabel(ttlMs: number): string {
  if (ttlMs % 3_600_000 === 0) return `${ttlMs / 3_600_000}h`;
  if (ttlMs % 60_000 === 0) return `${ttlMs / 60_000}m`;
  return `${Math.round(ttlMs / 1000)}s`;
}
