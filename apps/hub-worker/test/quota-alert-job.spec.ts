import { QuotaAlertJob, QUOTA_STATE_KEY } from '../src/scheduler/quota-alert.job';

const MB = 1024 * 1024;
const TOKEN = '123456:SECRET-token_value';

function makeRedis(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial));
  const r: any = {
    store,
    info: jest.fn(async () => `total_commands_processed:${r.cmds}\r\nused_memory:${r.mem}\r\n`),
    cmds: 1000,
    mem: 1 * MB,
    get: jest.fn(async (k: string) => store.get(k) ?? null),
    set: jest.fn(async (k: string, v: string, ...rest: any[]) => {
      if (rest.includes('NX') && store.has(k)) return null;
      store.set(k, v);
      return 'OK';
    }),
  };
  return r;
}

function make(opts: { redis?: any; size?: number; env?: Record<string, string | undefined> } = {}) {
  const env = { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: '-100', ...opts.env };
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) {
    saved[k] = process.env[k];
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  const prisma: any = { databaseSizeBytes: jest.fn(async () => opts.size ?? 100 * MB) };
  const redis = opts.redis ?? makeRedis();
  const job = new QuotaAlertJob(prisma, redis);
  for (const k of Object.keys(saved)) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  let now = Date.parse('2026-10-19T00:00:00Z');
  job.clock = () => now;
  const fetchMock = jest.fn(async () => ({ ok: true, status: 200, text: async () => '' }) as any);
  job.fetchImpl = fetchMock as any;
  return { job, prisma, redis, fetchMock, advance: (ms: number) => (now += ms) };
}

