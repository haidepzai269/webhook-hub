import { InFlightTracker } from '../src/consumers/in-flight';

/** Review SPEC-1 #3: shutdown phải chờ handler đang chạy xong (trong SHUTDOWN_TIMEOUT_MS) rồi mới đóng channel. */
describe('InFlightTracker', () => {
  it('waitIdle chờ mọi handler đang chạy xong rồi trả true', async () => {
    const t = new InFlightTracker();
    let release!: () => void;
    t.track(new Promise<void>((r) => (release = r)));
    t.track(Promise.resolve());
    expect(t.count).toBeGreaterThanOrEqual(1);

    let done = false;
    const idle = t.waitIdle(5_000).then((v) => ((done = true), v));
    await new Promise((r) => setTimeout(r, 20));
    expect(done).toBe(false);
    release();
    expect(await idle).toBe(true);
    expect(t.count).toBe(0);
  });

  it('handler treo quá timeout -> waitIdle trả false (để shutdown vẫn kết thúc trước SIGKILL)', async () => {
    const t = new InFlightTracker();
    t.track(new Promise<void>(() => {}));
    expect(await t.waitIdle(30)).toBe(false);
    expect(t.count).toBe(1);
  });

  it('handler ném lỗi vẫn được đếm xong, không làm rơi unhandled rejection', async () => {
    const t = new InFlightTracker();
    t.track(Promise.reject(new Error('boom')));
    expect(await t.waitIdle(1_000)).toBe(true);
  });

  it('không có gì đang chạy -> trả true ngay', async () => {
    expect(await new InFlightTracker().waitIdle(10)).toBe(true);
  });
});
