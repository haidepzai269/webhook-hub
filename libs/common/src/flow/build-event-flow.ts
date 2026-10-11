/**
 * `buildEventFlow(rows) → { stages, branches, summary, … }` — trái tim của SPEC-event-flow-ui §2.
 *
 * Hàm THUẦN: vào là các dòng DB đã nạp (raw_event, event, deliveries + attempts, subscription bị bỏ
 * qua), ra là hành trình đã quyết định trạng thái. Mỗi trạng thái DB ánh xạ về ĐÚNG MỘT StageStatus.
 * UI chỉ vẽ kết quả này — không tự ghép trạng thái ở client.
 */
import {
  DEFAULT_ORPHAN_MIN_AGE_SECONDS,
  DEFAULT_RETRY_TIER_TTLS_MS,
  ExecutionStatus,
  FLOW_BODY_MAX_BYTES,
  FlowBranch,
  FlowFailedAt,
  FlowSummaryDot,
  ReasonCode,
  REASON_CODES,
  StageAction,
  StageKey,
  StageReason,
  StageStatus,
  StageView,
  formatTierLabel,
} from './stages';

export type RawStatusInput = 'ACCEPTED' | 'REJECTED' | 'DUPLICATE';
export type DeliveryStatusInput = 'PENDING' | 'DELIVERING' | 'RETRYING' | 'SUCCEEDED' | 'DEAD';
export type CircuitStateInput = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

type DateLike = Date | string;

export interface FlowRawInput {
  id: string;
  status: RawStatusInput;
  signatureValid: boolean;
  receivedAt: DateLike;
  provider: string;
  sourceId: string;
  sourceName: string;
  contentType?: string | null;
  idempotencyKey?: string | null;
  /** Header đã che ở lúc lưu (ADR-051). Có thể vắng ở danh sách (V2). */
  headers?: Record<string, unknown> | null;
  /** Body đã parse (jsonb). Có thể vắng ở danh sách (V2). */
  body?: unknown;
  /** Độ dài `body_raw` (bytes). */
  bodyBytes?: number | null;
  /** Có `processed_messages(consumer='normalize', message_id=raw.id)` — adapter đã chạy xong. */
  normalizeProcessed: boolean;
}

export interface FlowEventInput {
  id: string;
  type: string;
  source: string;
  subject?: string | null;
  normalized: boolean;
  origin: string;
  correlationId: string;
  receivedAt: DateLike;
  occurredAt?: DateLike | null;
  data?: unknown;
  /**
   * `events.probe` (ADR-159): request kiểm tra kết nối của chính provider — lưu nhưng cố ý KHÔNG định tuyến.
   * Lõi chỉ đọc cờ chung, không biết provider nào (BB-1).
   */
  probe?: boolean;
}

export interface FlowAttemptInput {
  attemptNo: number;
  responseStatus: number | null;
  durationMs: number | null;
  error: string | null;
  responseBody?: string | null;
  /** Body đã gửi (template đã render) — không chứa secret (token/URL đích nằm ở cấu hình mã hoá). */
  requestBody?: unknown;
  createdAt: DateLike;
}

export interface FlowDeliveryInput {
  id: string;
  attemptGeneration: number;
  status: DeliveryStatusInput;
  attemptCount: number;
  nextAttemptAt: DateLike | null;
  lastError: string | null;
  createdAt: DateLike;
  updatedAt: DateLike;
  subscription: { id: string; name: string; eventTypes: string[] };
  destination: {
    id: string;
    name: string;
    type: string;
    circuitState?: CircuitStateInput | null;
    rateLimitRps?: number | null;
    verification?: 'PENDING' | 'VERIFIED' | 'FAILED' | null;
  };
  /** Mọi attempt (V1) hoặc chỉ attempt cuối (V2). */
  attempts: FlowAttemptInput[];
}

export interface FlowSkippedSubscriptionInput {
  id: string;
  name: string;
  eventTypes: string[];
  reason: Extract<ReasonCode, 'subscription_inactive' | 'endpoint_unverified' | 'source_filtered'>;
}