describe('QuotaAlertJob (ADR-263)', () => {
  it('thiếu token hoặc chat: no-op hoàn toàn, không gọi gì', async () => {
    for (const env of [{ TELEGRAM_BOT_TOKEN: undefined }, { TELEGRAM_CHAT_ID: undefined }]) {
      const { job, prisma, redis, fetchMock } = make({ env });
      expect(job.enabled).toBe(false);
      job.start();
      const r = await job.runOnce();
      expect(r.skipped).toBe(true);
      expect(prisma.databaseSizeBytes).not.toHaveBeenCalled();
      expect(redis.set).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    }
  });

  it('dưới ngưỡng: không gửi; vượt 80%: gửi một tin kèm số liệu; lần sau cùng mức: im', async () => {
    const { job, prisma, fetchMock, advance } = make({ size: 100 * MB });
    await job.tick();
    expect(fetchMock).not.toHaveBeenCalled();
    prisma.databaseSizeBytes.mockResolvedValue(450 * MB);
    const r = await job.tick();
    expect(r.sent).toEqual([{ id: 'neon_storage', kind: 'up', ok: true }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as any[];
    expect(url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
    const body = JSON.parse(init.body);
    expect(body.chat_id).toBe('-100');
    expect(body.text).toContain('Neon');
    expect(body.text).toContain('87.9%');
    advance(15 * 60_000);
    await job.tick();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // lên critical = báo; nhắc lại sau 24h
    prisma.databaseSizeBytes.mockResolvedValue(500 * MB);
    await job.tick();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    advance(24 * 3_600_000);
    await job.tick();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(JSON.parse((fetchMock.mock.calls[2] as any[])[1].body).text).toContain('nhắc lại');
    // hạ mức
    prisma.databaseSizeBytes.mockResolvedValue(10 * MB);
    const d = await job.tick();
    expect(d.sent[0]).toMatchObject({ kind: 'down' });
  });

  it('trạng thái sống qua khởi động lại: instance mới đọc key Redis, không báo lại', async () => {
    const redis = makeRedis();
    const a = make({ redis, size: 450 * MB });
    await a.job.tick();
    expect(a.fetchMock).toHaveBeenCalledTimes(1);
    expect(redis.store.has(QUOTA_STATE_KEY)).toBe(true);
    const b = make({ redis, size: 450 * MB }); // "sáng hôm sau": tiến trình mới, cùng Redis
    await b.job.tick();
    expect(b.fetchMock).not.toHaveBeenCalled();
  });

  it('Redis mất key: báo lại đúng một lần (đánh đổi đã chốt), không sai', async () => {
    const b = make({ size: 450 * MB, redis: makeRedis() });
    await b.job.tick();
    expect(b.fetchMock).toHaveBeenCalledTimes(1);
  });

  it('lỗi gửi (mạng / 5xx / 4xx): không ném, không ghi "đã báo", lượt sau thử lại; không lộ token', async () => {
    const { job, fetchMock } = make({ size: 450 * MB });
    const logs: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    (process.stdout as any).write = (c: any, ...a: any[]) => (logs.push(String(c)), true);
    try {
      fetchMock.mockRejectedValueOnce(new Error(`connect ECONNRESET https://api.telegram.org/bot${TOKEN}/sendMessage`));
      const r1 = await job.tick();
      expect(r1.sent[0].ok).toBe(false);
      fetchMock.mockResolvedValueOnce({ ok: false, status: 500, text: async () => `oops ${TOKEN}` } as any);
      const r2 = await job.tick();
      expect(r2.sent[0].ok).toBe(false);
      fetchMock.mockResolvedValueOnce({ ok: false, status: 400, text: async () => 'bad chat' } as any);
      await job.tick();
      const r4 = await job.tick(); // thành công
      expect(r4.sent[0]).toMatchObject({ kind: 'up', ok: true });
      expect((await job.tick()).sent).toEqual([]);
    } finally {
      (process.stdout as any).write = orig;
    }
    expect(logs.join('')).not.toContain('SECRET-token_value');
  });

  it('Upstash: đếm lệnh cộng dồn từ INFO; vượt 80% trần 500k thì báo; ghi chú ước lượng', async () => {
    const redis = makeRedis();
    const { job, fetchMock, advance } = make({ redis });
    await job.tick(); // mốc đầu: acc 0
    let r = await job.tick();
    for (let i = 0; i < 4; i++) {
      advance(900_000); // kẹp 200/s × 900s = 180k mỗi nhịp
      redis.cmds += 105_000; // 4 nhịp = 420k = 84%
      r = await job.tick();
    }
    expect(r.readings.find((x) => x.id === 'upstash_commands')).toMatchObject({ used: 420_000, level: 'warning' });
    const text = JSON.parse((fetchMock.mock.calls[0] as any[])[1].body).text;
    expect(text).toContain('Upstash');
    expect(text).toContain('420,000');
    expect(text).toContain('ước lượng');
  });

  it('dung lượng Upstash chỉ đo khi đặt trần; INFO thiếu trường: bỏ qua, không ném', async () => {
    const redis = makeRedis();
    redis.mem = 250 * MB;
    const a = make({ redis, env: { QUOTA_UPSTASH_MEMORY_BYTES: String(256 * MB) } });
    const r = await a.job.tick();
    expect(r.readings.find((x) => x.id === 'upstash_memory')).toMatchObject({ level: 'critical' });
    const b = make({ redis: makeRedis() });
    expect((await b.job.tick()).readings.find((x) => x.id === 'upstash_memory')).toBeUndefined();
    const c = make({ redis: makeRedis() });
    c.redis.info.mockResolvedValue('# Server\r\nredis_version:6\r\n');
    await expect(c.job.tick()).resolves.toMatchObject({ skipped: false });
  });

  it('L2: Redis lỗi hoàn toàn: vẫn đo Neon, báo kèm dòng "trạng thái tạm", chống spam trong phiên', async () => {
    const redis = makeRedis();
    redis.get.mockRejectedValue(new Error('quota exceeded'));
    redis.set.mockRejectedValue(new Error('quota exceeded'));
    redis.info.mockRejectedValue(new Error('quota exceeded'));
    const { job, fetchMock } = make({ redis, size: 450 * MB });
    const r = await job.runOnce();
    expect(r.skipped).toBe(false);
    expect(r.sent).toEqual([{ id: 'neon_storage', kind: 'up', ok: true }]);
    expect(JSON.parse((fetchMock.mock.calls[0] as any[])[1].body).text).toContain('trạng thái tạm');
    await job.runOnce();
    expect(fetchMock).toHaveBeenCalledTimes(1); // không spam
    // Redis sống lại: nhập state, không báo lại mức đã báo
    redis.get.mockResolvedValue(null);
    redis.set.mockImplementation(async () => 'OK');
    await job.runOnce();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('L4: sau stop() không dựng kết nối Redis mới', async () => {
    const { job, prisma, fetchMock } = make({ size: 450 * MB });
    job.stop();
    expect((await job.runOnce()).skipped).toBe(true);
    expect(prisma.databaseSizeBytes).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('TB-1: bộ đếm INFO dao động giữa hai node không làm acc phồng', async () => {
    const redis = makeRedis();
    const { job, advance } = make({ redis });
    redis.cmds = 11_000_000;
    await job.tick();
    for (let i = 0; i < 6; i++) {
      advance(15 * 60_000);
      redis.cmds = i % 2 === 0 ? 9_000_000 : 11_000_000;
      const r = await job.tick();
      expect(r.readings.find((x) => x.id === 'upstash_commands')!.used).toBe(0);
    }
    expect((job as any).state.upstash.anomalies).toBeGreaterThanOrEqual(6);
  });

  it('khoá nhịp: instance thứ hai không chạy cùng lượt', async () => {
    const redis = makeRedis();
    const a = make({ redis, size: 450 * MB });
    const b = make({ redis, size: 450 * MB });
    expect((await a.job.runOnce()).skipped).toBe(false);
    expect((await b.job.runOnce()).skipped).toBe(true);
  });

  it('lỗi đọc Neon: bỏ Neon, vẫn đo Upstash, không ném', async () => {
    const { job, prisma } = make();
    prisma.databaseSizeBytes.mockRejectedValue(new Error('neon asleep'));
    const r = await job.tick();
    expect(r.readings.map((x) => x.id)).toEqual(['upstash_commands']);
  });

  it('degraded: không ghi đè state tốt trong Redis; hồi phục thì gộp rồi mới ghi', async () => {
    const good = { v: 1, resources: { neon_storage: { level: 'warning', notifiedAt: 5 } }, persistedAt: 1 };
    const redis = makeRedis({ [QUOTA_STATE_KEY]: JSON.stringify(good) });
    const realGet = redis.get.getMockImplementation()!;
    redis.get.mockRejectedValueOnce(new Error('blip'));
    const { job, prisma, fetchMock } = make({ redis, size: 450 * MB });
    await job.tick(); // degraded: state tạm trống -> báo up (kèm dòng tạm)
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(redis.store.get(QUOTA_STATE_KEY)!)).toEqual(good); // KHÔNG bị ghi đè
    prisma.databaseSizeBytes.mockResolvedValue(500 * MB); // critical
    redis.get.mockImplementation(realGet);
    await job.tick(); // hồi phục: gộp (bản tạm notifiedAt mới hơn thắng) rồi ghi
    const saved = JSON.parse(redis.store.get(QUOTA_STATE_KEY)!);
    expect(saved.resources.neon_storage.level).toBe('critical');
    expect(saved.resources.neon_storage.notifiedAt).toBeGreaterThan(5);
  });

  it('stop() rồi start() lại vẫn chạy được', async () => {
    const { job, fetchMock } = make({ size: 450 * MB });
    job.start();
    job.stop();
    expect((await job.runOnce()).skipped).toBe(true);
    job.start();
    expect((await job.runOnce()).skipped).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    job.stop();
  });
});
