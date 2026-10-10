import { layerVerdict, ratchet, summarizeJest, unreachableSummary } from '../lib/results';

const jestJson = (statuses: string[]) => ({
  testResults: [
    {
      name: 'C:/repo/libs/x/test/a.spec.ts',
      assertionResults: statuses.map((status, i) => ({ fullName: `t${i}`, status, failureMessages: status === 'failed' ? ['Expected: 1\nReceived: 2'] : [] })),
    },
  ],
});

describe('verify runner — phán quyết tầng + bánh cóc', () => {
  it('summarizeJest đếm pass/fail/skip (pending + todo = skip)', () => {
    const s = summarizeJest(jestJson(['passed', 'passed', 'failed', 'pending', 'todo']), 'C:/repo');
    expect([s.pass, s.fail, s.skip]).toEqual([2, 1, 2]);
    expect(s.tests[2]).toMatchObject({ file: 'libs/x/test/a.spec.ts', status: 'failed' });
  });

  it('[VF:VT1] L1 có skip (vd chưa verify:up / quên RUN_DB_TESTS) → đỏ "skip > 0 ở L1"; L0 thì skip không chặn', () => {
    const skipped = summarizeJest(jestJson(['passed', 'pending']), 'C:/repo');
    expect(layerVerdict('L1', skipped)).toEqual([expect.stringContaining('skip > 0 ở L1')]);
    expect(layerVerdict('L0', skipped)).toEqual([]);
    // hubv không chạy: runner không gọi jest, mọi test L1 tính là skip → vẫn đỏ đúng lý do
    const down = unreachableSummary(30);
    expect(layerVerdict('L1', down)).toEqual([expect.stringContaining('skip > 0 ở L1')]);
  });

  it('fail > 0 → đỏ ở mọi tầng', () => {
    expect(layerVerdict('L0', summarizeJest(jestJson(['failed']), 'C:/repo'))).toEqual([expect.stringContaining('fail')]);
  });

  it('[VF:VT2] số pass giảm so với baseline → đỏ, trừ khi commit có "Verify-Baseline: giảm N vì … ADR-xxx"', () => {
    const base = { L0: 100, L1: 30 };
    expect(ratchet(base, 'L0', 99, '').ok).toBe(false);
    expect(ratchet(base, 'L0', 99, 'Verify-Baseline: giảm 1 vì bỏ test trùng').ok).toBe(false); // thiếu ADR
    expect(ratchet(base, 'L0', 99, 'feat: x\n\nVerify-Baseline: giảm 1 vì bỏ test trùng (ADR-070)').ok).toBe(true);
    expect(ratchet(base, 'L0', 97, 'Verify-Baseline: giảm 1 vì x ADR-070').ok).toBe(false); // giảm nhiều hơn khai
    const up = ratchet(base, 'L0', 104, '');
    expect(up).toMatchObject({ ok: true, baseline: { L0: 104, L1: 30 } });
  });
});
