/**
 * QT ĐÍNH CHÍNH E2 (ADR-183) + §6 (ADR-185): công thức dung lượng cộng dồn, hệ số phình, lịch hiệu chỉnh và chốt toàn cục.
 * Hàm THUẦN — job trong hub-worker gọi; test QT:T32/T14 khoá công thức.
 *
 *   used_bytes = calibrated_bytes + bloat_factor × Σ bytes(traffic sau mốc) − freed_since_calibration
 */
const DAY_MS = 86_400_000;

export const BLOAT_FACTOR_MIN = 1;
export const BLOAT_FACTOR_MAX = 4;
export const BLOAT_FACTOR_DEFAULT = 2;
/** Dưới mức này (tổng body_raw) thì chưa đủ dữ liệu để tin tỷ lệ -> dùng mặc định 2. */
export const BLOAT_MIN_SAMPLE_BYTES = 64 * 1024;

export interface UsageInputs {
  calibratedBytes: number;
  bloatFactor: number;
  /** Σ `source_traffic_minutely.bytes` của project với `minute > date_trunc('minute', calibrated_at)`. */
  trafficBytesSinceCalibration: number;
  freedSinceCalibration: number;
}

export function clampBloatFactor(x: number): number {
  if (!Number.isFinite(x)) return BLOAT_FACTOR_DEFAULT;
  return Math.min(BLOAT_FACTOR_MAX, Math.max(BLOAT_FACTOR_MIN, x));
}

/** E2: ước tính hiện tại — không âm, làm tròn byte. Số hỏng coi như 0 (hệ số hỏng -> mặc định). */
export function computeUsedBytes(i: UsageInputs): number {
  const n = (v: number) => (Number.isFinite(v) && v > 0 ? v : 0);
  return Math.max(0, Math.round(n(i.calibratedBytes) + clampBloatFactor(i.bloatFactor) * n(i.trafficBytesSinceCalibration) - n(i.freedSinceCalibration)));
}

/**
 * Hệ số phình đo ở lần hiệu chỉnh = (tổng dung lượng theo định nghĩa §2) / (tổng `octet_length(body_raw)`), kẹp [1, 4].
 * Ingest chỉ biết body_raw; `events.data`, `deliveries`, `delivery_attempts` sinh ra sau ở worker — không nhân hệ số thì
 * số cộng dồn luôn thấp hơn thật và khoá trễ.
 */
export function bloatFactorFrom(totalMeasuredBytes: number, totalBodyRawBytes: number): number {
  if (!Number.isFinite(totalMeasuredBytes) || !Number.isFinite(totalBodyRawBytes) || totalBodyRawBytes < BLOAT_MIN_SAMPLE_BYTES) return BLOAT_FACTOR_DEFAULT;
  return Math.round(clampBloatFactor(totalMeasuredBytes / totalBodyRawBytes) * 1000) / 1000;
}

/**
 * Mốc hiệu chỉnh nào CŨ HƠN thời điểm trả về thì phải hiệu chỉnh ở lượt này: theo chu kỳ (`intervalMs`), và BẮT BUỘC khi
 * mốc cũ hơn `TRAFFIC_RETENTION_DAYS − 1` ngày (bảng traffic sắp bị dọn mất phần sau mốc). Retention 1 ngày -> mọi lượt.
 */
export function calibrationDueBefore(now: number, intervalMs: number, trafficRetentionDays: number): Date {
  const retentionGuardMs = Math.max(0, (trafficRetentionDays - 1) * DAY_MS);
  return new Date(now - Math.min(intervalMs, retentionGuardMs));
}

/** "Còn ~X giờ" = (quota − used) / (bloat × Σ bytes 24h gần nhất / 24). Không tăng -> null (không dự báo được). */
export function forecastHours(usedBytes: number, quotaBytes: number, bloatFactor: number, trafficBytesLast24h: number): number | null {
  const perHour = (clampBloatFactor(bloatFactor) * Math.max(0, trafficBytesLast24h)) / 24;
  if (!(perHour > 0)) return null;
  return Math.max(0, Math.round(((quotaBytes - usedBytes) / perHour) * 10) / 10);
}

// ---------------------------------------------------------------- §6 chốt toàn cục (ADR-185)

export const DEFAULT_DB_DISK_BUDGET_MB = 512;
export const DB_DISK_NEAR_FULL_PCT = 80;
/** Chốt toàn cục chạy trong job cập nhật nấc nhưng tối đa 10 phút một lần (đếm trong bộ nhớ). */
export const GLOBAL_DISK_CHECK_EVERY_MS = 10 * 60_000;

export function resolveDbDiskBudgetMb(v: string | undefined = process.env.DB_DISK_BUDGET_MB): number {
  const n = Number(v);
  return v !== undefined && v !== '' && Number.isFinite(n) && n > 0 ? n : DEFAULT_DB_DISK_BUDGET_MB;
}

/** `pg_database_size` ≥ 80% ngân sách ổ -> cảnh báo operator `hub.storage_near_full`. */
export function isDiskNearFull(dbSizeBytes: number, budgetMb: number): boolean {
  return Number.isFinite(dbSizeBytes) && budgetMb > 0 && dbSizeBytes >= (budgetMb * 1024 * 1024 * DB_DISK_NEAR_FULL_PCT) / 100;
}

export function shouldCheckGlobalDisk(lastCheckedAt: number | null, now: number): boolean {
  return lastCheckedAt === null || now - lastCheckedAt >= GLOBAL_DISK_CHECK_EVERY_MS;
}

// ---------------------------------------------------------------- nhịp job (env, đọc lúc khởi động)

const clampInt = (v: string | undefined, def: number, min: number, max: number) => {
  const n = Number(v);
  if (v === undefined || v === '' || !Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.round(n)));
};

/** Job cập nhật nấc: mặc định 60s (cùng nhịp flush traffic). */
export function resolveStorageLevelIntervalMs(v: string | undefined = process.env.STORAGE_LEVEL_INTERVAL_MS): number {
  return clampInt(v, 60_000, 5_000, 3_600_000);
}

/** Job hiệu chỉnh (quét thật): mặc định 24h. */
export function resolveStorageRecalibrateIntervalMs(v: string | undefined = process.env.STORAGE_RECALIBRATE_INTERVAL_MS): number {
  return clampInt(v, DAY_MS, 60_000, 7 * DAY_MS);
}
