import {
  BLOAT_FACTOR_DEFAULT,
  bloatFactorFrom,
  calibrationDueBefore,
  clampBloatFactor,
  computeUsedBytes,
  forecastHours,
  isDiskNearFull,
  resolveDbDiskBudgetMb,
  resolveStorageLevelIntervalMs,
  resolveStorageRecalibrateIntervalMs,
  shouldCheckGlobalDisk,
} from '@hub/common';

const DAY = 86_400_000;
const MB = 1024 * 1024;

describe('QT2 — công thức đo cộng dồn (E2) + chốt toàn cục (§6), hàm thuần', () => {
  it('[QT:T32] (phần a) used = mốc + bloat × Σ bytes sau mốc − đã giải phóng; hệ số kẹp [1,4], mặc định 2; mốc quá cũ so với retention traffic -> hiệu chỉnh bắt buộc', () => {
    expect(computeUsedBytes({ calibratedBytes: 1000, bloatFactor: 2, trafficBytesSinceCalibration: 300, freedSinceCalibration: 100 })).toBe(1500);
    expect(computeUsedBytes({ calibratedBytes: 0, bloatFactor: 9, trafficBytesSinceCalibration: 10, freedSinceCalibration: 0 })).toBe(40); // kẹp 4
    expect(computeUsedBytes({ calibratedBytes: 0, bloatFactor: 0.2, trafficBytesSinceCalibration: 10, freedSinceCalibration: 0 })).toBe(10); // kẹp 1
    expect(computeUsedBytes({ calibratedBytes: 100, bloatFactor: 2, trafficBytesSinceCalibration: 0, freedSinceCalibration: 500 })).toBe(0); // không âm
    expect(computeUsedBytes({ calibratedBytes: 100, bloatFactor: NaN, trafficBytesSinceCalibration: 10, freedSinceCalibration: NaN })).toBe(120);

    expect(clampBloatFactor(NaN)).toBe(BLOAT_FACTOR_DEFAULT);
    expect(bloatFactorFrom(10_000, 100)).toBe(BLOAT_FACTOR_DEFAULT); // chưa đủ dữ liệu
    expect(bloatFactorFrom(3 * MB, 2 * MB)).toBe(1.5);
    expect(bloatFactorFrom(100 * MB, 2 * MB)).toBe(4);
    expect(bloatFactorFrom(1 * MB, 2 * MB)).toBe(1);

    const now = Date.parse('2026-10-12T12:00:00Z');
    // chu kỳ 24h, retention 7 ngày -> hạn = now − 24h
    expect(calibrationDueBefore(now, DAY, 7).getTime()).toBe(now - DAY);
    // chu kỳ 7 ngày nhưng retention traffic 3 ngày -> bắt buộc sau 2 ngày (trước khi traffic sau mốc bị dọn)
    expect(calibrationDueBefore(now, 7 * DAY, 3).getTime()).toBe(now - 2 * DAY);
    // retention 1 ngày -> mọi lượt
    expect(calibrationDueBefore(now, DAY, 1).getTime()).toBe(now);

    expect(forecastHours(40 * MB, 50 * MB, 2, 24 * MB)).toBe(5); // 10MB / (2×1MB/giờ)
    expect(forecastHours(40 * MB, 50 * MB, 2, 0)).toBeNull();
    expect(resolveStorageLevelIntervalMs(undefined)).toBe(60_000);
    expect(resolveStorageRecalibrateIntervalMs(undefined)).toBe(DAY);
    expect(resolveStorageLevelIntervalMs('10')).toBe(5_000);
  });

  it('[QT:T14] (phần a) chốt toàn cục: ≥ 80% DB_DISK_BUDGET_MB là gần đầy; đọc tối đa 10 phút một lần', () => {
    expect(resolveDbDiskBudgetMb(undefined)).toBe(512);
    expect(resolveDbDiskBudgetMb('x')).toBe(512);
    expect(isDiskNearFull(409 * MB, 512)).toBe(false);
    expect(isDiskNearFull(410 * MB, 512)).toBe(true);
    expect(isDiskNearFull(NaN, 512)).toBe(false);
    expect(shouldCheckGlobalDisk(null, 0)).toBe(true);
    expect(shouldCheckGlobalDisk(0, 9 * 60_000)).toBe(false);
    expect(shouldCheckGlobalDisk(0, 10 * 60_000)).toBe(true);
  });
});
