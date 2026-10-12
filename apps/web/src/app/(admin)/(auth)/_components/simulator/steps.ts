/**
 * Dữ liệu mô phỏng "một webhook đi qua hub" (panel trái trang đăng nhập) — ĐÚNG theo code thật, không bịa.
 * Mỗi bước trỏ về file + ký hiệu nguồn; `steps.spec.ts` kiểm file tồn tại và chứa ký hiệu (chống lệch khi code đổi).
 *
 * NGOẠI LỆ i18n CÓ CHỦ Ý: nhãn vi/en nằm ngay trong file này thay vì `lib/i18n/messages`. Module chỉ được `import()`
 * khi người dùng bấm "Mô phỏng" → ~60 chuỗi dài không làm phình từ điển chính (tải ở MỌI trang admin). Chọn ngôn ngữ
 * theo `useLocale()`. File là TS thuần (không React, không alias `@/`) để jest gốc import thẳng.
 */

export type Lang = "vi" | "en";
export type Bi = Readonly<Record<Lang, string>>;

export type Component = "provider" | "hub-api" | "postgres" | "redis" | "rabbitmq" | "hub-worker" | "service";

/**
 * Chặng của màn Hành trình (journey-canvas, `StageKey` của @hub/flow) — 21 bước chi tiết gom vào 7 chặng thô.
 * Khai báo lại chuỗi (không import @hub/flow) để file thuần, jest gốc import được; simulator.tsx kiểm kiểu khớp StageKey.
 */
export type JourneyStage = "received" | "verified" | "persisted" | "normalized" | "routed" | "delivering" | "done";

export interface Step {
  id: string;
  label: Bi;
  detail: Bi;
  component: Component;
  journey: JourneyStage;
  source: { file: string; symbol: string };
  /** Nguồn phụ (cũng được test chống lệch kiểm). */
  also?: readonly { file: string; symbol: string }[];
}

const INGEST_SVC = "apps/hub-api/src/modules/ingest/ingest.service.ts";
const PAYOS = "libs/providers/src/payos.adapter.ts";
const REDIS_SVC = "apps/hub-api/src/modules/redis/redis.service.ts";
const RELAY = "apps/hub-worker/src/scheduler/outbox.relay.ts";
const TOPOLOGY = "libs/messaging/src/topology.ts";
const NORMALIZE = "apps/hub-worker/src/consumers/normalize.consumer.ts";
const DELIVERY = "apps/hub-worker/src/consumers/delivery.consumer.ts";