/**
 * Subscription KHỚP kiểu sự kiện (đọc lúc xem). Trường tuỳ chọn = cột của đợt đa service (SPEC §6A):
 * khi chưa có cột thì để `undefined` và nhánh lý do tương ứng không chạy.
 */
export interface FlowCandidateSubscriptionInput {
  id: string;
  name: string;
  eventTypes: string[];
  isActive: boolean;
  /** `subscriptions.source_ids` (đa service). Rỗng/undefined = nhận mọi source. */
  sourceIds?: string[] | null;
  /** `destinations.verification` (đa service). undefined = chưa có cột → coi như đã xác minh. */
  destinationVerification?: 'PENDING' | 'VERIFIED' | 'FAILED' | null;
}

/**
 * Chặng `routed` tự tính lúc đọc (SPEC §6A): subscription khớp type mà KHÔNG có delivery → bỏ qua kèm
 * lý do theo TRẠNG THÁI HIỆN TẠI của cấu hình (không phải trạng thái lúc event tới — UI ghi rõ nhãn này).
 * Thứ tự ưu tiên: tắt → endpoint chưa xác minh → lọc theo source.
 */
export function classifySkippedSubscriptions(
  candidates: FlowCandidateSubscriptionInput[],
  deliveredSubscriptionIds: Iterable<string>,
  eventSourceId: string | null | undefined,
): FlowSkippedSubscriptionInput[] {
  const delivered = new Set(deliveredSubscriptionIds);
  const out: FlowSkippedSubscriptionInput[] = [];
  for (const c of candidates) {
    if (delivered.has(c.id)) continue;
    let r: FlowSkippedSubscriptionInput['reason'] | null = null;
    if (!c.isActive) r = 'subscription_inactive';
    else if (c.destinationVerification && c.destinationVerification !== 'VERIFIED') r = 'endpoint_unverified';
    else if (c.sourceIds && c.sourceIds.length > 0 && eventSourceId && !c.sourceIds.includes(eventSourceId)) r = 'source_filtered';
    if (r) out.push({ id: c.id, name: c.name, eventTypes: c.eventTypes, reason: r });
  }
  return out;
}

export interface EventFlowInput {
  raw: FlowRawInput | null;
  event: FlowEventInput | null;
  deliveries: FlowDeliveryInput[];
  skippedSubscriptions?: FlowSkippedSubscriptionInput[];
  now?: Date;
  /** TTL các tầng retry, tăng dần (RETRY_TIERS). Số lần thử tối đa = length + 1. */
  retryTierTtlsMs?: readonly number[];
  orphanMinAgeSeconds?: number;
}

export interface EventFlow {
  stages: StageView[];
  branches: FlowBranch[];
  summary: FlowSummaryDot[];
  executionStatus: ExecutionStatus;
  failedAt: FlowFailedAt | null;
}

const PROVIDER_LABELS: Record<string, string> = {
  payos: 'PayOS',
  sepay: 'SePay',
  github: 'GitHub',
  stripe: 'Stripe',
  api: 'API',
  generic: 'Generic',
};

/** Nguồn `api` (service tự publish, đa service) xác thực bằng API key, không phải chữ ký webhook. */
function credentialLabel(provider: string): string {
  return provider === 'api' ? 'API key' : 'Chữ ký';
}

export function providerLabel(p: string): string {
  return PROVIDER_LABELS[p] ?? p;
}

