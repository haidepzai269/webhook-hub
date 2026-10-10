import { edgeHealthOf, healthOf } from '../../src/flow';

describe('healthOf — ngưỡng sức khoẻ một nguồn sự thật', () => {
  it('[UI:F1-20] idle khi không có gì đi qua và không có tín hiệu xấu', () => {
    expect(healthOf({ events: 0 })).toBe('idle');
    expect(healthOf({ events: 0, successRate: null, circuit: 'CLOSED' })).toBe('idle');
  });

  it('[UI:F1-21] healthy khi tỉ lệ lỗi ≤ 2% và p95 ổn', () => {
    expect(healthOf({ events: 100, failed: 2, p95Ms: 120 })).toBe('healthy');
    expect(healthOf({ events: 10, successRate: 1 })).toBe('healthy');
  });

  it('[UI:F1-22] warning: lỗi > 2%, RETRYING, HALF_OPEN, rejected lẻ tẻ, p95 > 2s', () => {
    expect(healthOf({ events: 100, failed: 3 })).toBe('warning');
    expect(healthOf({ events: 10, retrying: 1 })).toBe('warning');
    expect(healthOf({ events: 0, circuit: 'HALF_OPEN' })).toBe('warning');
    expect(healthOf({ events: 20, rejected: 1 })).toBe('warning');
    expect(healthOf({ events: 20, p95Ms: 2500 })).toBe('warning');
  });

  it('[UI:F1-23] crashed: circuit OPEN (kể cả khi idle), DLQ tăng, lỗi > 20%, source bị chặn hàng loạt', () => {
    expect(healthOf({ events: 0, circuit: 'OPEN' })).toBe('crashed');
    expect(healthOf({ events: 50, dlqDelta: 1 })).toBe('crashed');
    expect(healthOf({ events: 10, failed: 3 })).toBe('crashed');
    expect(healthOf({ events: 10, successRate: 0.7 })).toBe('crashed');
    expect(healthOf({ events: 8, rejected: 5 })).toBe('crashed');
    expect(healthOf({ events: 100, rejected: 5 })).toBe('warning');
  });

  it('[UI:F7-01] endpoint đa service: verification FAILED → crashed (kể cả idle), PENDING → warning', () => {
    expect(healthOf({ events: 0, verification: 'FAILED' })).toBe('crashed');
    expect(healthOf({ events: 0, verification: 'PENDING' })).toBe('warning');
    expect(healthOf({ events: 10, successRate: 1, verification: 'VERIFIED' })).toBe('healthy');
  });

  it('[UI:F1-24] cạnh dùng cùng ngưỡng', () => {
    expect(edgeHealthOf(0, 0)).toBe('idle');
    expect(edgeHealthOf(100, 0)).toBe('healthy');
    expect(edgeHealthOf(100, 5)).toBe('warning');
    expect(edgeHealthOf(10, 5)).toBe('crashed');
    expect(edgeHealthOf(10, 0, 2)).toBe('warning');
  });
});
