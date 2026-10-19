import { SENTRY_FLUSH_AFTER_TIMEOUT_MS, shutdownWithinBudget } from '../src/shutdown';

/** ADR-258 bổ sung: flush Sentry nằm TRONG ngân sách SHUTDOWN_TIMEOUT_MS; quá hạn chỉ thêm nhát ngắn. */
describe('shutdownWithinBudget', () => {
  it('thành công: flush chạy SAU work, trần min(2s, phần còn lại)', async () => {
    const calls: Array<[string, number?]> = [];
    await shutdownWithinBudget(async () => { calls.push(['work']); }, 10_000, async (ms) => { calls.push(['flush', ms]); });
    expect(calls).toEqual([['work'], ['flush', 2000]]);
  });

  it('work ăn gần hết ngân sách: flush chỉ được phần còn lại (không vượt hạn)', async () => {
    let t = 0;
    const now = () => t;
    let got = -1;
    await shutdownWithinBudget(async () => { t = 24_500; }, 25_000, async (ms) => { got = ms; }, now);
    expect(got).toBe(500);
  });

  it('quá hạn: ném, và flush thêm tối đa 300 ms', async () => {
    const flushes: number[] = [];
    await expect(shutdownWithinBudget(() => new Promise<void>(() => undefined), 30, async (ms) => { flushes.push(ms); })).rejects.toThrow(/timeout/);
    expect(flushes).toEqual([SENTRY_FLUSH_AFTER_TIMEOUT_MS]);
  });
});
