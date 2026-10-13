import * as http from 'http';
import { bearerAuthorized } from '@hub/crypto';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

/**
 * Chỉ số Prometheus của hub-worker — đếm TRONG BỘ NHỚ (không chạm Redis, giữ ngân sách R1).
 * S3-4 phục vụ registry này qua `/metrics` trên `WORKER_METRICS_PORT`.
 */
export const workerRegistry = new Registry();
collectDefaultMetrics({ register: workerRegistry });

/** S3-2 (U45): adapter phát kiểu dành riêng (`payment.*`, `repo.*`) mà `data` sai khuôn catalog. */
export const normalizeSchemaErrors = new Counter({
  name: 'hub_normalize_schema_errors_total',
  help: 'Số event thuộc không gian dành riêng bị validator catalog từ chối (lỗi normalize vĩnh viễn)',
  labelNames: ['source'] as const,
  registers: [workerRegistry],
});

/** Kết quả mỗi lần gửi đã ghi DB: SUCCEEDED / RETRYING / DEAD (không tính lần hoãn vì circuit). */
export const deliveriesTotal = new Counter({
  name: 'hub_deliveries_total',
  help: 'Số lần gửi tới đích theo loại đích và kết quả',
  labelNames: ['destination_type', 'status'] as const,
  registers: [workerRegistry],
});

export const deliveryDuration = new Histogram({
  name: 'hub_delivery_duration_seconds',
  help: 'Thời gian một lần gọi đích (sender)',
  labelNames: ['destination_type'] as const,
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [workerRegistry],
});

/**
 * R-4 (ADR-119): trọn thời gian xử lý MỘT message delivery ở worker (đọc DB, claim, gọi đích, ghi kết quả, ack) —
 * đo chi phí transaction theo RLS trên đường giao; bucket mịn ở dải vài ms.
 */
export const deliveryHandleDuration = new Histogram({
  name: 'hub_delivery_handle_seconds',
  help: 'Thời gian worker xử lý một message delivery (DB + gọi đích + ghi kết quả)',
  buckets: [0.005, 0.01, 0.015, 0.02, 0.03, 0.05, 0.075, 0.1, 0.25, 0.5, 1, 5],
  registers: [workerRegistry],
});

/** Chỉ đếm lần đổi trạng thái mà worker này ghi được vào DB (UPDATE có điều kiện) — không đếm trùng giữa nhiều worker. */
export const circuitTransitions = new Counter({
  name: 'hub_circuit_transitions_total',
  help: 'Số lần circuit breaker đổi trạng thái theo trạng thái đích',
  labelNames: ['to'] as const,
  registers: [workerRegistry],
});

/** Tuổi (giây) của dòng outbox chưa publish CŨ NHẤT mà relay thấy ở lượt gần nhất; 0 khi rỗng. */
export const outboxLag = new Gauge({
  name: 'hub_outbox_lag_seconds',
  help: 'Tuổi của dòng outbox chưa publish lâu nhất (đo mỗi lượt relay)',
  registers: [workerRegistry],
});

/**
 * BP1 (ADR-195): lỗi hạ tầng/lỗi lạ ở delivery consumer bị bắt ở `catch` ngoài cùng — `kind` = transient | unknown.
 * Mỗi lần đếm là một lần hoãn có nhịp (retry.10s / retry.1m), không bao giờ requeue ngay.
 */
export const deliveryInfraErrors = new Counter({
  name: 'hub_delivery_infra_errors_total',
  help: 'Số lần delivery consumer gặp lỗi hạ tầng (transient) hoặc lỗi lạ (unknown) và hoãn message',
  labelNames: ['kind'] as const,
  registers: [workerRegistry],
});

/** BP5 (ADR-200, §7.6): hệ số lùi của bộ điều khiển áp lực ngược theo phụ thuộc (0 = chạy hết tốc, 1 = chế độ dò). */
export const backpressureFactor = new Gauge({
  name: 'hub_backpressure_factor',
  help: 'Hệ số lùi của bộ điều khiển áp lực ngược (0..1) theo phụ thuộc hạ tầng của hub',
  labelNames: ['dependency'] as const,
  registers: [workerRegistry],
});

/** BP5: số message đang chờ permit trong tiến trình (unacked, chưa xử lý). */
export const backpressureHeld = new Gauge({
  name: 'hub_backpressure_held',
  help: 'Số message đang chờ permit của bộ điều khiển áp lực ngược',
  labelNames: ['consumer'] as const,
  registers: [workerRegistry],
});

