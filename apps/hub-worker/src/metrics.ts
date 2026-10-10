import { Counter, Registry } from 'prom-client';

/**
 * Chỉ số Prometheus của hub-worker — đếm TRONG BỘ NHỚ (không chạm Redis, giữ ngân sách R1).
 * S3-4 phục vụ registry này qua `/metrics` trên `WORKER_METRICS_PORT`.
 */
export const workerRegistry = new Registry();

/** S3-2 (U45): adapter phát kiểu dành riêng (`payment.*`, `repo.*`) mà `data` sai khuôn catalog. */
export const normalizeSchemaErrors = new Counter({
  name: 'hub_normalize_schema_errors_total',
  help: 'Số event thuộc không gian dành riêng bị validator catalog từ chối (lỗi normalize vĩnh viễn)',
  labelNames: ['source'] as const,
  registers: [workerRegistry],
});
