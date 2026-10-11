import * as path from 'path';
import { applyProbe, BB_PROBES, judgeProbe, loadProbes, Probe } from '../lib/probe';

/** VF6 (SPEC-verification §6.3, §12): logic thuần của `verify:probe` — áp đột biến, phán kết quả. */
describe('verify:probe — áp + phán', () => {
  const p: Probe = { id: 'P-X', claim: 'x', file: 'a.ts', find: 'a();\nb();', replace: 'b();', expectRed: ['[ZZ:9]'], layer: 'L0' };

  it('[VF:VT10] probe có `find` không còn khớp -> "probe MỤC" (đỏ), không âm thầm bỏ qua', () => {
    const r = applyProbe('khác hẳn\n', p);
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toMatch(/probe MỤC/);
  });

  it('VF6: find khớp >1 chỗ -> mơ hồ (đỏ); file CRLF vẫn khớp find viết LF và giữ CRLF khi ghi lại', () => {
    expect((applyProbe('a();\nb();\na();\nb();\n', p) as { reason: string }).reason).toMatch(/mơ hồ/);
    const r = applyProbe('x\r\na();\r\nb();\r\ny\r\n', p) as { ok: true; text: string };
    expect(r.ok).toBe(true);
    expect(r.text).toBe('x\r\nb();\r\ny\r\n');
  });

  it('VF6: replace có "$&"/"$1" được chèn NGUYÊN VĂN (không bị hiểu là mẫu thay thế)', () => {
    const r = applyProbe('a();\nb();', { find: 'a();\nb();', replace: 'x = `$&$1`;' }) as { ok: true; text: string };
    expect(r.text).toBe('x = `$&$1`;');
  });

  it('VF6: phán — expectRed cần ít nhất một test khớp ĐỎ; expectGreen cần mọi test khớp XANH; không khớp test nào = đỏ', () => {
    const row = (name: string, status: 'passed' | 'failed') => ({ name, file: 'f', status });
    expect(judgeProbe(p, [row('a [ZZ:9] x', 'failed')]).ok).toBe(true);
    expect(judgeProbe(p, [row('a [ZZ:9] x', 'passed')]).ok).toBe(false);
    expect(judgeProbe(p, [row('khác', 'failed')]).ok).toBe(false);
    const g: Probe = { ...p, expectRed: undefined, expectGreen: ['[ZZ:5]'] };
    expect(judgeProbe(g, [row('[ZZ:5] a', 'passed'), row('[ZZ:5] b', 'passed')]).ok).toBe(true);
    expect(judgeProbe(g, [row('[ZZ:5] a', 'passed'), row('[ZZ:5] b', 'failed')]).ok).toBe(false);
  });

  it('VF6: mọi probe trong verify/probes nạp được (id = tên file, có kỳ vọng); đủ 12 probe khởi điểm §6.3 và probe của verify:bb', () => {
    const all = loadProbes(path.join(__dirname, '..', 'probes')).map((x) => x.id);
    for (const id of ['P-BB2-01', 'P-BB3-01', 'P-BB3-02', 'P-BB5-01', 'P-BB5-02', 'P-SIG-01', 'P-SIG-02', 'P-AU-01', 'P-AU-02', 'P-AU-03', 'P-SSRF-01', 'P-BB1-01']) {
      expect(all).toContain(id);
    }
    for (const ids of Object.values(BB_PROBES)) for (const id of ids) expect(all).toContain(id);
  });
});
