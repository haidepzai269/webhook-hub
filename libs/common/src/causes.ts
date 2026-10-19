import { classifyHttpOutcome } from './http-outcome';
import type { AlertRuleCode } from './alerts/rules';

/**
 * LOGGING.md §2 + §8 (ADR-250): BẢNG NGUYÊN NHÂN DUY NHẤT. Một enum đóng `<nhóm>.<tên>` (chữ thường + `_`, KHÔNG BAO GIỜ
 * chứa id/giá trị tự do) -> dùng được làm nhãn Prometheus. `error`/`reason` chỉ THAM CHIẾU `docs/ERRORS.md` (nguồn của
 * message/fix) và `REASON_CODES` (`flow/stages.ts`, console) — không chép chữ, không có catalog thứ ba. Test đồng bộ ở
 * `libs/common/test/causes.spec.ts`: thêm cause = điền đủ blame/next; thêm khoá REASON_CODES = tham chiếu hoặc `EXEMPT_REASONS`.
 *
 * blame: provider (bên gửi) | khach (cấu hình của khách) | dich (đích nhận) | hub (lỗi của hub) | ha_tang (Neon/Upstash/CloudAMQP/Render).
 * page: đáng đánh thức Admin. hubFault: hub (hoặc hạ tầng của hub) có thể là thủ phạm — cổng của Sentry (§11.1, đợt 2B).
 */
export const CAUSE_GROUPS = ['slow', 'wrong', 'fail', 'growth'] as const;
export type CauseGroup = (typeof CAUSE_GROUPS)[number];
export type Blame = 'provider' | 'khach' | 'dich' | 'hub' | 'ha_tang';

export interface CauseDef {
  group: CauseGroup;
  blame: Blame;
  hubFault: boolean;
  page: boolean;
  /** Bước kế cho người đọc log (triage) — tiếng Việt, ngắn. */
  next: string;
  /** Mã trong `docs/ERRORS.md` mà khách thấy (nếu có). */
  error?: string;
  /** Khoá trong `REASON_CODES` (`flow/stages.ts`, console) tương ứng (nếu có). */
  reason?: string;
}

const def = (
  group: CauseGroup,
  blame: Blame,
  page: boolean,
  next: string,
  extra: { error?: string; reason?: string; hubFault?: boolean } = {},
): CauseDef => ({
  group,
  blame,
  page,
  next,
  hubFault: extra.hubFault ?? (blame === 'hub' || blame === 'ha_tang'),
  ...(extra.error ? { error: extra.error } : {}),
  ...(extra.reason ? { reason: extra.reason } : {}),
});

