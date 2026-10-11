import * as fs from 'fs';
import * as path from 'path';
import { checkArgs, loadSteps } from '../cli/demo';

/** VF8 (SPEC-verification §9.1, §9.2): kịch bản 14 bước hợp lệ, tự kiểm chỉ trỏ vào thứ có thật, không đụng deployed. */
describe('demo — verify/demo/steps.yaml', () => {
  const steps = loadSteps();
  const ROOT = path.resolve(__dirname, '..', '..');

  it('VF8: đúng 14 bước, ba hồi theo §9.1 (1–4 · 5–9 · 10–14); hồi 2 ở LOCAL, hồi 1 và 3 ở DEPLOYED', () => {
    expect(steps.map((s) => s.step)).toEqual(Array.from({ length: 14 }, (_, i) => i + 1));
    expect(steps.map((s) => s.act)).toEqual([1, 1, 1, 1, 2, 2, 2, 2, 2, 3, 3, 3, 3, 3]);
    for (const s of steps) expect([s.step, s.env]).toEqual([s.step, s.act === 2 ? 'local' : 'deployed']);
  });

  it('VF8: bước có tự kiểm chỉ ở LOCAL, và tag/file được kiểm TỒN TẠI (kịch bản e2e/chaos hoặc file test)', () => {
    const scen = ['ingest-e2e.ts', 'chaos-l3.ts'].map((f) => fs.readFileSync(path.join(ROOT, 'verify', 'scenarios', f), 'utf8')).join('\n');
    const checked = steps.filter((s) => s.check);
    expect(checked.length).toBeGreaterThanOrEqual(2);
    for (const s of checked) {
      expect(s.env).toBe('local');
      if (s.check!.kind === 'jest') expect(fs.existsSync(path.join(ROOT, s.check!.file!))).toBe(true);
      else expect(scen).toContain(`'${s.check!.tag}'`);
      expect(checkArgs(s.check!)[0]).toBe('verify/cli/run.ts');
    }
  });

  it('VF8: tổng ngân sách thời gian ≤ 11 phút (mục tiêu tập dượt §9.3)', () => {
    expect(steps.reduce((t, s) => t + s.timeoutS, 0)).toBeLessThanOrEqual(11 * 60);
  });
});