/** 21 bước đường thành công PayOS → hub → Shop (kịch bản `ok`), đúng thứ tự trong code. */
export const MAIN_STEPS: readonly Step[] = [
  {
    id: "provider-post",
    label: { vi: "Provider gửi webhook", en: "Provider sends webhook" },
    detail: {
      vi: "PayOS gọi POST /hooks/payos/:sourceKey; rawBody được giữ nguyên từng byte.",
      en: "PayOS calls POST /hooks/payos/:sourceKey; rawBody is kept byte-for-byte.",
    },
    component: "provider",
    journey: "received",
    source: { file: "apps/hub-api/src/modules/ingest/ingest.controller.ts", symbol: "async handleWebhook(" },
  },
  {
    id: "size-check",
    label: { vi: "Kiểm kích thước", en: "Payload size check" },
    detail: {
      vi: "rawBody > 1 MiB → 413; provider không có adapter trong ProviderRegistry → 400.",
      en: "rawBody > 1 MiB → 413; a provider with no adapter in ProviderRegistry → 400.",
    },
    component: "hub-api",
    journey: "received",
    source: { file: INGEST_SVC, symbol: "req.rawBody.length > MAX_INGEST_PAYLOAD_BYTES" },
  },
  {
    id: "load-source",
    label: { vi: "Nạp nguồn", en: "Load source" },
    detail: {
      vi: "findSourceBySourceKeyForIngest — nguồn không có, đã tắt hoặc đã lưu trữ → 404.",
      en: "findSourceBySourceKeyForIngest — missing, disabled or archived source → 404.",
    },
    component: "postgres",
    journey: "received",
    source: { file: INGEST_SVC, symbol: "findSourceBySourceKeyForIngest(req.sourceKey)" },
  },
  {
    id: "rate-limit",
    label: { vi: "Giới hạn tần suất", en: "Rate limit" },
    detail: {
      vi: "EVAL Lua trên khoá rate:source:{sourceId}, mặc định 100/phút → 429; Redis lỗi thì cho qua (fail-open).",
      en: "Lua EVAL on rate:source:{sourceId}, default 100/min → 429; if Redis fails, let it through (fail-open).",
    },
    component: "redis",
    journey: "received",
    source: { file: REDIS_SVC, symbol: "async checkRateLimit(" },
  },
  {
    id: "verify-signature",
    label: { vi: "Xác thực chữ ký", en: "Verify signature" },
    detail: {
      vi: "Giải mã secret, tính chữ ký từ body.data bằng checksumKey, so với body.signature bằng timingSafeEqual.",
      en: "Decrypt the secret, sign body.data with checksumKey, compare to body.signature with timingSafeEqual.",
    },
    component: "hub-api",
    journey: "verified",
    source: { file: PAYOS, symbol: "async verify(" },
  },
  {
    id: "redact-extract",
    label: { vi: "Che header, lấy khoá", en: "Redact, extract key" },
    detail: {
      vi: "redactHeaders; khoá chống trùng = payos:{orderCode}:{reference | paymentLinkId | bodyHashKey(rawBody)}.",
      en: "redactHeaders; dedup key = payos:{orderCode}:{reference | paymentLinkId | bodyHashKey(rawBody)}.",
    },
    component: "hub-api",
    journey: "persisted",
    source: { file: PAYOS, symbol: "extractIdempotencyKey(req: RawWebhookRequest)" },
  },
  {
    id: "redis-fast-dedup",
    label: { vi: "Kiểm trùng nhanh", en: "Fast dedup check" },
    detail: {
      vi: "GET idem:{sourceId}:{key} — trượt, đi tiếp vào Postgres.",
      en: "GET idem:{sourceId}:{key} — miss, continue to Postgres.",
    },
    component: "redis",
    journey: "persisted",
    source: { file: INGEST_SVC, symbol: "this.redis.getIdempotencyKey(" },
  },
  {
    id: "tx-raw-outbox",
    label: { vi: "Lưu raw + outbox", en: "Persist raw + outbox" },
    detail: {
      vi: "Một transaction: INSERT raw_events (ACCEPTED, UNIQUE source_id + idempotency_key) + INSERT outbox → COMMIT.",
      en: "One transaction: INSERT raw_events (ACCEPTED, UNIQUE source_id + idempotency_key) + INSERT outbox → COMMIT.",
    },
    component: "postgres",
    journey: "persisted",
    source: { file: INGEST_SVC, symbol: "tx.outbox.create({ data: { topic: 'event.received'" },
  },
  {
    id: "redis-set-nx",
    label: { vi: "Ghi khoá trùng", en: "Set idem key" },
    detail: {
      vi: "SAU COMMIT: SET idem:{sourceId}:{key} <rawEventId> EX 86400 NX — lỗi thì bỏ qua.",
      en: "AFTER COMMIT: SET idem:{sourceId}:{key} <rawEventId> EX 86400 NX — errors are ignored.",
    },
    component: "redis",
    journey: "persisted",
    source: { file: INGEST_SVC, symbol: "this.redis.setIdempotencyKey(" },
  },
  {
    id: "ack-provider",
    label: { vi: "Trả ACK", en: "Ack provider" },
    detail: {
      vi: "buildAck → 200 với body PayOS {code:'00', desc:'success', data:null}.",
      en: "buildAck → 200 with PayOS body {code:'00', desc:'success', data:null}.",
    },
    component: "hub-api",
    journey: "persisted",
    source: { file: PAYOS, symbol: "buildAck(result: IngestResult)" },
  },
  {
    id: "outbox-relay",
    label: { vi: "Relay đẩy outbox", en: "Outbox relay publish" },
    detail: {
      vi: "~500ms: SELECT outbox chưa publish FOR UPDATE SKIP LOCKED → x.hub.events/event.received, chờ confirm.",
      en: "~500ms: SELECT unpublished outbox FOR UPDATE SKIP LOCKED → x.hub.events/event.received, await confirm.",
    },
    component: "hub-worker",
    journey: "normalized",
    source: { file: RELAY, symbol: "async relayBatch(" },
  },
  {
    id: "queue-normalize",
    label: { vi: "Vào hàng normalize", en: "Normalize queue" },
    detail: {
      vi: "q.normalize (DLX x.hub.normalize.dlx → q.normalize.dlq), prefetch 20.",
      en: "q.normalize (DLX x.hub.normalize.dlx → q.normalize.dlq), prefetch 20.",
    },
    component: "rabbitmq",
    journey: "normalized",
    source: { file: TOPOLOGY, symbol: "NORMALIZE: 'q.normalize'" },
  },
  {
    id: "normalize",
    label: { vi: "Chuẩn hoá sự kiện", en: "Normalize event" },
    detail: {
      vi: "Nạp raw_event, adapter.normalize → payment.received (code '00'), assertCanonical theo catalog.",
      en: "Load raw_event, adapter.normalize → payment.received (code '00'), assertCanonical against the catalog.",
    },
    component: "hub-worker",
    journey: "normalized",
    source: { file: NORMALIZE, symbol: "assertCanonical(normalizedEvents" },
  },
  {
    id: "fan-out",
    label: { vi: "Phân phối theo đăng ký", en: "Fan-out subscriptions" },
    detail: {
      vi: "Transaction: INSERT events; mỗi subscription khớp → INSERT deliveries (PENDING) + outbox delivery.requested.",
      en: "Transaction: INSERT events; each matching subscription → INSERT deliveries (PENDING) + outbox delivery.requested.",
    },
    component: "postgres",
    journey: "routed",
    // QT4b (ADR-187): định tuyến tách sang route-event.ts — dùng chung cho event provider và event của hub.
    source: { file: "apps/hub-worker/src/consumers/route-event.ts", symbol: "repoTx.findActiveSubscriptionsForEvent(" },
  },
  {
    id: "realtime-notify",
    label: { vi: "Báo dashboard", en: "Notify dashboard" },
    detail: {
      vi: "PUBLISH hub:realtime:events — best-effort, lỗi không ảnh hưởng luồng chính.",
      en: "PUBLISH hub:realtime:events — best-effort, failures don't affect the main path.",
    },
    component: "redis",
    journey: "routed",
    source: { file: NORMALIZE, symbol: "publish('hub:realtime:events'" },
  },
  {
    id: "relay-delivery",
    label: { vi: "Relay đẩy giao", en: "Relay delivery msg" },
    detail: {
      vi: "Relay đẩy delivery.requested → x.hub.delivery/deliver → q.delivery.main.",
      en: "Relay publishes delivery.requested → x.hub.delivery/deliver → q.delivery.main.",
    },
    component: "rabbitmq",
    journey: "routed",
    source: { file: RELAY, symbol: "'delivery.requested': { exchange: EXCHANGES.DELIVERY" },
  },
  // 17 → 18 → 19 đúng thứ tự trong delivery.consumer.ts: findDeliveryForSend → circuitBreaker.getState → claimForSend.
  {
    id: "load-delivery",
    label: { vi: "Nạp delivery", en: "Load delivery" },
    detail: {
      vi: "findDeliveryForSend — nạp delivery, đích, subscription; chống xử lý lặp qua processed_messages.",
      en: "findDeliveryForSend — load delivery, destination, subscription; processed_messages guards replays.",
    },
    component: "hub-worker",
    journey: "delivering",
    source: { file: DELIVERY, symbol: "repo.findDeliveryForSend(" },
  },
  {
    id: "circuit-check",
    label: { vi: "Kiểm cầu dao", en: "Circuit check" },
    detail: {
      vi: "MGET circuit:{destinationId}… — CLOSED nên đi tiếp.",
      en: "MGET circuit:{destinationId}… — CLOSED, so continue.",
    },
    component: "redis",
    journey: "delivering",
    source: { file: DELIVERY, symbol: "this.circuitBreaker.getState(" },
  },
  {
    id: "sign-send",
    label: { vi: "Giữ chỗ, ký và gửi", en: "Lease, sign and send" },
    detail: {
      vi: "claimForSend → DELIVERING (lease 60s); chặn SSRF, timeout 5000ms; header webhook-id, webhook-timestamp, webhook-signature: v1,<HMAC-SHA256>.",
      en: "claimForSend → DELIVERING (60s lease); SSRF guard, 5000ms timeout; headers webhook-id, webhook-timestamp, webhook-signature: v1,<HMAC-SHA256>.",
    },
    component: "hub-worker",
    journey: "delivering",
    source: { file: DELIVERY, symbol: "repo.claimForSend(" },
    also: [{ file: "libs/crypto/src/standard-webhooks.ts", symbol: "export function swSign(" }],
  },
  {
    id: "service-verify",
    label: { vi: "Service kiểm chữ ký", en: "Service verifies" },
    detail: {
      vi: "Shop POST /hub-webhook: verifyWebhook (timingSafeEqual, lệch ≤300s), chống trùng theo webhook-id → 200.",
      en: "Shop POST /hub-webhook: verifyWebhook (timingSafeEqual, skew ≤300s), dedup by webhook-id → 200.",
    },
    component: "service",
    journey: "delivering",
    source: { file: "apps/shop/src/main.ts", symbol: "verifyWebhook(req.rawBody" },
  },
  {
    id: "record-attempt",
    label: { vi: "Ghi kết quả", en: "Record attempt" },
    detail: {
      vi: "Transaction: INSERT delivery_attempts, deliveries.status = SUCCEEDED; PUBLISH hub:realtime:deliveries; ack.",
      en: "Transaction: INSERT delivery_attempts, deliveries.status = SUCCEEDED; PUBLISH hub:realtime:deliveries; ack.",
    },
    component: "postgres",
    journey: "done",
    source: { file: DELIVERY, symbol: "tx.deliveryAttempt.create(" },
  },
];

