import {
  DEFAULT_STORAGE_POLICIES,
  HARD_LIMIT_PCT,
  STORAGE_LEVELS,
  StorageLevel,
  importanceOf,
  isWriteBlocked,
  levelFor,
  parseStorageLevel,
  quotaBytesFor,
  resolveProjectStorageQuotaMb,
  resolveStorageLockEnabled,
} from '@hub/common';

const Q = 1000; // hạn mức giả: 1% = 10

describe('QT1 — levelFor / isWriteBlocked / importanceOf (hàm thuần)', () => {
  it('[QT:T1] đủ các nấc khi đi lên; vùng đệm 100→90; cảnh báo hạ khi thấp hơn ngưỡng 5 điểm', () => {
    expect(levelFor(0, Q, 'OK')).toBe('OK');
    expect(levelFor(699, Q, 'OK')).toBe('OK');
    expect(levelFor(700, Q, 'OK')).toBe('WARN_70');
    expect(levelFor(850, Q, 'OK')).toBe('WARN_85');
    expect(levelFor(950, Q, 'OK')).toBe('CRITICAL_95');
    expect(levelFor(1000, Q, 'OK')).toBe('LOCKED'); // nhảy thẳng lên nấc cao nhất đã vượt
    expect(levelFor(1000, Q, null)).toBe('LOCKED');

    // cảnh báo: hạ khi thấp hơn ngưỡng 5 điểm
    expect(levelFor(660, Q, 'WARN_70')).toBe('WARN_70');
    expect(levelFor(649, Q, 'WARN_70')).toBe('OK');
    expect(levelFor(810, Q, 'WARN_85')).toBe('WARN_85');
    expect(levelFor(799, Q, 'WARN_85')).toBe('WARN_70');
    expect(levelFor(600, Q, 'WARN_85')).toBe('OK');
    expect(levelFor(910, Q, 'CRITICAL_95')).toBe('CRITICAL_95');
    expect(levelFor(899, Q, 'CRITICAL_95')).toBe('WARN_85');

    // LOCKED chỉ mở khi < 90%
    expect(levelFor(990, Q, 'LOCKED')).toBe('LOCKED');
    expect(levelFor(900, Q, 'LOCKED')).toBe('LOCKED');
    expect(levelFor(899, Q, 'LOCKED')).toBe('WARN_85');
    expect(levelFor(100, Q, 'LOCKED')).toBe('OK');

    // lỗi cấu hình / dữ liệu hỏng -> OK (không khoá oan)
    expect(levelFor(5000, 0, 'OK')).toBe('OK');
    expect(levelFor(NaN, Q, 'LOCKED')).toBe('OK');
    expect(levelFor(500, Q, 'GARBAGE')).toBe('OK');
    expect(parseStorageLevel(null)).toBe('OK');
    expect(parseStorageLevel('HARD_LOCKED')).toBe('HARD_LOCKED');
  });

  it('[QT:T28] ≥110% -> HARD_LOCKED; HARD_LOCKED về LOCKED khi < 100%; isWriteBlocked đủ bảng nấc × keepLonger × lockEnabled', () => {
    expect(HARD_LIMIT_PCT).toBe(110);
    expect(levelFor(1099, Q, 'OK')).toBe('LOCKED');
    expect(levelFor(1100, Q, 'OK')).toBe('HARD_LOCKED');
    expect(levelFor(1100, Q, 'LOCKED')).toBe('HARD_LOCKED');
    expect(levelFor(1050, Q, 'HARD_LOCKED')).toBe('HARD_LOCKED'); // còn ≥ 100% -> chưa hạ
    expect(levelFor(999, Q, 'HARD_LOCKED')).toBe('LOCKED');
    expect(levelFor(900, Q, 'HARD_LOCKED')).toBe('LOCKED'); // rồi theo vùng đệm của LOCKED
    expect(levelFor(899, Q, 'HARD_LOCKED')).toBe('WARN_85');

    const expected: Record<StorageLevel, [boolean, boolean]> = {
      // [source thường, source Giữ lâu] khi lockEnabled
      OK: [false, false],
      WARN_70: [false, false],
      WARN_85: [false, false],
      CRITICAL_95: [false, false],
      LOCKED: [true, false],
      HARD_LOCKED: [true, true],
    };
    for (const level of STORAGE_LEVELS) {
      expect([isWriteBlocked(level, false, true), isWriteBlocked(level, true, true)]).toEqual(expected[level]);
      // E5: cờ tắt -> không bao giờ chặn
      expect(isWriteBlocked(level, false, false)).toBe(false);
      expect(isWriteBlocked(level, true, false)).toBe(false);
    }
  });

  it('[QT:T30] (phần a) cờ STORAGE_LOCK_ENABLED mặc định 0; hạn mức mặc định 50MB, operator ghi đè', () => {
    expect(resolveStorageLockEnabled(undefined)).toBe(false);
    expect(resolveStorageLockEnabled('0')).toBe(false);
    expect(resolveStorageLockEnabled('')).toBe(false);
    expect(resolveStorageLockEnabled('1')).toBe(true);
    expect(resolveStorageLockEnabled('true')).toBe(true);
    expect(resolveProjectStorageQuotaMb(undefined)).toBe(50);
    expect(resolveProjectStorageQuotaMb('abc')).toBe(50);
    expect(resolveProjectStorageQuotaMb('-3')).toBe(50);
    expect(resolveProjectStorageQuotaMb('1')).toBe(1);
    expect(quotaBytesFor(null, 50)).toBe(50 * 1024 * 1024);
    expect(quotaBytesFor(0, 50)).toBe(50 * 1024 * 1024);
    expect(quotaBytesFor(200, 50)).toBe(200 * 1024 * 1024);
  });

  it('[QT:T17] (phần a) importanceOf: đủ 5 mức; keep_longer luôn là Giữ; không đọc payload', () => {
    const now = Date.parse('2026-10-12T00:00:00Z');
    const plain = { keepLonger: false };
    const ev = (extra: object = {}) => ({ kind: 'event' as const, ...extra });
    expect(importanceOf({ kind: 'rejected_sample' }, [], plain, now)).toBe('junk');
    expect(importanceOf(ev(), [{ status: 'SUCCEEDED' }, { status: 'SUCCEEDED' }], plain, now)).toBe('low');
    expect(importanceOf(ev(), [], plain, now)).toBe('medium');
    expect(importanceOf(ev(), [{ status: 'SUCCEEDED' }, { status: 'DEAD' }], plain, now)).toBe('high');
    expect(importanceOf(ev({ lastReplayAt: new Date(now - 3_600_000) }), [{ status: 'SUCCEEDED' }], plain, now)).toBe('high');
    expect(importanceOf(ev({ lastReplayAt: new Date(now - 2 * 86_400_000) }), [{ status: 'SUCCEEDED' }], plain, now)).toBe('low');
    expect(importanceOf(ev(), [{ status: 'RETRYING' }], plain, now)).toBe('high'); // đang chạy: không bao giờ gợi ý dọn
    // keep_longer thắng mọi tín hiệu khác
    for (const [r, d] of [
      [{ kind: 'rejected_sample' as const }, []],
      [ev(), [{ status: 'SUCCEEDED' }]],
      [ev(), []],
      [ev(), [{ status: 'DEAD' }]],
    ] as const) {
      expect(importanceOf(r, d, { keepLonger: true }, now)).toBe('keep');
    }
    // payload không ảnh hưởng (null, object "thanh toán" hay thứ gì khác)
    const ds = [{ status: 'SUCCEEDED' }];
    const a = importanceOf(ev({ payload: null }), ds, plain, now);
    const b = importanceOf(ev({ payload: { type: 'payment.succeeded', amount: 1e9 } }), ds, plain, now);
    expect(a).toBe(b);
  });

  it('[QT:T26] (phần a) policy mặc định Q10: Rác delete 1 ngày + Thấp trim 3 ngày, Trung bình off; không có Cao/Giữ', () => {
    const by = Object.fromEntries(DEFAULT_STORAGE_POLICIES.map((p) => [p.importance, p]));
    expect(by.junk).toMatchObject({ action: 'delete', afterDays: 1, trigger: 'always' });
    expect(by.low).toMatchObject({ action: 'trim', afterDays: 3, trigger: 'always' });
    expect(by.medium).toMatchObject({ action: 'off' });
    expect(Object.keys(by).sort()).toEqual(['junk', 'low', 'medium']);
  });
});
