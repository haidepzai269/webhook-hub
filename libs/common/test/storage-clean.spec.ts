import {
  CLEAN_BATCH_SIZE,
  TRIM_FREE_RATIO,
  bytesByImportance,
  estimateClean,
  isCleanRequestError,
  parseBuckets,
  parseCleanRequest,
  parseOlderThan,
  resolveStorageAutoCleanEnabled,
} from '../src';
import { TOTAL_RETRY_WINDOW_MS } from '@hub/messaging';

/** QT4 (SPEC-han-muc-dung-luong §5.1–§5.5, ADR-184): hợp đồng thuần của lệnh dọn. */
const NOW = Date.parse('2026-10-12T12:00:00Z');
// Sàn thật (BP2 C2: ≈ 5h44m40s) — import, không viết cứng, để test luôn phản ánh cửa sổ retry hiện hành.
const FLOOR = TOTAL_RETRY_WINDOW_MS;

describe('QT4: lệnh dọn — kiểm request (thuần)', () => {
  it('[QT:T9] (phần a) olderThan MỚI hơn sàn retry window -> lỗi field olderThan; đúng sàn trở lên thì nhận', () => {
    const tooNew = parseCleanRequest({ action: 'trim', importance: ['low'], olderThan: '2h' }, FLOOR, NOW);
    expect(isCleanRequestError(tooNew)).toBe(true);
    expect(tooNew).toMatchObject({ field: 'olderThan' });
    const iso = parseCleanRequest({ action: 'trim', importance: ['low'], olderThan: new Date(NOW - 3_600_000).toISOString() }, FLOOR, NOW);
    expect(iso).toMatchObject({ field: 'olderThan' });
    // '3h' từng hợp lệ (sàn 2h38m); sau BP2 sàn ≈ 5h44m40s -> bị từ chối.
    expect(parseCleanRequest({ action: 'trim', importance: ['low'], olderThan: '3h' }, FLOOR, NOW)).toMatchObject({ field: 'olderThan' });
    const ok = parseCleanRequest({ action: 'trim', importance: ['low'], olderThan: '6h' }, FLOOR, NOW);
    expect(isCleanRequestError(ok)).toBe(false);
    expect(ok).toMatchObject({ action: 'trim', importance: ['low'], sourceId: null, olderThan: { label: '6h', cutoff: new Date(NOW - 6 * 3_600_000), minAgeDays: 0 } });
  });

  it('mức Cao cần confirmHigh: true; "Giữ" không bao giờ; mẫu từ chối (junk) chỉ Xoá hẳn; action/importance lạ -> lỗi đúng field', () => {
    expect(parseCleanRequest({ action: 'trim', importance: ['high'], olderThan: '3d' }, FLOOR, NOW)).toMatchObject({ field: 'confirmHigh' });
    expect(isCleanRequestError(parseCleanRequest({ action: 'trim', importance: ['high'], olderThan: '3d', confirmHigh: true }, FLOOR, NOW))).toBe(false);
    expect(parseCleanRequest({ action: 'trim', importance: ['high'], olderThan: '3d', confirmHigh: 'true' }, FLOOR, NOW)).toMatchObject({ field: 'confirmHigh' });
    expect(parseCleanRequest({ action: 'delete', importance: ['keep'], olderThan: '3d' }, FLOOR, NOW)).toMatchObject({ field: 'importance' });
    expect(parseCleanRequest({ action: 'trim', importance: ['junk'], olderThan: '3d' }, FLOOR, NOW)).toMatchObject({ field: 'importance' });
    expect(isCleanRequestError(parseCleanRequest({ action: 'delete', importance: ['junk', 'low'], olderThan: '1d' }, FLOOR, NOW))).toBe(false);
    expect(parseCleanRequest({ action: 'purge', importance: ['low'], olderThan: '3d' }, FLOOR, NOW)).toMatchObject({ field: 'action' });
    expect(parseCleanRequest({ action: 'trim', importance: [], olderThan: '3d' }, FLOOR, NOW)).toMatchObject({ field: 'importance' });
    expect(parseCleanRequest({ action: 'trim', importance: ['audit_logs'], olderThan: '3d' }, FLOOR, NOW)).toMatchObject({ field: 'importance' });
    expect(parseCleanRequest({ action: 'trim', importance: ['low'], olderThan: '3d', sourceId: 'x' }, FLOOR, NOW)).toMatchObject({ field: 'sourceId' });
    expect(parseCleanRequest(null, FLOOR, NOW)).toMatchObject({ field: 'action' });
  });

  it('importance được khử trùng + sắp theo thứ tự cố định (id gợi ý ổn định)', () => {
    const r = parseCleanRequest({ action: 'delete', importance: ['medium', 'junk', 'low', 'low'], olderThan: '5d' }, FLOOR, NOW);
    expect(r).toMatchObject({ importance: ['junk', 'low', 'medium'] });
  });

  it('olderThan: <n>d / <n>h hoặc ISO có múi giờ, không tương lai, không rác', () => {
    expect(parseOlderThan('3d', NOW)).toEqual({ cutoff: new Date(NOW - 3 * 86_400_000), label: '3d', minAgeDays: 3 });
    expect(parseOlderThan('36h', NOW)).toMatchObject({ label: '36h', minAgeDays: 1 });
    expect(parseOlderThan('2026-10-01T00:00:00Z', NOW)).toMatchObject({ label: '2026-10-01T00:00:00.000Z', minAgeDays: 11 });
    for (const bad of ['0d', '3', 'd3', '3w', '2026-10-01', '2026-12-01T00:00:00Z', '', 3, null]) expect(parseOlderThan(bad, NOW)).toBeNull();
  });

  it('lô 1000 dòng; "Dọn" ước tính ~90% byte; by_bucket hỏng bị bỏ, không ném', () => {
    expect(CLEAN_BATCH_SIZE).toBe(1000);
    const buckets = parseBuckets([
      { sourceId: 's1', importance: 'low', ageDays: 4, events: 10, bytes: 1000 },
      { sourceId: 's1', importance: 'low', ageDays: 1, events: 5, bytes: 500 },
      { sourceId: 's2', importance: 'low', ageDays: 9, events: 1, bytes: 100 },
      { sourceId: null, importance: 'junk', ageDays: 0, events: 3, bytes: 30 },
      { importance: 'low' },
      'rác',
    ]);
    expect(buckets).toHaveLength(4);
    expect(estimateClean(buckets, { action: 'trim', importance: ['low'], minAgeDays: 3 })).toEqual({ events: 11, bytes: Math.round(1100 * TRIM_FREE_RATIO) });
    expect(estimateClean(buckets, { action: 'delete', importance: ['low'], minAgeDays: 3, sourceId: 's2' })).toEqual({ events: 1, bytes: 100 });
    expect(estimateClean(buckets, { action: 'delete', importance: ['junk'], minAgeDays: 0 })).toEqual({ events: 3, bytes: 30 });
    expect(bytesByImportance(buckets)).toMatchObject({ low: { events: 16, bytes: 1600 }, junk: { events: 3, bytes: 30 }, high: { events: 0, bytes: 0 } });
    expect(parseBuckets(null)).toEqual([]);
  });

  it('[QT:T30] (phần c) STORAGE_AUTO_CLEAN_ENABLED mặc định TẮT; chỉ "1"/"true" là bật', () => {
    expect(resolveStorageAutoCleanEnabled(undefined)).toBe(false);
    expect(resolveStorageAutoCleanEnabled('0')).toBe(false);
    expect(resolveStorageAutoCleanEnabled('yes')).toBe(false);
    expect(resolveStorageAutoCleanEnabled('1')).toBe(true);
    expect(resolveStorageAutoCleanEnabled('TRUE')).toBe(true);
  });
});