/** Bước rẽ nhánh — chỉ xuất hiện trong kịch bản lỗi/trùng (mô tả trong catalog, mục "Nhánh"). */
export const BRANCH_STEPS: readonly Step[] = [
  {
    id: "store-rejected",
    label: { vi: "Chữ ký sai → lưu mẫu, 401", en: "Bad signature → sample, 401" },
    detail: {
      vi: "Lưu mẫu raw_events REJECTED, signatureValid=false (≤4KB, ≤20 mẫu/phút) → 401 {code:'01'}. Không outbox, không worker.",
      en: "Store a REJECTED raw_events sample, signatureValid=false (≤4KB, ≤20/min) → 401 {code:'01'}. No outbox, no worker.",
    },
    component: "hub-api",
    journey: "verified",
    source: { file: INGEST_SVC, symbol: "private async storeRejected(" },
  },
  {
    id: "ack-duplicate",
    label: { vi: "Trúng khoá → 200 trùng", en: "Key hit → 200 duplicate" },
    detail: {
      vi: "GET idem:… trúng → buildAck({isDuplicate:true}) → 200 {desc:'success duplicate ignored'}, không ghi DB.",
      en: "GET idem:… hit → buildAck({isDuplicate:true}) → 200 {desc:'success duplicate ignored'}, no DB touched.",
    },
    component: "hub-api",
    journey: "persisted",
    source: { file: PAYOS, symbol: "if (result.isDuplicate)" },
  },
  {
    id: "retry-tier",
    label: { vi: "Shop 503 → xếp hàng thử lại", en: "Shop 503 → queue retry" },
    detail: {
      vi: "Ghi attempt lỗi, delivery RETRYING + nextAttemptAt; sendToQueue tầng retry, hết TTL dead-letter về x.hub.delivery/deliver.",
      en: "Record failed attempt, delivery RETRYING + nextAttemptAt; sendToQueue a retry tier, on TTL dead-letter to x.hub.delivery/deliver.",
    },
    component: "rabbitmq",
    journey: "delivering",
    source: { file: DELIVERY, symbol: "getNextRetryQueue(currentAttemptNo)" },
  },
  {
    id: "dead-letter",
    label: { vi: "Hết lượt → DEAD", en: "Exhausted → DEAD" },
    detail: {
      vi: "deliveries.status = DEAD ('Hết 5 lần retry') + bản sao lên x.hub.delivery.dlx/dead → q.delivery.dlq.",
      en: "deliveries.status = DEAD ('Hết 5 lần retry') + a copy to x.hub.delivery.dlx/dead → q.delivery.dlq.",
    },
    component: "postgres",
    journey: "done",
    source: { file: DELIVERY, symbol: "channel.publish(EXCHANGES.DELIVERY_DLX, ROUTING_KEYS.DEAD" },
  },
];