export const CAUSES = {
  // ---- CHẬM ----
  'slow.destination': def('slow', 'dich', false, 'Xem destination_id; metric hub_delivery_duration_seconds{destination_type}; có thể sắp mở circuit'),
  'slow.db': def('slow', 'ha_tang', true, 'Neon chậm/pool cạn; hub_backpressure_factor{dependency="db"}; stage_ms.db_*'),
  'slow.redis': def('slow', 'ha_tang', false, 'Upstash quota/latency; hub vẫn đúng (BB-2: Redis chỉ làm chậm)'),
  'slow.queue_wait': def('slow', 'hub', true, 'Worker thiếu/bận: hub_backpressure_held, số consumer, độ sâu hàng đợi'),
  'slow.relay_lag': def('slow', 'hub', true, 'Relay kẹt/PG chậm/broker nack: hub_outbox_lag_seconds, heartbeat'),
  'slow.deferred_circuit': def('slow', 'dich', false, 'Đích đang hỏng (circuit OPEN) — xem fail.dest_* cùng destination_id'),
  'slow.deferred_throttle': def('slow', 'khach', false, 'Khách đặt rateLimitRps thấp / đang slow-start sau hồi phục; chủ ý'),
  'slow.deferred_backpressure': def('slow', 'hub', true, 'Hub tự giảm tải vì DB ốm: hub_backpressure_factor, hub_backpressure_spilled_total'),
  'slow.cold_start': def('slow', 'ha_tang', false, 'Instance vừa thức dậy (Render free ngủ); không tính vào p95; cân nhắc keep-alive'),
  'slow.hub_cpu': def('slow', 'hub', false, 'Hub bận CPU/GC hoặc không chặng nào chiếm ưu thế; xem hub_event_loop_lag_seconds'),

  // ---- SAI: bên gửi / chính sách ----
  'wrong.signature': def('wrong', 'provider', false, 'Xem source_id; secret đã rotate? Lặp nhiều sẽ vào hộp phạt', { reason: 'signature_invalid', hubFault: false }),
  'wrong.unknown_source': def('wrong', 'provider', false, 'URL cấu hình sai hoặc nguồn đã tắt; đếm theo IP (hộp phạt)', { error: 'unknown_source' }),
  'wrong.payload_shape': def('wrong', 'provider', false, 'Xem bytes, content_type, error; body rỗng/quá lớn/sai khuôn/method không nhận', { error: 'payload_too_large' }),
  'wrong.schema_mismatch': def('wrong', 'provider', true, 'Raw trong DLQ; so docs/EVENT-CATALOG.md; renormalize sau khi sửa adapter (nghi bug hub nếu provider không đổi khuôn)', { error: 'schema_mismatch', reason: 'schema_mismatch', hubFault: true }),
  'wrong.config_dest_4xx': def('wrong', 'khach', false, 'Khách sửa URL/auth đích; replay sau khi sửa', { reason: 'http_4xx' }),
  'wrong.policy_blocked': def('wrong', 'khach', false, 'Xem policy ở dòng log: penalty_box, rate_limit, storage_full, unverified_off…', { error: 'rate_limited', reason: 'rate_limited' }),
  'wrong.duplicate': def('wrong', 'provider', false, 'Bình thường (provider gửi lại); tăng vọt -> growth.dup_flood', { reason: 'duplicate' }),

  // ---- SAI: xử lý thất bại ----
  'fail.dest_5xx': def('fail', 'dich', false, 'Đích lỗi máy chủ; circuit sắp mở; xem fail.dest_* cùng destination_id', { reason: 'http_5xx' }),
  'fail.dest_timeout': def('fail', 'dich', false, 'Đích chậm/ngủ (5s); so slow.destination', { reason: 'timeout' }),
  'fail.dest_network': def('fail', 'dich', false, 'DNS/refused/TLS/reset khi gọi đích: đích sập hoặc URL sai', { reason: 'network_error' }),
  'fail.dest_overload': def('fail', 'dich', false, 'Đích báo 429: giảm rateLimitRps', { reason: 'http_429' }),
  'fail.exhausted': def('fail', 'dich', false, 'Hết 5 tầng retry -> DLQ; xem last_cause; replay khi đích khoẻ', { reason: 'max_attempts' }),
  'fail.hub_db': def('fail', 'ha_tang', true, 'Xem err.code; trạng thái Neon; backpressure tự giảm tải', { error: 'service_unavailable' }),
  'fail.hub_broker': def('fail', 'ha_tang', true, 'CloudAMQP: confirm nack/channel đóng/mất kết nối; relay rollback an toàn (at-least-once)'),
  'fail.hub_redis': def('fail', 'ha_tang', false, 'Upstash lỗi (fail-open, chỉ chậm — BB-2); kiểm quota'),
  'fail.hub_unknown': def('fail', 'hub', true, 'Lỗi lạ chưa phân loại (bug): xem err.class/code và stack ở log; vào DLQ sau N lần', { error: 'internal_error', reason: 'normalize_dlq' }),
  'fail.poison_message': def('fail', 'hub', true, 'Message hỏng (parse lỗi) -> bản sao DLQ x-dead-reason=parse_error; ai publish?'),

  // ---- TĂNG NHANH (log tổng hợp theo cửa sổ) ----
  'growth.burst_source': def('growth', 'provider', false, 'Xem source_id, tỉ lệ wrong.duplicate (provider bắn lặp?)'),
  'growth.dup_flood': def('growth', 'provider', false, 'Provider retry bão vì ACK chậm/không tới? Kiểm độ trễ ACK'),
  'growth.retry_storm': def('growth', 'dich', false, 'Một đích hỏng làm cả hàng đợi retry; xem circuit'),
  'growth.dlq_swell': def('growth', 'dich', false, 'Nhóm theo last_cause; nếu schema_mismatch/fail.hub_* thì page'),
  'growth.backlog': def('growth', 'hub', true, 'Độ sâu hàng đợi/outbox_lag tăng liên tục: thêm worker; slow.queue_wait đi kèm'),
  'growth.storage': def('growth', 'khach', true, 'storage-alerts; ai ghi nhiều (source_id); chính sách giữ'),
} as const satisfies Record<string, CauseDef>;

export type Cause = keyof typeof CAUSES;
export const CAUSE_LIST = Object.keys(CAUSES) as Cause[];

export function isCause(v: unknown): v is Cause {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(CAUSES, v);
}

