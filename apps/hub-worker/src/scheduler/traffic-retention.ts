/**
 * EG4 (ADR-179): lưu lượng theo phút giữ 7 ngày (khối "Lưu lượng" xem tối đa 7 ngày). Kẹp 1–90. Tách khỏi cleanup.job.ts
 * (QT5) để storage.job.ts đọc được mà không tạo vòng import cleanup.job ↔ storage.job (cleanup job tiêm StorageJob).
 */
export const DEFAULT_TRAFFIC_RETENTION_DAYS = 7;
export function resolveTrafficRetentionDays(v: string | undefined = process.env.TRAFFIC_RETENTION_DAYS): number {
  const n = v === undefined || v === '' ? NaN : Number(v);
  if (!Number.isFinite(n)) return DEFAULT_TRAFFIC_RETENTION_DAYS;
  return Math.min(90, Math.max(1, Math.round(n)));
}