export const ALL_STEPS: readonly Step[] = [...MAIN_STEPS, ...BRANCH_STEPS];
const BY_ID = new Map(ALL_STEPS.map((s) => [s.id, s]));
export const stepById = (id: string): Step => {
  const s = BY_ID.get(id);
  if (!s) throw new Error(`Bước không tồn tại: ${id}`);
  return s;
};

/** Một khung hình của kịch bản: bước + (tuỳ chọn) tông lỗi / ghi chú riêng (vd. lần gửi thứ mấy). */
export interface Frame {
  id: string;
  /** fail = chặng đỏ; warn = dừng có chủ đích (trùng lặp). */
  tone?: "fail" | "warn";
  note?: Bi;
  /** Ghi đè mô tả mặc định của bước khi kịch bản rẽ khác (vd. trùng khoá, Shop 503) — caption không tự mâu thuẫn. */
  detail?: Bi;
  /** Bước retry: lần gửi thứ mấy vừa nhận 503 (để vẽ chip lần thử trên node delivery). */
  attempt?: number;
}

export type ScenarioId = "ok" | "bad-signature" | "duplicate" | "service-5xx";

export interface Scenario {
  id: ScenarioId;
  label: Bi;
  frames: readonly Frame[];
  /** Ghi đè tiêu đề node chặng theo kịch bản (vd. trùng lặp: không có COMMIT). */
  titles?: Partial<Record<JourneyStage, Bi>>;
  outcome: { tone: "ok" | "fail"; text: Bi; note?: Bi };
}

