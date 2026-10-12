import {
  CleanupAdvisor,
  RuleAdvisor,
  StorageSnapshot,
  TRIM_FREE_RATIO,
  assertSuggestionSafe,
  guardSuggestions,
  shouldEmitCleanupSuggested,
  suggestWithFallback,
  suggestionId,
  validateCanonical,
  HUB_CLEANUP_SUGGESTED,
} from '../src';

/** QT4b (SPEC-han-muc-dung-luong §5.6, ADR-187): bộ gợi ý dọn — interface, rules@1, hàng rào ngoài advisor, fail-open. */
const NOW = Date.parse('2026-10-12T12:00:00Z');
const FLOOR = 2.6 * 3_600_000;
const KEEP = '99999999-9999-4999-8999-999999999999';
const SRC = '11111111-1111-4111-8111-111111111111';

function snap(o: Partial<StorageSnapshot> = {}): StorageSnapshot {
  return {
    usedBytes: 40 * 1048576,
    quotaBytes: 50 * 1048576,
    level: 'WARN_70',
    growthPerDay: 1048576,
    buckets: [
      { sourceId: SRC, importance: 'low', ageDays: 4, events: 100, bytes: 4_000_000 },
      { sourceId: SRC, importance: 'low', ageDays: 1, events: 10, bytes: 400_000 },
      { sourceId: SRC, importance: 'medium', ageDays: 7, events: 5, bytes: 50_000 },
      { sourceId: SRC, importance: 'junk', ageDays: 2, events: 30, bytes: 120_000 },
      { sourceId: SRC, importance: 'high', ageDays: 9, events: 3, bytes: 9_000_000 },
      { sourceId: KEEP, importance: 'keep', ageDays: 20, events: 50, bytes: 7_000_000 },
    ],
    policies: [],
    keepLongerSourceIds: [KEEP],
    ...o,
  };
}
const ctx = (o: Partial<Parameters<typeof assertSuggestionSafe>[1]> = {}) => ({ buckets: snap().buckets, keepLongerSourceIds: [KEEP], floorMs: FLOOR, now: NOW, ...o });