/** Khoá `REASON_CODES` không có cause tương ứng — kèm LÝ DO (test đồng bộ (a) đòi một trong hai). */
export const EXEMPT_REASONS = {
  normalize_skipped: 'Trạng thái luồng của console (adapter không sinh event) — không phải sự cố, log normalize.done outcome=skipped',
  unmapped_type: 'Trạng thái luồng: kiểu chưa ánh xạ vẫn lưu data.raw — không phải lỗi, không có cause',
  no_subscription: 'Trạng thái luồng: không có subscription khớp — cấu hình, không phải lỗi xử lý',
  provider_probe: 'Request kiểm tra của chính provider, cố ý không định tuyến (ADR-159) — không phải lỗi',
  subscription_inactive: 'Trạng thái luồng: subscription tắt — ở log gộp vào wrong.policy_blocked (policy=subscription_inactive)',
  endpoint_unverified: 'Trạng thái luồng: endpoint chưa xác minh — ở log gộp vào wrong.policy_blocked (policy=endpoint_unverified)',
  source_filtered: 'Trạng thái luồng: subscription không nhận từ source này — cố ý lọc, không phải lỗi',
  unverified_source: 'Nhãn tin cậy của nguồn unverified (PK5) — không phải sự cố',
  unverified_not_accepted: 'Subscription chưa bật nhận sự kiện chưa xác thực — ở log gộp vào wrong.policy_blocked (policy=unverified_not_accepted)',
  http_408: 'Đích hết thời gian (408) — cùng cause fail.dest_timeout với khoá "timeout"',
  circuit_open: 'Hoãn có chủ đích vì circuit — ở log là slow.deferred_circuit (khoá REASON dùng cho trạng thái luồng, không tham chiếu một chiều)',
  throttled: 'Hoãn vì throttle — ở log là slow.deferred_throttle (khoá REASON dùng cho trạng thái luồng)',
} as const;

/**
 * Phân loại một lần giao thất bại tới đích -> cause. Hàm thuần theo (status, errorKind/error): sender hiện trả lỗi mạng/
 * timeout dưới dạng status 500 + chuỗi lỗi nên nhận ra bằng `error`. KHÔNG đọc body phản hồi của đích.
 */
export function causeOfSendFailure(r: { status?: number | null; error?: string | null; errorKind?: 'timeout' | 'network' | null }): Cause {
  const status = r.status ?? 0;
  const err = String(r.error ?? '');
  if (status === 0 && /circuit\s+(OPEN|HALF_OPEN)/i.test(err)) return 'slow.deferred_circuit';
  if (r.errorKind === 'timeout' || status === 408 || /timeout|ETIMEDOUT|AbortSignal|aborted/i.test(err)) return 'fail.dest_timeout';
  if (r.errorKind === 'network' || /ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|EPIPE|socket hang up|certificate|SSL|TLS|SSRF/i.test(err)) return 'fail.dest_network';
  switch (classifyHttpOutcome(status)) {
    case 'throttled':
      return 'fail.dest_overload';
    case 'auth_rejected':
    case 'client_error':
      return 'wrong.config_dest_4xx';
    case 'no_response':
      return 'fail.dest_network';
    default:
      return 'fail.dest_5xx';
  }
}

/**
 * Mapping luật cảnh báo cũ (`ALERT_RULES`, alert.evaluator) -> cause, để nối cảnh báo <-> log/metric (LOGGING.md §7).
 * `null` = luật mô tả sự IM LẶNG (không có dòng log nào để nối).
 */
const ALERT_RULE_CAUSES: Record<AlertRuleCode, Cause | null> = {
  'destination.auth_rejected': 'wrong.config_dest_4xx',
  'destination.client_error': 'wrong.config_dest_4xx',
  'destination.failing': 'fail.dest_5xx',
  'destination.circuit_open': 'slow.deferred_circuit',
  'delivery.dead_spike': 'growth.dlq_swell',
  'source.signature_failing': 'wrong.signature',
  'source.connection_broken': 'wrong.policy_blocked',
  'source.silent': null,
  'normalize.backlog': 'growth.backlog',
  'project.storage_warn': 'growth.storage',
  'project.storage_critical': 'growth.storage',
  'project.storage_locked': 'growth.storage',
  'hub.storage_near_full': 'growth.storage',
};

export function alertRuleCause(rule: string): Cause | null {
  return Object.prototype.hasOwnProperty.call(ALERT_RULE_CAUSES, rule) ? ALERT_RULE_CAUSES[rule as AlertRuleCode] : null;
}

/**
 * LOGGING.md §11.1 (ADR-251/258): cause "lỗi lạ chưa phân loại" — cổng của Sentry. Chỉ cause thuộc tập này VÀ có `blame === 'hub'`
 * mới được `reportUnexpected` đẩy đi. Lỗi đã biết tên (chữ ký sai, đích 5xx, DB/Redis/broker rớt tạm thời, schema_mismatch…) đã có log/metric/cảnh báo.
 */
export const SENTRY_CAUSES: ReadonlySet<Cause> = new Set<Cause>(['fail.hub_unknown', 'fail.poison_message']);