/** BP5: message giữ quá BACKPRESSURE_HOLD_MAX_MS -> republish sang hàng hoãn KHÔNG đốt lượt. */
export const backpressureSpilled = new Counter({
  name: 'hub_backpressure_spilled_total',
  help: 'Số message giữ quá trần chờ permit, được đẩy sang hàng hoãn không đốt lượt',
  labelNames: ['consumer'] as const,
  registers: [workerRegistry],
});

/** BP5 §7.6: lần hoãn delivery KHÔNG đốt lượt theo lý do (circuit | throttle | ramp | infra). */
export const deliveriesDeferred = new Counter({
  name: 'hub_deliveries_deferred_total',
  help: 'Số lần hoãn delivery không đốt lượt theo lý do',
  labelNames: ['reason'] as const,
  registers: [workerRegistry],
});

/** BP5 §7.4: lỗi tạm ở normalize khi DB đang ốm -> retry.30s KHÔNG đốt lượt. */
export const normalizeDeferred = new Counter({
  name: 'hub_normalize_deferred_total',
  help: 'Số lần normalize gặp lỗi tạm khi bộ điều khiển áp lực ngược đang lùi và hoãn không đốt lượt',
  registers: [workerRegistry],
});

/** Lỗi tạm ở normalize được đẩy vào q.normalize.retry.30s (ADR-044). */
export const normalizeRetries = new Counter({
  name: 'hub_normalize_retries_total',
  help: 'Số lần normalize gặp lỗi tạm và được đưa vào hàng đợi thử lại',
  registers: [workerRegistry],
});

/**
 * CB2 (SPEC §5.1): số cảnh báo OPEN theo mức — đặt ở CUỐI mỗi lượt đánh giá trọn vẹn (tổng các project). Nhiều worker cùng
 * báo cùng một con số (mỗi worker tự đánh giá mọi project, D4) -> panel dùng `max`, không `sum`.
 */
export const alertsOpen = new Gauge({
  name: 'hub_alerts_open',
  help: 'Số cảnh báo đang OPEN theo mức (lượt đánh giá gần nhất của worker này)',
  labelNames: ['severity'] as const,
  registers: [workerRegistry],
});

/** CB2: chỉ đếm lần chuyển mà CHÍNH worker này ghi được (upsert tạo dòng mới / resolve đổi được dòng OPEN). */
export const alertTransitions = new Counter({
  name: 'hub_alert_transitions_total',
  help: 'Số lần cảnh báo đổi trạng thái theo luật',
  labelNames: ['rule', 'to'] as const,
  registers: [workerRegistry],
});

/** CB2: một luật ném lỗi (truy vấn/ghi) — log + đếm, các luật khác vẫn chạy. */
export const alertEvalErrors = new Counter({
  name: 'hub_alert_eval_errors_total',
  help: 'Số lần đánh giá một luật cảnh báo bị lỗi',
  labelNames: ['rule'] as const,
  registers: [workerRegistry],
});

/** CB5 (ADR-173): kết quả xử lý một email cảnh báo — sent | suppressed (trần 6/giờ, hết điều kiện) | retry | failed (3 lần). */
export const alertEmailsTotal = new Counter({
  name: 'hub_alert_emails_total',
  help: 'Số email cảnh báo theo kết quả của vòng gửi',
  labelNames: ['result'] as const,
  registers: [workerRegistry],
});

/**
 * HTTP server tối giản chỉ phục vụ `/metrics` (S3-4) — worker không có Nest HTTP. Cổng
 * `WORKER_METRICS_PORT` (mặc định 9101; `0` = tắt). Chỉ mở trong mạng nội bộ compose, không publish ra host.
 */
export function startMetricsServer(
  port = Number(process.env.WORKER_METRICS_PORT ?? 9101),
  token: string | undefined = process.env.METRICS_TOKEN,
): http.Server | null {
  if (!Number.isInteger(port) || port <= 0) return null;
  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && (req.url === '/metrics' || req.url?.startsWith('/metrics?'))) {
      // Review SPEC-3 #6: cùng luật với hub-api — METRICS_TOKEN đặt thì bắt buộc Bearer.
      if (!bearerAuthorized(req.headers.authorization, token)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end('{"error":"metrics_unauthorized"}');
        return;
      }
      res.writeHead(200, { 'Content-Type': workerRegistry.contentType });
      res.end(await workerRegistry.metrics());
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.listen(port);
  return server;
}