describe('QT4b: CleanupAdvisor / RuleAdvisor / hàng rào', () => {
  it('[QT:T21] RuleAdvisor (rules@1): đúng bảng §5.3 — Rác xoá hẳn ≥1 ngày, Thấp dọn ≥3 ngày, Trung bình dọn ≥5 ngày; KHÔNG gợi ý Cao/Giữ; id ổn định giữa hai lần chạy', async () => {
    const a = new RuleAdvisor(() => NOW);
    const r1 = await a.suggest(snap());
    const r2 = await new RuleAdvisor(() => NOW + 3_600_000).suggest(snap());
    expect(r1.map((s) => [s.importance, s.action, s.olderThan, s.estimatedEvents, s.estimatedBytes])).toEqual([
      [['low'], 'trim', '3d', 100, Math.round(4_000_000 * TRIM_FREE_RATIO)],
      [['junk'], 'delete', '1d', 30, 120_000],
      [['medium'], 'trim', '5d', 5, Math.round(50_000 * TRIM_FREE_RATIO)],
    ]);
    expect(r1.every((s) => s.advisor === 'rules@1' && s.sourceId === null && s.reason.includes('MB'))).toBe(true);
    expect(r1.flatMap((s) => s.importance)).not.toEqual(expect.arrayContaining(['high']));
    expect(r1.flatMap((s) => s.importance)).not.toEqual(expect.arrayContaining(['keep']));
    // id xác định: cùng dữ liệu -> cùng id (kể cả lúc chạy khác); không ngẫu nhiên
    expect(r2.map((s) => s.id)).toEqual(r1.map((s) => s.id));
    expect(r1[0].id).toBe(suggestionId('rules@1', ['low'], 'trim', '3d', null));
    expect(r1[0].id).toMatch(/^sug_[0-9a-f]{24}$/);
    expect(r1[0].expiresAt).toBe(new Date(NOW + 86_400_000).toISOString());
    // không có gì để dọn -> không gợi ý
    expect(await a.suggest(snap({ buckets: [] }))).toEqual([]);
  });

  it('[QT:T22] (phần a) hàng rào NGOÀI advisor: mức Cao/Giữ, olderThan mới hơn sàn, source Giữ lâu, rác+Dọn, hành động lạ -> LOẠI (đếm); số MB bịa -> TÍNH LẠI từ by_bucket; trường lạ bị bỏ', () => {
    const base = { action: 'trim', importance: ['low'], olderThan: '3d', sourceId: null, advisor: 'llm@1', reason: 'r', reasonCode: 'x' };
    const bad: [unknown, string][] = [
      [{ ...base, importance: ['high'] }, 'importance_forbidden'],
      [{ ...base, importance: ['low', 'keep'] }, 'importance_forbidden'],
      [{ ...base, importance: ['audit_logs'] }, 'importance_forbidden'],
      [{ ...base, olderThan: '1h' }, 'older_than_too_recent'],
      [{ ...base, olderThan: 'hôm qua' }, 'older_than'],
      [{ ...base, sourceId: KEEP }, 'keep_longer_source'],
      [{ ...base, action: 'delete', importance: ['junk'], olderThan: '1d' }, ''],
      [{ ...base, action: 'trim', importance: ['junk'] }, 'junk_trim'],
      [{ ...base, action: 'drop_table' }, 'action'],
      [null, 'not_object'],
    ];
    for (const [s, reason] of bad) {
      const v = assertSuggestionSafe(s, ctx());
      if (reason === '') expect(v.ok).toBe(true);
      else expect(v).toEqual({ ok: false, reason, unsafe: true });
    }
    const forged = assertSuggestionSafe({ ...base, estimatedBytes: 999_999_999, estimatedEvents: 1, id: 'sug_bịa', table: 'hub.audit_logs', expiresAt: '2099-01-01T00:00:00Z' }, ctx());
    expect(forged.ok).toBe(true);
    const s = (forged as unknown as { suggestion: Record<string, unknown> }).suggestion;
    expect(s.estimatedBytes).toBe(Math.round(4_000_000 * TRIM_FREE_RATIO));
    expect(s.estimatedEvents).toBe(100);
    expect(s.id).toBe(suggestionId('llm@1', ['low'], 'trim', '3d', null));
    expect(s.expiresAt).toBe(new Date(NOW + 86_400_000).toISOString());
    expect(Object.keys(s).sort()).toEqual(['action', 'advisor', 'estimatedBytes', 'estimatedEvents', 'expiresAt', 'id', 'importance', 'olderThan', 'reason', 'reasonCode', 'sourceId'].sort());
    // rỗng (không còn gì để dọn) -> loại nhưng KHÔNG tính là vi phạm
    expect(assertSuggestionSafe({ ...base, olderThan: '30d' }, ctx())).toEqual({ ok: false, reason: 'empty', unsafe: false });
    const g = guardSuggestions([{ ...base, importance: ['high'] }, base, base, { ...base, olderThan: '30d' }], ctx());
    expect(g.accepted).toHaveLength(1); // khử trùng theo id
    expect(g.rejected).toEqual([{ advisor: 'llm@1', reason: 'importance_forbidden' }]);
  });

  it('[QT:T23] (phần a) advisor ném lỗi / quá giờ / trả rác -> fail-open về rules@1 (kết quả vẫn có), không ném ra ngoài', async () => {
    const rules = new RuleAdvisor(() => NOW);
    const boom: CleanupAdvisor = { id: 'llm@1', suggest: async () => Promise.reject(new Error('LLM sập')) };
    const slow: CleanupAdvisor = { id: 'llm@1', suggest: () => new Promise(() => undefined) };
    const junk: CleanupAdvisor = { id: 'llm@1', suggest: async () => 'không phải mảng' as never };
    for (const a of [boom, slow, junk]) {
      const r = await suggestWithFallback(a, rules, snap(), 50);
      expect(r).toMatchObject({ advisor: 'rules@1', failedOpen: true });
      expect((r.suggestions as { advisor: string }[]).every((s) => s.advisor === 'rules@1')).toBe(true);
      expect(r.suggestions.length).toBe(3);
    }
    const ok = await suggestWithFallback({ id: 'llm@1', suggest: async () => [] }, rules, snap(), 50);
    expect(ok).toEqual({ suggestions: [], advisor: 'llm@1', failedOpen: false });
  });

  it('[QT:T24] (phần a) khi nào phát webhook: nấc LÊN luôn phát (kể cả LOCKED, kể cả đã phát trong ngày); đổi ≥10% quota và cách lần trước ≥24h; OK + rỗng không bao giờ', () => {
    const base = { levelRose: false, level: 'WARN_70' as const, suggestionsCount: 2, totalBytes: 6_000_000, quotaBytes: 50_000_000, prevEmittedBytes: 0, prevEmittedAt: null, now: NOW };
    expect(shouldEmitCleanupSuggested({ ...base, level: 'OK', suggestionsCount: 0, levelRose: true })).toBe(false);
    expect(shouldEmitCleanupSuggested({ ...base, levelRose: true, level: 'LOCKED', prevEmittedAt: new Date(NOW - 60_000) })).toBe(true);
    expect(shouldEmitCleanupSuggested(base)).toBe(true); // lần đầu, 6MB ≥ 10% × 50MB
    expect(shouldEmitCleanupSuggested({ ...base, totalBytes: 4_000_000 })).toBe(false); // < 10% quota
    expect(shouldEmitCleanupSuggested({ ...base, prevEmittedAt: new Date(NOW - 3_600_000) })).toBe(false); // < 1 ngày
    expect(shouldEmitCleanupSuggested({ ...base, prevEmittedAt: new Date(NOW - 25 * 3_600_000), prevEmittedBytes: 5_500_000 })).toBe(false); // đổi ít
    expect(shouldEmitCleanupSuggested({ ...base, prevEmittedAt: new Date(NOW - 25 * 3_600_000), prevEmittedBytes: 500_000 })).toBe(true);
  });

  it('[QT:T24] (phần b) data của hub.project.cleanup_suggested khớp catalog (hub.* dành riêng); service không giả mạo được kiểu hub', async () => {
    const suggestions = await new RuleAdvisor(() => NOW).suggest(snap());
    const data = { level: 'LOCKED', usedBytes: 52_428_800, quotaBytes: 52_428_800, forecastHours: null, suggestions };
    expect(validateCanonical(HUB_CLEANUP_SUGGESTED, data)).toEqual({ ok: true });
    expect(validateCanonical(HUB_CLEANUP_SUGGESTED, { ...data, extra: 1 })).toMatchObject({ ok: false, field: 'extra' });
    expect(validateCanonical(HUB_CLEANUP_SUGGESTED, { ...data, suggestions: [{ ...suggestions[0], importance: ['high'] }] })).toMatchObject({ ok: false });
    expect(validateCanonical('hub.project.storage_free_money', { a: 1 })).toEqual({ ok: false, field: 'type' });
  });
});
