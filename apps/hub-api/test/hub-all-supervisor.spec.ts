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
    expect(r.lines).toEqual(expect.arrayContaining(['{"proc":"api","level":30,"msg":"up"}', '[worker] dong thuong']));
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