function iso(d: DateLike | null | undefined): string | null {
  if (d === null || d === undefined) return null;
  const date = d instanceof Date ? d : new Date(d);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function ms(d: DateLike | null | undefined): number | null {
  const s = iso(d);
  return s === null ? null : Date.parse(s);
}

function reason(code: ReasonCode, specific?: string): StageReason {
  return { code, message: specific ? `${specific} — ${REASON_CODES[code]}` : REASON_CODES[code] };
}

function utf8Bytes(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

/** Body ra UI: > 16KB thì cắt và gắn cờ `truncated` (SPEC §3). */
export function limitBody(body: unknown, maxBytes = FLOW_BODY_MAX_BYTES): { value: unknown; truncated: boolean; bytes: number } {
  if (body === undefined || body === null) return { value: null, truncated: false, bytes: 0 };
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  const bytes = utf8Bytes(text ?? '');
  if (bytes <= maxBytes) return { value: body, truncated: false, bytes };
  // Cắt theo ký tự với biên an toàn: mỗi ký tự ≤ 4 byte → maxBytes/4 ký tự luôn ≤ maxBytes;
  // rồi nới dần tới sát trần (đủ tốt cho bản xem trước, không cần chính xác từng byte).
  let cut = text.slice(0, maxBytes);
  while (utf8Bytes(cut) > maxBytes) cut = cut.slice(0, Math.floor(cut.length * 0.9));
  return { value: cut, truncated: true, bytes };
}

/** Lý do của MỘT attempt thất bại (null = 2xx). */
export function attemptReason(a: Pick<FlowAttemptInput, 'responseStatus' | 'error'>): StageReason | null {
  const s = a.responseStatus ?? 0;
  if (s >= 200 && s < 300) return null;
  const err = a.error ?? '';
  if (/circuit/i.test(err)) return reason('circuit_open', err.slice(0, 160));
  if (s === 408) return reason('http_408', 'HTTP 408');
  if (s === 429) return reason('http_429', 'HTTP 429');
  if (s >= 500) return reason('http_5xx', `HTTP ${s}`);
  if (s >= 400) return reason('http_4xx', `HTTP ${s}`);
  if (/timeout|timed out|abort/i.test(err)) return reason('timeout');
  return reason('network_error', err ? err.slice(0, 160) : undefined);
}

/** Lỗi 4xx (trừ 408/429) là non-retryable → DEAD ngay (khớp delivery.consumer). */
function isNonRetryable(status: number | null | undefined): boolean {
  const s = status ?? 0;
  return s >= 400 && s < 500 && s !== 408 && s !== 429;
}

interface StageDraft extends Omit<StageView, 'offsetMs' | 'durationMs'> {
  durationMs?: number | null;
}

/** Khung chặng mặc định — gom chỗ tính offset/duration về một nơi. */
function finalize(drafts: StageDraft[], origin: number | null): StageView[] {
  return drafts.map((d) => {
    const end = ms(d.endedAt);
    const start = ms(d.startedAt);
    const durationMs = d.durationMs !== undefined ? d.durationMs : start !== null && end !== null ? Math.max(0, end - start) : null;
    return { ...d, durationMs, offsetMs: origin !== null && end !== null ? Math.max(0, end - origin) : null };
  });
}

function stripMeta(headers: Record<string, unknown> | null | undefined) {
  if (!headers) return { headers: null as Record<string, unknown> | null, meta: null as unknown };
  const { __hub_meta: meta, ...rest } = headers as Record<string, unknown> & { __hub_meta?: unknown };
  return { headers: rest, meta: meta ?? null };
}

// --------------------------------------------------------------------------------------------
// Nhánh delivery
// --------------------------------------------------------------------------------------------

function buildBranch(
  d: FlowDeliveryInput,
  history: FlowDeliveryInput[],
  tiers: readonly number[],
  now: number,
  origin: number | null,
): FlowBranch {
  const maxAttempts = tiers.length + 1;
  const circuit = d.destination.circuitState ?? 'CLOSED';
  const throttleRps = d.destination.rateLimitRps ?? 0;
  const attempts = [...d.attempts].sort((a, b) => a.attemptNo - b.attemptNo);
  const drafts: StageDraft[] = [];

  drafts.push({
    id: `${d.id}:queued`,
    key: 'delivering',
    status: 'ok',
    startedAt: iso(d.createdAt),
    endedAt: iso(d.createdAt),
    durationMs: 0,
    title: `Delivery → ${d.destination.name}`,
    subtitle: `${d.subscription.name} · gen ${d.attemptGeneration}`,
    branchId: d.id,
    detail: {
      deliveryId: d.id,
      generation: d.attemptGeneration,
      subscription: d.subscription,
      destination: { id: d.destination.id, name: d.destination.name, type: d.destination.type },
      circuitState: circuit,
      throttleRps,
      maxAttempts,
      verification: d.destination.verification ?? null,
    },
  });

  for (const a of attempts) {
    const r = attemptReason(a);
    const end = ms(a.createdAt);
    const start = end !== null && a.durationMs !== null ? end - a.durationMs : end;
    const retryable = r !== null && !isNonRetryable(a.responseStatus);
    const nextTierMs = retryable && a.attemptNo <= tiers.length ? tiers[a.attemptNo - 1] : null;
    drafts.push({
      id: `${d.id}:attempt:${a.attemptNo}`,
      key: 'delivering',
      status: r ? 'failed' : 'ok',
      startedAt: start !== null ? new Date(start).toISOString() : null,
      endedAt: iso(a.createdAt),
      durationMs: a.durationMs,
      title: `Lần ${a.attemptNo}/${maxAttempts}`,
      subtitle: `${a.responseStatus ? `HTTP ${a.responseStatus}` : 'không phản hồi'}${a.durationMs !== null ? ` · ${a.durationMs}ms` : ''}`,
      reason: r ?? undefined,
      branchId: d.id,
      detail: {
        attemptNo: a.attemptNo,
        maxAttempts,
        httpStatus: a.responseStatus,
        durationMs: a.durationMs,
        error: a.error,
        response: a.responseBody ?? null,
        request: a.requestBody !== undefined ? limitBody(a.requestBody).value : null,
        retryable: r ? retryable : null,
        nextTier: nextTierMs !== null ? formatTierLabel(nextTierMs) : null,
      },
    });
  }

  // Đang gửi (lease DELIVERING) → node attempt kế tiếp đang chạy.
  if (d.status === 'DELIVERING') {
    drafts.push({
      id: `${d.id}:attempt:${d.attemptCount + 1}`,
      key: 'delivering',
      status: 'in_progress',
      startedAt: iso(d.updatedAt),
      endedAt: null,
      durationMs: null,
      title: `Lần ${d.attemptCount + 1}/${maxAttempts}`,
      subtitle: 'đang gửi…',
      branchId: d.id,
      detail: { attemptNo: d.attemptCount + 1, maxAttempts },
    });
  }

  const last = attempts[attempts.length - 1];
  const lastReason = last ? attemptReason(last) : null;
  const nextAt = iso(d.nextAttemptAt);
  const nextAtMs = ms(d.nextAttemptAt);
  const done: StageDraft = {
    id: `${d.id}:done`,
    key: 'done',
    status: 'pending',
    startedAt: null,
    endedAt: null,
    durationMs: null,
    title: '',
    branchId: d.id,
  };

  switch (d.status) {
    case 'SUCCEEDED':
      Object.assign(done, {
        status: 'ok',
        title: `${d.destination.name} nhận ${last?.responseStatus ? `HTTP ${last.responseStatus}` : 'thành công'}`,
        subtitle: `sau ${d.attemptCount} lần thử`,
        startedAt: iso(d.updatedAt),
        endedAt: iso(d.updatedAt),
        durationMs: 0,
        detail: { status: d.status, attempts: d.attemptCount },
      });
      break;
    case 'DEAD': {
      const nonRetry = last ? isNonRetryable(last.responseStatus) : false;
      Object.assign(done, {
        status: 'failed',
        title: 'DEAD — nằm trong DLQ',
        subtitle: nonRetry ? 'lỗi 4xx, không thử lại' : `hết ${maxAttempts} lần thử`,
        reason: nonRetry && lastReason ? lastReason : reason('max_attempts', `Lần ${d.attemptCount}/${maxAttempts}`),
        actions: ['replay_delivery', 'open_dlq'] as StageAction[],
        startedAt: iso(d.updatedAt),
        endedAt: iso(d.updatedAt),
        durationMs: 0,
        detail: { status: d.status, lastError: d.lastError, attempts: d.attemptCount },
      });
      break;
    }
    case 'RETRYING':
    case 'PENDING': {
      // Hoãn vì circuit (S2-1): PENDING mà có next_attempt_at, hoặc RETRYING khi circuit đích không CLOSED.
      const deferred = (d.status === 'PENDING' && nextAt !== null) || (d.status === 'RETRYING' && circuit !== 'CLOSED');
      if (deferred) {
        const tierMs = d.status === 'RETRYING' && d.attemptCount >= 1 && d.attemptCount <= tiers.length ? tiers[d.attemptCount - 1] : null;
        Object.assign(done, {
          status: 'warning',
          title: d.status === 'RETRYING' ? `Chờ thử lại lần ${d.attemptCount + 1}/${maxAttempts}` : 'Hoãn — circuit đang mở',
          subtitle: `circuit ${circuit} · hoãn gửi`,
          reason: reason('circuit_open', `Circuit ${circuit}`),
          detail: {
            status: d.status,
            deferred: true,
            circuitState: circuit,
            nextAttemptAt: nextAt,
            tier: tierMs !== null ? formatTierLabel(tierMs) : null,
            attempts: d.attemptCount,
            maxAttempts,
            lastError: d.lastError,
          },
        });
      } else if (d.status === 'RETRYING') {
        const tierMs = d.attemptCount >= 1 && d.attemptCount <= tiers.length ? tiers[d.attemptCount - 1] : null;
        const tier = tierMs !== null ? formatTierLabel(tierMs) : null;
        Object.assign(done, {
          status: 'warning',
          title: `Chờ thử lại lần ${d.attemptCount + 1}/${maxAttempts}`,
          subtitle: tier ? `tầng ${tier}` : undefined,
          reason: lastReason ?? undefined,
          detail: {
            status: d.status,
            nextAttemptAt: nextAt,
            tier,
            attempts: d.attemptCount,
            maxAttempts,
            lastError: d.lastError,
            // Quá hạn > 60s mà chưa thử lại: sweeper sẽ đẩy lại (§5.1) — UI ghi "quá hạn", không đếm âm.
            overdue: nextAtMs !== null && nextAtMs < now - 60_000,
          },
        });
      } else {
        Object.assign(done, {
          status: 'in_progress',
          title: 'Chờ worker nhận',
          subtitle: 'PENDING',
          detail: { status: d.status, attempts: d.attemptCount },
        });
      }
      break;
    }
    case 'DELIVERING':
      Object.assign(done, {
        status: 'in_progress',
        title: 'Đang gửi',
        subtitle: 'DELIVERING',
        detail: { status: d.status, attempts: d.attemptCount },
      });
      break;
  }
  drafts.push(done);

  return {
    deliveryId: d.id,
    subscription: d.subscription,
    destination: { id: d.destination.id, name: d.destination.name, type: d.destination.type },
    generation: d.attemptGeneration,
    status: done.status,
    stages: finalize(drafts, origin),
    history: history
      .sort((a, b) => b.attemptGeneration - a.attemptGeneration)
      .map((h) => ({
        deliveryId: h.id,
        generation: h.attemptGeneration,
        status: h.status,
        attemptCount: h.attemptCount,
        lastError: h.lastError,
        createdAt: iso(h.createdAt) ?? '',
      })),
  };
}

// --------------------------------------------------------------------------------------------
// Hành trình
// --------------------------------------------------------------------------------------------

export function buildEventFlow(input: EventFlowInput): EventFlow {
  const now = (input.now ?? new Date()).getTime();
  const tiers = input.retryTierTtlsMs ?? DEFAULT_RETRY_TIER_TTLS_MS;
  const orphanAgeMs = (input.orphanMinAgeSeconds ?? DEFAULT_ORPHAN_MIN_AGE_SECONDS) * 1000;
  const { raw, event } = input;
  const origin = ms(raw?.receivedAt ?? event?.receivedAt ?? null);
  const drafts: StageDraft[] = [];
  /** Hành trình dừng hẳn (không còn chặng nào sẽ chạy) — chặng sau trong summary là 'skipped'. */
  let terminal = false;

  if (raw) {
    const prov = providerLabel(raw.provider);
    const { headers, meta } = stripMeta(raw.headers);
    const body = raw.body !== undefined ? limitBody(raw.body) : null;
    const at = iso(raw.receivedAt);
    drafts.push({
      id: 'received',
      key: 'received',
      status: 'ok',
      startedAt: at,
      endedAt: at,
      durationMs: 0,
      title: raw.provider === 'api' ? 'Service publish /v1/p/…/events' : `${prov} gọi /hooks`,
      subtitle: raw.sourceName,
      detail: {
        provider: raw.provider,
        sourceId: raw.sourceId,
        sourceName: raw.sourceName,
        rawEventId: raw.id,
        correlationId: event?.correlationId ?? null,
        contentType: raw.contentType ?? null,
        bytes: raw.bodyBytes ?? null,
        idempotencyKey: raw.idempotencyKey ?? null,
        headers,
        body: body?.value ?? null,
        bodyTruncated: body?.truncated ?? false,
        rejectedSample: meta,
      },
    });

    if (raw.status === 'REJECTED' || !raw.signatureValid) {
      drafts.push({
        id: 'verified',
        key: 'verified',
        status: 'failed',
        startedAt: at,
        endedAt: at,
        durationMs: 0,
        title: raw.provider === 'api' ? 'API key KHÔNG hợp lệ' : `${credentialLabel(raw.provider)} ${prov} KHÔNG hợp lệ`,
        subtitle: 'hub trả 401',
        reason: reason('signature_invalid'),
        actions: ['open_config'],
        detail: { signatureValid: false, httpStatus: 401, sampleOnly: true },
      });
      terminal = true;
    } else {
      drafts.push({
        id: 'verified',
        key: 'verified',
        status: 'ok',
        startedAt: at,
        endedAt: at,
        durationMs: 0,
        title: raw.provider === 'api' ? 'API key hợp lệ' : `${credentialLabel(raw.provider)} ${prov} hợp lệ`,
        detail: { signatureValid: true },
      });
      if (raw.status === 'DUPLICATE') {
        drafts.push({
          id: 'persisted',
          key: 'persisted',
          status: 'skipped',
          startedAt: at,
          endedAt: at,
          durationMs: 0,
          title: 'Trùng — không lưu lại',
          reason: reason('duplicate'),
          detail: { idempotencyKey: raw.idempotencyKey ?? null },
        });
        terminal = true;
      } else {
        drafts.push({
          id: 'persisted',
          key: 'persisted',
          status: 'ok',
          startedAt: at,
          endedAt: at,
          durationMs: 0,
          title: 'Đã COMMIT raw_event + outbox',
          subtitle: 'ACK 200 sau COMMIT (BB-3)',
          detail: { rawEventId: raw.id, idempotencyKey: raw.idempotencyKey ?? null, httpStatus: 200 },
        });
      }
    }
  }

  // Normalize + route chạy trong CÙNG một transaction (ARCHITECTURE §3.2) và `events.received_at` là
  // bản sao thời điểm nhận raw (không phải lúc normalize) → mốc kết thúc thật của normalize/route là
  // `created_at` của delivery generation đầu. Không có delivery thì DB không lưu mốc → để null, không bịa.
  const firstDeliveryAt = input.deliveries.length
    ? iso(input.deliveries.reduce((m, d) => (ms(d.createdAt)! < ms(m.createdAt)! ? d : m)).createdAt)
    : null;

  if (!terminal) {
    if (event) {
      const unmapped = event.normalized === false;
      drafts.push({
        id: 'normalized',
        key: 'normalized',
        status: unmapped ? 'warning' : 'ok',
        startedAt: iso(raw?.receivedAt ?? event.receivedAt),
        endedAt: firstDeliveryAt,
        title: unmapped ? `Chưa ánh xạ: ${event.type}` : `Normalize ra ${event.type}`,
        subtitle: event.subject ?? undefined,
        reason: unmapped ? reason('unmapped_type') : undefined,
        detail: {
          eventId: event.id,
          type: event.type,
          subject: event.subject ?? null,
          normalized: event.normalized,
          origin: event.origin,
          correlationId: event.correlationId,
          occurredAt: iso(event.occurredAt ?? null),
          data: event.data !== undefined ? limitBody(event.data).value : undefined,
          dataTruncated: event.data !== undefined ? limitBody(event.data).truncated : undefined,
        },
      });
    } else if (raw && raw.status === 'ACCEPTED') {
      const age = origin !== null ? now - origin : 0;
      if (raw.normalizeProcessed) {
        drafts.push({
          id: 'normalized',
          key: 'normalized',
          status: 'skipped',
          startedAt: iso(raw.receivedAt),
          endedAt: null,
          title: 'Adapter không sinh event',
          reason: reason('normalize_skipped'),
        });
        terminal = true;
      } else if (age >= orphanAgeMs) {
        drafts.push({
          id: 'normalized',
          key: 'normalized',
          status: 'failed',
          startedAt: iso(raw.receivedAt),
          endedAt: null,
          title: 'Normalize thất bại',
          subtitle: 'raw event mồ côi',
          reason: reason('normalize_dlq'),
          actions: ['renormalize', 'open_dlq'],
          detail: { rawEventId: raw.id, ageSeconds: Math.round(age / 1000) },
        });
        terminal = true;
      } else {
        drafts.push({
          id: 'normalized',
          key: 'normalized',
          status: 'in_progress',
          startedAt: iso(raw.receivedAt),
          endedAt: null,
          title: 'Đang normalize',
          subtitle: 'outbox → q.normalize',
        });
      }
    }
  }

  // --- Định tuyến + nhánh ---
  const latest = new Map<string, FlowDeliveryInput>();
  const older = new Map<string, FlowDeliveryInput[]>();
  for (const d of input.deliveries) {
    const cur = latest.get(d.subscription.id);
    if (!cur || d.attemptGeneration > cur.attemptGeneration) {
      if (cur) older.set(d.subscription.id, [...(older.get(d.subscription.id) ?? []), cur]);
      latest.set(d.subscription.id, d);
    } else {
      older.set(d.subscription.id, [...(older.get(d.subscription.id) ?? []), d]);
    }
  }
  const branches = [...latest.values()]
    .sort((a, b) => a.destination.name.localeCompare(b.destination.name) || a.subscription.name.localeCompare(b.subscription.name))
    .map((d) => buildBranch(d, older.get(d.subscription.id) ?? [], tiers, now, origin));

  if (!terminal && event) {
    const skipped = input.skippedSubscriptions ?? [];
    const routedAt = firstDeliveryAt;
    const matched = branches.length;
    // Probe (L-A1): không có delivery là CỐ Ý — không phải thiếu/tắt subscription, nên không gợi ý sửa cấu hình.
    const probe = event.probe === true && matched === 0;
    drafts.push({
      id: 'routed',
      key: 'routed',
      status: matched > 0 ? 'ok' : 'skipped',
      startedAt: routedAt,
      endedAt: routedAt,
      title: matched > 0 ? `Khớp ${matched} subscription` : probe ? 'Không định tuyến — sự kiện kiểm tra' : 'Không subscription nào nhận',
      subtitle: skipped.length ? `bỏ qua ${skipped.length}` : undefined,
      reason: matched > 0 ? undefined : probe ? reason('provider_probe') : reason(skipped[0]?.reason ?? 'no_subscription'),
      actions: matched > 0 || probe ? undefined : ['open_config'],
      detail: {
        matched: branches.map((b) => ({ subscription: b.subscription, destination: b.destination })),
        skipped: skipped.map((s) => ({ id: s.id, name: s.name, eventTypes: s.eventTypes, reason: reason(s.reason) })),
        // Lý do bỏ qua tính từ cấu hình LÚC XEM (SPEC §6A) — có thể khác lúc event tới.
        skippedBasis: skipped.length ? 'trạng thái hiện tại' : undefined,
      },
    });
    if (matched === 0) terminal = true;
  }

  const stages = finalize(drafts, origin);
  const summary = summarize(stages, branches, terminal);
  const executionStatus = deriveExecutionStatus(raw, stages, branches);
  const failedAt = deriveFailedAt(stages, branches, tiers.length + 1);
  return { stages, branches, summary, executionStatus, failedAt };
}

// --------------------------------------------------------------------------------------------
// Tóm tắt (V2) — cùng nguồn với hành trình đầy đủ
// --------------------------------------------------------------------------------------------

const SUMMARY_STAGES: StageKey[] = ['received', 'verified', 'persisted', 'normalized', 'routed', 'delivering'];

function aggregateBranches(branches: FlowBranch[]): StageStatus {
  const st = branches.map((b) => b.status);
  if (st.includes('failed')) return 'failed';
  if (st.includes('warning')) return 'warning';
  if (st.includes('in_progress') || st.includes('pending')) return 'in_progress';
  return 'ok';
}

function summarize(stages: StageView[], branches: FlowBranch[], terminal: boolean): FlowSummaryDot[] {
  return SUMMARY_STAGES.map((key) => {
    if (key === 'delivering') {
      if (branches.length === 0) return { stage: key, status: terminal ? 'skipped' : 'pending', okCount: 0, total: 0 };
      return {
        stage: key,
        status: aggregateBranches(branches),
        okCount: branches.filter((b) => b.status === 'ok').length,
        total: branches.length,
      };
    }
    const s = stages.find((x) => x.key === key);
    return { stage: key, status: s ? s.status : terminal ? 'skipped' : 'pending' };
  });
}

function deriveExecutionStatus(raw: FlowRawInput | null, stages: StageView[], branches: FlowBranch[]): ExecutionStatus {
  if (raw && (raw.status === 'REJECTED' || !raw.signatureValid)) return 'rejected';
  if (stages.some((s) => s.status === 'failed')) return 'failed';
  if (branches.some((b) => b.status === 'failed')) return 'failed';
  if (stages.some((s) => s.status === 'in_progress' || s.status === 'pending')) return 'in_progress';
  if (branches.some((b) => b.status !== 'ok')) return 'in_progress';
  return 'succeeded';
}

function branchFailure(b: FlowBranch, maxAttempts: number, retrying: boolean): FlowFailedAt {
  const done = b.stages[b.stages.length - 1];
  const lastAttempt = [...b.stages].reverse().find((s) => s.id.includes(':attempt:') && s.status === 'failed');
  const r = lastAttempt?.reason ?? done.reason ?? reason('max_attempts');
  const attemptNo = (lastAttempt?.detail?.attemptNo as number | undefined) ?? undefined;
  return {
    stage: 'delivering',
    reason: retrying && done.reason?.code === 'circuit_open' ? done.reason : r,
    destinationName: b.destination.name,
    attemptNo,
    maxAttempts,
    httpStatus: (lastAttempt?.detail?.httpStatus as number | null | undefined) ?? null,
  };
}

/** "Hỏng ở": chặng lỗi đầu tiên; không có thì nhánh đang chờ thử lại (warning). */
function deriveFailedAt(stages: StageView[], branches: FlowBranch[], maxAttempts: number): FlowFailedAt | null {
  const failedStage = stages.find((s) => s.status === 'failed');
  if (failedStage && failedStage.reason) return { stage: failedStage.key, reason: failedStage.reason };
  const failedBranch = branches.find((b) => b.status === 'failed');
  if (failedBranch) return branchFailure(failedBranch, maxAttempts, false);
  const warnBranch = branches.find((b) => b.status === 'warning');
  if (warnBranch) return branchFailure(warnBranch, maxAttempts, true);
  return null;
}