const ids = (from: number, to: number): Frame[] => MAIN_STEPS.slice(from - 1, to).map((s) => ({ id: s.id }));

// Tầng retry THẬT (topology.ts RETRY_TIERS) — mô phỏng thu gọn mỗi tầng thành một khung ~900ms.
export const RETRY_LABELS = ["10s", "1m", "5m", "30m", "2h"] as const;
const retryFrames: Frame[] = RETRY_LABELS.flatMap((tier, i) => [
  {
    id: "retry-tier",
    tone: "fail" as const,
    attempt: i + 1,
    note: {
      vi: `Lần gửi ${i + 1}/6 → 503 → q.delivery.retry.${tier}`,
      en: `Send ${i + 1}/6 → 503 → q.delivery.retry.${tier}`,
    },
  },
]);

const SHOP_503: Bi = {
  vi: "Shop POST /hub-webhook trả 503 → lần gửi này thất bại (5xx tính vào circuit).",
  en: "Shop POST /hub-webhook returns 503 → this send fails (5xx counts toward the circuit).",
};

export const SCENARIOS: readonly Scenario[] = [
  {
    id: "ok",
    label: { vi: "Thành công", en: "Success" },
    frames: ids(1, 21),
    outcome: { tone: "ok", text: { vi: "200 · delivered", en: "200 · delivered" } },
  },
  {
    id: "bad-signature",
    label: { vi: "Chữ ký sai", en: "Bad signature" },
    frames: [
      ...ids(1, 4),
      {
        id: "verify-signature",
        tone: "fail",
        detail: {
          vi: "Tính lại chữ ký từ body.data bằng checksumKey, so bằng timingSafeEqual — không khớp với secret nào.",
          en: "Recompute the signature from body.data with checksumKey, compare with timingSafeEqual — matches no secret.",
        },
      },
      { id: "store-rejected", tone: "fail" },
    ],
    titles: { verified: { vi: "Chữ ký không khớp · 401", en: "Signature mismatch · 401" } },
    outcome: {
      tone: "fail",
      text: { vi: "401 · rejected, không vào outbox", en: "401 · rejected, never enters the outbox" },
    },
  },
  {
    id: "duplicate",
    label: { vi: "Trùng lặp", en: "Duplicate" },
    frames: [
      ...ids(1, 6),
      {
        id: "redis-fast-dedup",
        note: { vi: "GET idem:… trúng", en: "GET idem:… hit" },
        detail: {
          vi: "GET idem:{sourceId}:{key} — trúng: sự kiện này đã được nhận trước đó, trả trùng ngay.",
          en: "GET idem:{sourceId}:{key} — hit: this event was already accepted, answer duplicate right away.",
        },
      },
      { id: "ack-duplicate", tone: "warn" },
    ],
    titles: { persisted: { vi: "idem hit · không ghi DB", en: "idem hit · no DB write" } },
    outcome: {
      tone: "ok",
      text: { vi: "200 · duplicate ignored", en: "200 · duplicate ignored" },
      note: {
        vi: "BB-2: Redis mất khoá → INSERT gặp UNIQUE (Prisma P2002) → ROLLBACK → vẫn 200 duplicate. Postgres là trọng tài.",
        en: "BB-2: if Redis loses the key, INSERT hits UNIQUE (Prisma P2002) → ROLLBACK → still 200 duplicate. Postgres decides.",
      },
    },
  },
  {
    id: "service-5xx",
    label: { vi: "Service 5xx", en: "Service 5xx" },
    frames: [
      ...ids(1, 19),
      { id: "service-verify", tone: "fail", note: { vi: "Shop trả 503", en: "Shop returns 503" }, detail: SHOP_503 },
      ...retryFrames,
      { id: "sign-send", note: { vi: "Lần gửi 6/6", en: "Send 6/6" } },
      {
        id: "service-verify",
        tone: "fail",
        note: { vi: "Shop vẫn trả 503", en: "Shop still returns 503" },
        detail: SHOP_503,
      },
      { id: "dead-letter", tone: "fail" },
    ],
    outcome: {
      tone: "fail",
      text: { vi: "DEAD sau 6 lần gửi → q.delivery.dlq", en: "DEAD after 6 sends → q.delivery.dlq" },
      note: {
        vi: "Thời gian thật: 10s → 1m → 5m → 30m → 2h (mô phỏng đã thu gọn).",
        en: "Real timing: 10s → 1m → 5m → 30m → 2h (compressed in this simulation).",
      },
    },
  },
];

