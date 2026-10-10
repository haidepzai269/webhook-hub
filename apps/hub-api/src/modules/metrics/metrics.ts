import { Counter, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

/**
 * Chỉ số Prometheus của hub-api (S3-4). Đếm TRONG BỘ NHỚ của tiến trình — 0 lệnh Redis (ngân sách R1).
 * Registry riêng (không dùng registry toàn cục) để test độc lập.
 */
export const apiRegistry = new Registry();
collectDefaultMetrics({ register: apiRegistry });

export const ingestRequests = new Counter({
  name: 'hub_ingest_requests_total',
  help: 'Số request webhook vào /hooks theo provider và kết quả',
  labelNames: ['provider', 'outcome'] as const,
  registers: [apiRegistry],
});

export const ingestDuration = new Histogram({
  name: 'hub_ingest_duration_seconds',
  help: 'Thời gian xử lý một request /hooks (nhận -> COMMIT -> ACK)',
  labelNames: ['provider'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
  registers: [apiRegistry],
});