// ---------------------------------------------------------------- QT2 hạn mức dung lượng (ADR-183/185)

/** Dung lượng ƯỚC TÍNH theo project (cộng dồn E2). Nhãn = tenant id (số project nhỏ, có trần project/user). */
export const projectStorageBytes = new Gauge({
  name: 'hub_project_storage_bytes',
  help: 'Dung lượng ước tính của project (mốc hiệu chỉnh + bloat × byte cộng dồn − đã giải phóng)',
  labelNames: ['tenant'] as const,
  registers: [workerRegistry],
});

/** Số project đang ở LOCKED hoặc HARD_LOCKED (theo lượt cập nhật nấc gần nhất). */
export const projectStorageLocked = new Gauge({
  name: 'hub_project_storage_locked',
  help: 'Số project đang khoá chiều ghi vì đầy hạn mức (LOCKED + HARD_LOCKED)',
  registers: [workerRegistry],
});

export const storageLevelTransitions = new Counter({
  name: 'hub_project_storage_level_transitions_total',
  help: 'Số lần một project đổi nấc dung lượng',
  labelNames: ['from', 'to'] as const,
  registers: [workerRegistry],
});

export const storageCalibrations = new Counter({
  name: 'hub_project_storage_calibrations_total',
  help: 'Số lần hiệu chỉnh (quét thật) dung lượng project — result: ok | error | timeout',
  labelNames: ['result'] as const,
  registers: [workerRegistry],
});

/** §6 (ADR-185): kích thước database và cờ chốt toàn cục (≥ 80% DB_DISK_BUDGET_MB). */
export const dbSizeBytes = new Gauge({
  name: 'hub_db_size_bytes',
  help: 'pg_database_size(current_database()) — đọc tối đa 10 phút một lần',
  registers: [workerRegistry],
});
export const storageNearFull = new Gauge({
  name: 'hub_storage_near_full',
  help: '1 khi database vượt 80% DB_DISK_BUDGET_MB (chốt toàn cục cho người vận hành), 0 nếu không',
  registers: [workerRegistry],
});

// ---------------------------------------------------------------- QT4/QT5 dọn dẹp (ADR-184/186)

/** Byte giải phóng (công thức §2) theo đường dọn: manual (lệnh tay / áp gợi ý) | auto (policy) | retention (7 ngày). */
export const storageCleanFreedBytes = new Counter({
  name: 'hub_storage_clean_freed_bytes_total',
  help: 'Byte dung lượng (ước tính §2) đã giải phóng theo đường dọn',
  labelNames: ['trigger'] as const,
  registers: [workerRegistry],
});

/** Số lô dọn đã chạy — result: ok | error. */
export const storageCleanBatches = new Counter({
  name: 'hub_storage_clean_batches_total',
  help: 'Số lô dọn (mỗi lô một transaction ngắn) theo đường dọn và kết quả',
  labelNames: ['trigger', 'result'] as const,
  registers: [workerRegistry],
});

// ---------------------------------------------------------------- QT4b gợi ý dọn (ADR-187)

/** Gợi ý bị hàng rào `assertSuggestionSafe` loại (mức Cao/Giữ, olderThan quá mới, source Giữ lâu…) theo advisor. */
export const cleanupSuggestionsRejected = new Counter({
  name: 'hub_cleanup_suggestions_rejected_total',
  help: 'Số gợi ý dọn bị hàng rào an toàn loại, theo advisor',
  labelNames: ['advisor'] as const,
  registers: [workerRegistry],
});

/** Advisor ném lỗi / quá giờ -> fail-open về rules@1. */
export const cleanupAdvisorFailOpen = new Counter({
  name: 'hub_cleanup_advisor_fail_open_total',
  help: 'Số lần advisor gợi ý dọn lỗi/quá giờ và hub quay về rules@1',
  labelNames: ['advisor'] as const,
  registers: [workerRegistry],
});

/** Số webhook `hub.project.cleanup_suggested` đã ghi vào outbox — reason: level_up | changed. */
export const cleanupSuggestedEmitted = new Counter({
  name: 'hub_cleanup_suggested_emitted_total',
  help: 'Số event hub.project.cleanup_suggested đã phát (qua outbox)',
  labelNames: ['reason'] as const,
  registers: [workerRegistry],
});