/** Chữ của bộ điều khiển — cùng lý do ngoại lệ i18n như trên (chỉ tải khi bấm). */
export const UI: Readonly<Record<string, Bi>> = {
  region: { vi: "Mô phỏng một webhook", en: "Webhook simulation" },
  scenario: { vi: "Kịch bản", en: "Scenario" },
  play: { vi: "Chạy", en: "Play" },
  pause: { vi: "Tạm dừng", en: "Pause" },
  next: { vi: "Tiếp", en: "Next" },
  exit: { vi: "Thoát mô phỏng", en: "Exit simulation" },
  result: { vi: "Kết quả", en: "Result" },
  canvas: { vi: "Hành trình của sự kiện mô phỏng", en: "Journey of the simulated event" },
  step: { vi: "Bước", en: "Step" },
  replay: { vi: "Chạy lại", en: "Replay" },
};

/** Tiêu đề node từng chặng trên màn Hành trình (thay cho "tiêu đề do server viết"). Không có số đo giả. */
export const JOURNEY_TITLES: Readonly<Record<JourneyStage, Bi>> = {
  received: { vi: "POST /hooks/payos", en: "POST /hooks/payos" },
  verified: { vi: "Chữ ký PayOS · timingSafeEqual", en: "PayOS signature · timingSafeEqual" },
  persisted: { vi: "raw_events + outbox · COMMIT", en: "raw_events + outbox · COMMIT" },
  normalized: { vi: "payment.received", en: "payment.received" },
  routed: { vi: "1 subscription → shop", en: "1 subscription → shop" },
  delivering: { vi: "Đang giao tới shop", en: "Delivering to shop" },
  done: { vi: "Kết thúc", en: "Finished" },
};
