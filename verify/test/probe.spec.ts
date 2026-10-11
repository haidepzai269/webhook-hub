import * as path from 'path';
import { applyProbe, BB_PROBES, countsAsLeftoverProbe, judgeProbe, loadProbes, Probe, probeWorktreePid } from '../lib/probe';

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
    const ctl = [row('a [ZZ:9] x', 'passed')];
    expect(judgeProbe(p, [row('a [ZZ:9] x', 'failed')], ctl).ok).toBe(true);
    expect(judgeProbe(p, [row('a [ZZ:9] x', 'passed')], ctl).ok).toBe(false);
    expect(judgeProbe(p, [row('khác', 'failed')], ctl).ok).toBe(false);
    const g: Probe = { ...p, expectRed: undefined, expectGreen: ['[ZZ:5]'] };
    const gc = [row('[ZZ:5] a', 'passed'), row('[ZZ:5] b', 'passed')];
    expect(judgeProbe(g, gc, gc).ok).toBe(true);
    expect(judgeProbe(g, [row('[ZZ:5] a', 'passed'), row('[ZZ:5] b', 'failed')], gc).ok).toBe(false);
  });

  it('VF6: mọi probe trong verify/probes nạp được (id = tên file, có kỳ vọng); đủ 12 probe khởi điểm §6.3 và probe của verify:bb', () => {
    const all = loadProbes(path.join(__dirname, '..', 'probes')).map((x) => x.id);
    for (const id of ['P-BB2-01', 'P-BB3-01', 'P-BB3-02', 'P-BB5-01', 'P-BB5-02', 'P-SIG-01', 'P-SIG-02', 'P-AU-01', 'P-AU-02', 'P-AU-03', 'P-SSRF-01', 'P-BB1-01']) {
      expect(all).toContain(id);
    }
    for (const ids of Object.values(BB_PROBES)) for (const id of ids) expect(all).toContain(id);
  });

  // H-1 (REVIEW-VF-2026-10-11): đỏ phải đỏ ĐÚNG LÝ DO và test đích phải XANH trên code chưa phá (đối chứng).
  describe('H-1: đối chứng + lý do đỏ', () => {
    const row = (name: string, status: 'passed' | 'failed', failure?: string) => ({ name, file: 'f', status, failure });
    const red = (failure: string) => [row('a [ZZ:9] x', 'failed', failure)];
    const green = [row('a [ZZ:9] x', 'passed')];

    it('VF6 (H-1): KHÔNG có lượt đối chứng, hoặc đối chứng không xanh (test đích vốn đỏ / môi trường hỏng) -> INVALID, không phải ✅', () => {
      expect(judgeProbe(p, red('Expected: 1 Received: 2'), undefined)).toMatchObject({ ok: false, invalid: true });
      expect(judgeProbe(p, red('Expected: 1 Received: 2'), red('vốn đã đỏ'))).toMatchObject({ ok: false, invalid: true });
      expect(judgeProbe(p, red('Expected: 1 Received: 2'), green)).toMatchObject({ ok: true, invalid: false });
    });

    it('VF6 (H-1): đỏ vì môi trường (ECONNREFUSED, Invalid URL, Cannot find module, TypeError, timeout) -> ✗ "đỏ sai lý do"', () => {
      for (const msg of ['connect ECONNREFUSED 127.0.0.1:15433', 'TypeError: Invalid URL', "Cannot find module '@hub/x'", 'TypeError: x is not a function', 'Exceeded timeout of 5000 ms']) {
        const v = judgeProbe(p, red(msg), green);
        expect([msg, v.ok]).toEqual([msg, false]);
        expect(v.detail.join(' ')).toMatch(/sai lý do/);
      }
    });

    it('VF6 (H-1): expectFailure (regex) phải khớp thông điệp lỗi của test đỏ; mã màu ANSI được bỏ trước khi so', () => {
      const q: Probe = { ...p, expectFailure: 'toBeGreaterThanOrEqual' };
      expect(judgeProbe(q, red('\u001b[2mexpect(\u001b[22mr.status).toBeGreaterThanOrEqual(500)'), green).ok).toBe(true);
      expect(judgeProbe(q, red('expect(x).toBe(1)'), green).ok).toBe(false);
      const env: Probe = { ...p, expectFailure: 'ECONNREFUSED' };
      // L-R2-1: khai expectFailure KHÔNG tắt bộ lọc môi trường — muốn chấp nhận lý do môi trường phải khai allowEnvReason.
      expect(judgeProbe(env, red('connect ECONNREFUSED'), green).ok).toBe(false);
      expect(judgeProbe({ ...env, allowEnvReason: true }, red('connect ECONNREFUSED'), green).ok).toBe(true);
    });

    it('VF6 (L-R2-1): expectFailure khớp nhưng thông điệp là lỗi môi trường (TypeError: Invalid URL ... Expected: true) -> đỏ sai lý do', () => {
      const q: Probe = { ...p, expectFailure: 'Expected: true' };
      const v = judgeProbe(q, red('TypeError: Invalid URL\nExpected: true\nReceived: false'), green);
      expect(v.ok).toBe(false);
      expect(v.detail.join(' ')).toMatch(/sai lý do/);
      expect(judgeProbe(q, red('expect(received).toBe(expected)\nExpected: true\nReceived: false'), green).ok).toBe(true);
    });
  });

  // L-R2-3: kiểm VT11 "worktree sót" không đếm worktree của một lượt probe KHÁC còn sống (phiên song song).
  describe('L-R2-3: worktree probe sót', () => {
    const line = (name: string) => `C:/webhook-hub/.claude/worktrees/${name}  1234abc (detached HEAD)`;
    it('VF6 (L-R2-3): pid lấy từ tên worktree (tên thư mục hoặc dòng `git worktree list`)', () => {
      expect(probeWorktreePid('probe-P-KN1-12860')).toBe(12860);
      expect(probeWorktreePid(line('probe-P-BB5-02-777'))).toBe(777);
      expect(probeWorktreePid(line('khac-1'))).toBeNull();
    });
    it('VF6 (L-R2-3): tính là SÓT khi là của chính lượt này hoặc pid đã chết; worktree của tiến trình khác còn sống thì bỏ qua', () => {
      const alive = (pid: number) => pid === 12860 || pid === 500;
      expect(countsAsLeftoverProbe(line('probe-P-KN1-12860'), 500, alive)).toBe(false); // phiên KN song song
      expect(countsAsLeftoverProbe(line('probe-P-SIG-02-500'), 500, alive)).toBe(true); // của mình
      expect(countsAsLeftoverProbe(line('probe-P-SIG-02-99'), 500, alive)).toBe(true); // pid chết
      expect(countsAsLeftoverProbe(line('khac-12860'), 500, alive)).toBe(false); // không phải worktree probe
    });
  });
});
