import * as http from 'http';
import { AddressInfo } from 'net';
import { workerRegistry, startMetricsServer, setReadinessProbe } from '../src/metrics';
import { beat, heartbeatAgeMs, isHeartbeatFresh, resetHeartbeatForTest, pingExternalOnce, startExternalHeartbeat } from '../src/heartbeat';

describe('worker heartbeat nội bộ (ADR-248)', () => {
  beforeEach(resetHeartbeatForTest);

  it('beat() cập nhật gauge hub_worker_heartbeat_timestamp_seconds (unix giây)', async () => {
    beat(1_700_000_000_500);
    const text = await workerRegistry.metrics();
    expect(text).toMatch(/^hub_worker_heartbeat_timestamp_seconds 1700000000\.5$/m);
  });

  it('chưa beat lần nào -> không tươi; beat xong thì tươi, quá hạn thì cũ', () => {
    expect(isHeartbeatFresh(45_000, 1_000)).toBe(false);
    beat(10_000);
    expect(heartbeatAgeMs(15_000)).toBe(5_000);
    expect(isHeartbeatFresh(45_000, 15_000)).toBe(true);
    expect(isHeartbeatFresh(45_000, 10_000 + 45_001)).toBe(false);
  });
});

describe('HEARTBEAT_URL — dead-man switch (ADR-248)', () => {
  beforeEach(resetHeartbeatForTest);
  const log = { warn: jest.fn() };

  it('khoẻ (beat mới) -> GET URL với timeout ngắn', async () => {
    beat(1_000);
    const f = jest.fn(async () => ({ ok: true, status: 200 }) as any);
    expect(await pingExternalOnce({ url: 'https://hc.example/abc', fetchFn: f, now: 2_000, log })).toBe('sent');
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0] as any[];
    expect(url).toBe('https://hc.example/abc');
    expect(init.signal).toBeDefined();
  });

  it('heartbeat nội bộ cũ -> KHÔNG gọi (để dịch vụ ngoài báo)', async () => {
    beat(1_000);
    const f = jest.fn();
    expect(await pingExternalOnce({ url: 'https://hc.example/abc', fetchFn: f as any, now: 1_000 + 120_000, log })).toBe('stale');
    expect(f).not.toHaveBeenCalled();
  });

  it('lỗi mạng chỉ log, không ném, và không lộ URL (URL của Healthchecks là bí mật)', async () => {
    beat(1_000);
    const f = jest.fn(async () => {
      throw new Error('ECONNRESET');
    });
    await expect(pingExternalOnce({ url: 'https://hc.example/abc', fetchFn: f as any, now: 1_500, log })).resolves.toBe('error');
    expect(log.warn).toHaveBeenCalled();
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain('hc.example/abc');
  });

  it('HTTP không 2xx -> coi là lỗi (log), không ném', async () => {
    beat(1_000);
    const f = jest.fn(async () => ({ ok: false, status: 500 }) as any);
    await expect(pingExternalOnce({ url: 'https://hc.example/abc', fetchFn: f, now: 1_500, log })).resolves.toBe('error');
  });

  it('không đặt URL -> no-op hoàn toàn: không timer, không fetch', () => {
    const f = jest.fn();
    expect(startExternalHeartbeat({ url: undefined, fetchFn: f as any })).toBeNull();
    expect(startExternalHeartbeat({ url: '  ', fetchFn: f as any })).toBeNull();
    expect(f).not.toHaveBeenCalled();
  });

  it('đặt URL -> timer gọi theo chu kỳ và dừng được', async () => {
    jest.useFakeTimers();
    try {
      beat(Date.now());
      const f = jest.fn(async () => ({ ok: true, status: 200 }) as any);
      const h = startExternalHeartbeat({ url: 'https://hc.example/abc', intervalMs: 1000, fetchFn: f, log })!;
      expect(h).not.toBeNull();
      await jest.advanceTimersByTimeAsync(3100);
      expect(f.mock.calls.length).toBeGreaterThanOrEqual(3);
      h.stop();
      const n = f.mock.calls.length;
      await jest.advanceTimersByTimeAsync(5000);
      expect(f.mock.calls.length).toBe(n);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('worker :9101 /health/live + /health/ready (ADR-248)', () => {
  async function freePort() {
    const s = http.createServer();
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    const p = (s.address() as AddressInfo).port;
    await new Promise<void>((r) => s.close(() => r()));
    return p;
  }
  const get = (port: number, path: string) =>
    new Promise<{ status: number; body: any }>((resolve, reject) => {
      http
        .get(`http://127.0.0.1:${port}${path}`, (res) => {
          let b = '';
          res.on('data', (c) => (b += c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: b ? JSON.parse(b) : null }));
        })
        .on('error', reject);
    });

  it('live luôn 200 (không gọi probe); ready: chưa có probe 503, probe ok 200, probe fail 503', async () => {
    const port = await freePort();
    const probe = jest.fn();
    setReadinessProbe(null);
    const ms = startMetricsServer(port, undefined)!;
    await new Promise((r) => ms.once('listening', r));
    try {
      expect((await get(port, '/health/live')).status).toBe(200);
      expect((await get(port, '/health/ready')).status).toBe(503); // chưa subscribe
      setReadinessProbe(async () => (probe(), { ok: true, checks: { consumers: 'up', postgres: 'up' } }));
      const ok = await get(port, '/health/ready');
      expect(ok.status).toBe(200);
      expect(ok.body.status).toBe('ready');
      setReadinessProbe(async () => ({ ok: false, checks: { consumers: 'up', postgres: 'down' } }));
      const bad = await get(port, '/health/ready');
      expect(bad.status).toBe(503);
      expect(bad.body.checks.postgres).toBe('down');
      probe.mockClear();
      await get(port, '/health/live');
      expect(probe).not.toHaveBeenCalled();
    } finally {
      setReadinessProbe(null);
      await new Promise<void>((r) => ms.close(() => r()));
    }
  });
});
