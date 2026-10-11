import { PassThrough } from 'stream';

/**
 * ADR-129: supervisor của `docker-entrypoint.sh hub-all` (docker/hub-all.js) với tiến trình Node THẬT làm con.
 * Con "api"/"worker" giả: in một dòng JSON + một dòng thường, chạy mãi; nhận SIGTERM thì "drain" rồi thoát 0.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { supervise, withConnectionLimit } = require('../../../docker/hub-all.js');

const drainer = (drainMs: number) =>
  `console.log(JSON.stringify({level:30,msg:'up'}));console.log('dong thuong');` +
  `process.on('SIGTERM',()=>setTimeout(()=>process.exit(0),${drainMs}));setInterval(()=>{},1000);`;
const crasher = (afterMs: number) => `setTimeout(()=>process.exit(3),${afterMs});setInterval(()=>{},1000);`;
const stubborn = `process.on('SIGTERM',()=>{});setInterval(()=>{},1000);`;

function run(specs: { name: string; code: string }[], timeoutMs = 3000) {
  const out = new PassThrough();
  const lines: string[] = [];
  out.on('data', (d) => lines.push(...String(d).split('\n').filter(Boolean)));
  const logs: string[] = [];
  let resolveExit!: (c: number) => void;
  const exited = new Promise<number>((r) => (resolveExit = r));
  const t0 = Date.now();
  const sup = supervise(
    specs.map((s) => ({ name: s.name, cmd: process.execPath, args: ['-e', s.code] })),
    { timeoutMs, log: (m: string) => logs.push(m), exit: resolveExit, stdout: out, stderr: out },
  );
  return { sup, exited, lines, logs, t0, alive: () => sup.children.filter((c: any) => !c.exited).map((c: any) => c.name) };
}
const POSIX = process.platform !== 'win32';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('review hub-all (REVIEW-DEPLOY D-1, D-4, D-5, D-6)', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { buildChildEnvs } = require('../../../docker/hub-all.js');

  it('[AR:D-1] con in {"proc":"supervisor"} KHÔNG giả được nhãn — proc luôn là tên con', async () => {
    const r = run([
      { name: 'api', code: `console.log(JSON.stringify({proc:'supervisor',msg:'spoof'}));setInterval(()=>{},1000);` },
      { name: 'worker', code: drainer(10) },
    ]);
    await sleep(600);
    r.sup.stop('SIGTERM');
    await r.exited;
    expect(r.lines).toContain('{"proc":"api","msg":"spoof"}');
  }, 15_000);

  it('[AR:D-4] stdout chậm (highWaterMark nhỏ, ghi trễ) -> đọc của con tạm dừng theo drain, bộ đệm ghi bị chặn (< 400 KB, không tăng theo output), 40000 dòng tới ĐỦ và ĐÚNG thứ tự', async () => {
    const { Writable } = require('stream');
    const got: string[] = [];
    let drains = 0;
    let maxBuffered = 0;
    let writes = 0;
    const slow = new Writable({
      highWaterMark: 64,
      write(chunk: Buffer, _e: string, cb: () => void) {
        got.push(...String(chunk).split('\n').filter(Boolean));
        if (++writes % 200 === 0) setTimeout(cb, 5);
        else setImmediate(cb);
      },
    });
    slow.on('drain', () => drains++);
    const origWrite = slow.write.bind(slow);
    (slow as any).write = (...args: any[]) => {
      const ok = (origWrite as any)(...args);
      maxBuffered = Math.max(maxBuffered, slow.writableLength);
      return ok;
    };
    let resolveExit!: (c: number) => void;
    const exited = new Promise<number>((res) => (resolveExit = res));
    supervise(
      [
        { name: 'api', cmd: process.execPath, args: ['-e', `for(let i=0;i<40000;i++)console.log('dong '+i);`] },
        { name: 'worker', cmd: process.execPath, args: ['-e', drainer(10)] },
      ],
      { timeoutMs: 3000, log: () => undefined, exit: resolveExit, stdout: slow, stderr: slow },
    );
    await exited; // api thoát (code 0, ngoài ý muốn) -> worker bị dừng
    for (let i = 0; i < 200 && got.filter((l) => l.startsWith('[api]')).length < 40000; i++) await sleep(50);
    const api = got.filter((l) => l.startsWith('[api]'));
    expect(api).toHaveLength(40000);
    expect(api[39999]).toBe('[api] dong 39999');
    expect(api.every((l, i) => l === `[api] dong ${i}`)).toBe(true);
    expect(drains).toBeGreaterThan(0);
    expect(maxBuffered).toBeLessThan(400_000); // ≈ vài lượt đọc 64 KB của con (đo ~280 KB); KHÔNG pause: ~670 KB và tăng theo output
  }, 30_000);

  it('[AR:D-5] (và D-6) env con: DIRECT_URL (owner) bị thay bằng chuỗi hub_app, HUB_APP_DB_PASSWORD bị bỏ; con drain 22 s, supervisor SIGKILL ở 25 s', () => {
    const e = buildChildEnvs({
      DATABASE_URL: 'postgresql://hub_app:p@h-pooler/db?sslmode=require&pgbouncer=true&connection_limit=1',
      DIRECT_URL: 'postgresql://neondb_owner:OWNER@h/db?sslmode=require',
      HUB_APP_DB_PASSWORD: 'x',
      SHUTDOWN_TIMEOUT_MS: '25000',
      HUB_ALL_WORKER_DB_CONNECTIONS: '4',
    });
    expect(e.supervisorTimeout).toBe(25000);
    for (const c of [e.api, e.worker]) {
      expect(c.DIRECT_URL).toBe(c.DATABASE_URL);
      expect(JSON.stringify(c)).not.toContain('neondb_owner');
      expect(c.HUB_APP_DB_PASSWORD).toBeUndefined();
      expect(c.SHUTDOWN_TIMEOUT_MS).toBe('22000');
    }
    expect(e.api.DATABASE_URL).toContain('connection_limit=5');
    expect(e.worker.DATABASE_URL).toContain('connection_limit=4');
    expect(e.worker.WORKER_METRICS_PORT).toBe('0');
  });
});

describe('hub-all supervisor (ADR-129)', () => {
  it('[AU:HA1] một con chết ngoài ý muốn -> con kia bị SIGTERM, supervisor thoát ≠ 0 (không nửa sống)', async () => {
    const r = run([
      { name: 'api', code: drainer(100) },
      { name: 'worker', code: crasher(400) },
    ]);
    const code = await r.exited;
    expect(code).toBe(1);
    expect(r.alive()).toEqual([]);
    expect(r.logs.join('\n')).toMatch(/worker thoát \(code=3/);
    expect(r.logs.join('\n')).toMatch(/gửi SIGTERM cho api/);
  }, 15_000);

  it('[AU:HA2] SIGTERM -> CẢ HAI con nhận, drain xong trong hạn -> exit 0; log JSON giữ nguyên + trường proc, dòng thường có tiền tố', async () => {
    const r = run([
      { name: 'api', code: drainer(300) },
      { name: 'worker', code: drainer(600) },
    ]);
    await sleep(700);
    r.sup.stop('SIGTERM');
    const code = await r.exited;
    expect(code).toBe(0);
    expect(r.logs.join('\n')).toMatch(/gửi SIGTERM cho api, worker/);
    expect(r.lines).toEqual(expect.arrayContaining(['{"level":30,"msg":"up","proc":"api"}', '[worker] dong thuong']));
  }, 15_000);

  it('[AU:HA3] con không chịu thoát khi SIGTERM -> SIGKILL sau SHUTDOWN_TIMEOUT_MS, exit 1; withConnectionLimit đặt pool theo từng con', async () => {
    const r = run([
      { name: 'api', code: drainer(50) },
      { name: 'worker', code: stubborn },
    ], 800);
    await sleep(500);
    r.sup.stop('SIGTERM');
    const code = await r.exited;
    expect(Date.now() - r.t0).toBeLessThan(5000);
    if (POSIX) {
      expect(code).toBe(1);
      expect(r.logs.join('\n')).toMatch(/worker chưa thoát sau 800 ms -> SIGKILL/);
    } else {
      // Windows không có tín hiệu thật: kill('SIGTERM') = TerminateProcess -> con "cứng đầu" vẫn chết ngay. Nhánh SIGKILL
      // được kiểm trên Linux: scripts/hub-all-e2e.sh chạy spec này trong container node:22 (ADR-129).
      expect(code).toBe(0);
    }
    expect(withConnectionLimit('postgresql://u:p@h/db?sslmode=require&connection_limit=1&pgbouncer=true', '5')).toBe(
      'postgresql://u:p@h/db?sslmode=require&connection_limit=5&pgbouncer=true',
    );
  }, 15_000);
});
