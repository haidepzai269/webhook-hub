import { HubRegistration, backoffMs } from '../src/hub-registration';

/**
 * R2-1 (review vòng 2, ADR-097): Shop KHÔNG BAO GIỜ bỏ cuộc đăng ký với hub (Render cold start 30–60s+): thử lại vô hạn,
 * backoff 10s -> 60s; webhook tới lúc chưa ghim thì gọi ensure ngay (một lần, dùng chung).
 */
describe('HubRegistration (R2-1)', () => {
  const log = { warn: jest.fn(), info: jest.fn() };
  const flush = () => new Promise((r) => setImmediate(r));

  it('R2-1: backoff 10s, 20s, 40s rồi giữ 60s', () => {
    expect([1, 2, 3, 4, 5, 9].map(backoffMs)).toEqual([10_000, 20_000, 40_000, 60_000, 60_000, 60_000]);
  });

  it('R2-1: hub chết 8 lần liền -> vẫn lên lịch thử lại (không bỏ cuộc); lần 9 thành công -> có sourceIds, dừng lịch', async () => {
    let calls = 0;
    const ensure = jest.fn(async () => {
      calls += 1;
      if (calls <= 8) throw Object.assign(new Error('ECONNREFUSED'), { code: 'network_error' });
      return ['S1', 'S2'];
    });
    const pending: (() => void)[] = [];
    const delays: number[] = [];
    const reg = new HubRegistration(ensure, log, (fn, ms) => {
      delays.push(ms);
      pending.push(fn);
      return 0;
    });
    reg.start();
    for (let i = 0; i < 9; i++) {
      await flush();
      const next = pending.shift();
      if (next) next();
    }
    await flush();
    expect(ensure).toHaveBeenCalledTimes(9);
    expect(delays).toEqual([10_000, 20_000, 40_000, 60_000, 60_000, 60_000, 60_000, 60_000]);
    expect(reg.trustedSourceIds).toEqual(['S1', 'S2']);
    expect(pending).toHaveLength(0);
  });

  it('R2-1: webhook tới lúc chưa ghim -> ensureNow dùng chung một lời gọi (single-flight)', async () => {
    let resolve!: (v: string[]) => void;
    const ensure = jest.fn(() => new Promise<string[]>((r) => (resolve = r)));
    const reg = new HubRegistration(ensure, log, () => 0);
    const a = reg.ensureNow();
    const b = reg.ensureNow();
    resolve(['S9']);
    expect(await Promise.all([a, b])).toEqual([true, true]);
    expect(ensure).toHaveBeenCalledTimes(1);
    expect(reg.trustedSourceIds).toEqual(['S9']);
  });
});
