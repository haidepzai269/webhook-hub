import { readFileSync } from 'fs';
import { join } from 'path';
import { CAUSES, CAUSE_GROUPS, EXEMPT_REASONS, causeOfSendFailure, isCause, alertRuleCause } from '../src/causes';
import { REASON_CODES } from '../src/flow/stages';
import { ALERT_RULES } from '../src/alerts';

/**
 * LOGGING.md §8: MỘT bảng `causes.ts`, không catalog thứ ba. Ba phép đồng bộ (a)(b)(c) + luật nhãn Prometheus (§2).
 */
describe('causes.ts — bảng nguyên nhân duy nhất (LOGGING.md §2, §8)', () => {
  const keys = Object.keys(CAUSES);
  const errorsMd = readFileSync(join(__dirname, '../../../docs/ERRORS.md'), 'utf8');

  it('enum đóng ~30 giá trị, dạng <nhóm>.<tên> chữ thường + "_", không id/giá trị tự do (an toàn làm nhãn Prometheus)', () => {
    expect(keys.length).toBeGreaterThanOrEqual(30);
    expect(keys.length).toBeLessThanOrEqual(40);
    for (const k of keys) {
      expect(k).toMatch(/^(slow|wrong|fail|growth)\.[a-z0-9_]+$/);
      expect(CAUSE_GROUPS).toContain(CAUSES[k as keyof typeof CAUSES].group);
      expect(k.startsWith(`${CAUSES[k as keyof typeof CAUSES].group}.`)).toBe(true);
    }
    expect(isCause('wrong.signature')).toBe(true);
    expect(isCause('wrong.signature:src_abc123')).toBe(false);
  });

  it('(c) mọi cause có blame hợp lệ và "next" không rỗng', () => {
    for (const [k, def] of Object.entries(CAUSES)) {
      expect(['provider', 'khach', 'dich', 'hub', 'ha_tang']).toContain(def.blame);
      expect(def.next.trim().length).toBeGreaterThan(5);
      expect(typeof def.page).toBe('boolean');
      expect(typeof def.hubFault).toBe('boolean');
      expect(k).toBeTruthy();
    }
  });

  it('(a) mọi khoá REASON_CODES được một cause tham chiếu (reason) hoặc ghi rõ exempt kèm lý do', () => {
    const referenced = new Set(Object.values(CAUSES).map((c) => (c as { reason?: string }).reason).filter(Boolean));
    for (const code of Object.keys(REASON_CODES)) {
      const ok = referenced.has(code) || (EXEMPT_REASONS as Record<string, string>)[code];
      if (!ok) throw new Error(`REASON_CODES.${code} chưa có cause tham chiếu và chưa nằm trong EXEMPT_REASONS`);
      if (!referenced.has(code)) expect((EXEMPT_REASONS as Record<string, string>)[code].length).toBeGreaterThan(10);
    }
    // và ngược lại: cause không tham chiếu khoá không tồn tại
    for (const c of Object.values(CAUSES)) {
      const r = (c as { reason?: string }).reason;
      if (r) expect(Object.keys(REASON_CODES)).toContain(r);
    }
  });

  it('(b) mọi `error` tham chiếu có mục "## <mã>" trong docs/ERRORS.md', () => {
    for (const c of Object.values(CAUSES)) {
      const e = (c as { error?: string }).error;
      if (e) expect(errorsMd).toContain(`## ${e}`);
    }
  });

  it('phân loại lỗi giao đích -> cause (đích 500 / timeout / ECONNREFUSED / 429 / 400 / 408)', () => {
    expect(causeOfSendFailure({ status: 503 })).toBe('fail.dest_5xx');
    expect(causeOfSendFailure({ status: 500, error: 'timeout tổng 5000ms (AbortSignal)' })).toBe('fail.dest_timeout');
    expect(causeOfSendFailure({ status: 408 })).toBe('fail.dest_timeout');
    expect(causeOfSendFailure({ status: 500, error: 'connect ECONNREFUSED 10.0.0.1:443' })).toBe('fail.dest_network');
    expect(causeOfSendFailure({ status: 500, error: 'getaddrinfo ENOTFOUND x.example' })).toBe('fail.dest_network');
    expect(causeOfSendFailure({ status: 429 })).toBe('fail.dest_overload');
    expect(causeOfSendFailure({ status: 400 })).toBe('wrong.config_dest_4xx');
    expect(causeOfSendFailure({ status: 401 })).toBe('wrong.config_dest_4xx');
    expect(causeOfSendFailure({ status: 0, error: 'circuit OPEN quá lâu' })).toBe('slow.deferred_circuit');
  });

  it('mapping luật cảnh báo cũ -> cause nằm cạnh causes.ts (LOGGING.md §7): mọi luật có cause hợp lệ', () => {
    for (const code of Object.keys(ALERT_RULES)) {
      const c = alertRuleCause(code);
      expect(c === null || isCause(c)).toBe(true);
    }
  });
});
