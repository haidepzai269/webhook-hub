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
