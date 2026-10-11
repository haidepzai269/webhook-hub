'use strict';
/**
 * ADR-129 — chế độ `docker-entrypoint.sh hub-all` (DEPLOYMENT §3.2 phương án D, Render free không có Background Worker):
 * MỘT container, HAI tiến trình Node riêng (hub-api + hub-worker) — BB-4 vẫn giữ: hai process, hai AMQP connection,
 * hai pool Prisma; chỉ chung vỏ container. Đây là lựa chọn TRIỂN KHAI vì giới hạn free tier, không phải kiến trúc.
 *
 * Supervisor (PID 1, không phụ thuộc gói ngoài):
 * - SIGTERM/SIGINT -> chuyển cho CẢ HAI con, chờ cả hai thoát trong SHUTDOWN_TIMEOUT_MS (mặc định 25 s — Render SIGKILL
 *   sau ~30 s); quá hạn -> SIGKILL phần còn lại. Thoát 0 nếu cả hai thoát gọn, 1 nếu phải SIGKILL.
 * - Một con thoát khi KHÔNG được yêu cầu -> SIGTERM con kia, chờ như trên, thoát ≠ 0 để Render khởi động lại container
 *   (không bao giờ ở trạng thái "nửa sống": api còn nhận webhook mà không ai giao).
 * - Log: dòng JSON (pino) giữ nguyên, thêm trường "proc":"api"|"worker"; dòng thường thêm tiền tố "[api] " / "[worker] ".
 * - Pool Prisma theo từng con: `connection_limit` trong DATABASE_URL được đặt lại = HUB_ALL_API_DB_CONNECTIONS (mặc định 5)
 *   / HUB_ALL_WORKER_DB_CONNECTIONS (mặc định 5). Worker: WORKER_METRICS_PORT mặc định 0 (tắt). Heap: HUB_ALL_API_HEAP_MB /
 *   HUB_ALL_WORKER_HEAP_MB -> --max-old-space-size (mặc định 200 / 220 MB cho container 512 MB).
 */
const { spawn } = require('child_process');
const readline = require('readline');

function withConnectionLimit(url, n) {
  if (!url || !n) return url;
  try {
    const u = new URL(url);
    u.searchParams.set('connection_limit', String(n));
    return u.toString();
  } catch {
    return url;
  }
}

/**
 * Chép từng DÒNG log của con ra `out`. D-1: `proc` đặt SAU spread — con không giả được nhãn. D-4: `out.write` trả false
 * (stdout chậm, vd log Render) -> tạm dừng đọc của con tới khi `drain` (log không dồn vô hạn trong RAM supervisor).
 */
function pipeLines(stream, out, tag) {
  const rl = readline.createInterface({ input: stream });
  let paused = false;
  const write = (text) => {
    if (!out.write(text) && !paused) {
      paused = true;
      rl.pause();
      out.once('drain', () => {
        paused = false;
        rl.resume();
      });
    }
  };
  rl.on('line', (line) => {
    if (line.startsWith('{') && line.endsWith('}')) {
      try {
        write(`${JSON.stringify({ ...JSON.parse(line), proc: tag })}\n`);
        return;
      } catch {
        /* không phải JSON hợp lệ -> tiền tố */
      }
    }
    write(`[${tag}] ${line}\n`);
  });
}

/**
 * Env của hai con (ADR-129 + review D-5/D-6):
 * - D-5: `DIRECT_URL` (owner, vượt RLS) chỉ cần cho migrate đã chạy XONG ở hub_prestart -> con nhận `DIRECT_URL = DATABASE_URL`
 *   (hub_app; Prisma vẫn thấy biến của `directUrl` nhưng không còn quyền owner), bỏ `HUB_APP_DB_PASSWORD`.
 * - D-6: con drain trong `SHUTDOWN_TIMEOUT_MS - 3000` (22 s) — supervisor SIGKILL ở mốc 25 s, không cắt ngang lúc con đang kết thúc.
 */
function buildChildEnvs(env) {
  const supervisorTimeout = parseInt(env.SHUTDOWN_TIMEOUT_MS || '25000', 10);
  const childTimeout = String(Math.max(1000, supervisorTimeout - 3000));
  const base = { ...env, SHUTDOWN_TIMEOUT_MS: childTimeout };
  delete base.HUB_APP_DB_PASSWORD;
  const forChild = (conns) => {
    const url = withConnectionLimit(env.DATABASE_URL, conns);
    return { ...base, DATABASE_URL: url, DIRECT_URL: url };
  };
  return {
    supervisorTimeout,
    api: forChild(env.HUB_ALL_API_DB_CONNECTIONS || '5'),
    worker: { ...forChild(env.HUB_ALL_WORKER_DB_CONNECTIONS || '5'), WORKER_METRICS_PORT: env.WORKER_METRICS_PORT ?? '0' },
  };
}

/**
 * @param {{name:string, cmd:string, args:string[], cwd?:string, env?:Record<string,string>}[]} specs
 * @param {{timeoutMs?:number, log?:(m:string)=>void, exit?:(code:number)=>void, stdout?:NodeJS.WritableStream, stderr?:NodeJS.WritableStream}} opts
 */
function supervise(specs, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 25_000;
  const log = opts.log ?? ((m) => process.stderr.write(`${JSON.stringify({ proc: 'supervisor', msg: m })}\n`));
  const exit = opts.exit ?? ((code) => process.exit(code));
  const stdout = opts.stdout ?? process.stdout;
  const stderr = opts.stderr ?? process.stderr;
  const children = specs.map((s) => {
    const child = spawn(s.cmd, s.args, { cwd: s.cwd, env: s.env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    pipeLines(child.stdout, stdout, s.name);
    pipeLines(child.stderr, stderr, s.name);
    return { name: s.name, child, exited: false, code: null };
  });
  let stopping = false;
  let failed = false;
  let killTimer = null;
  let finished = false;

  const finish = () => {
    if (finished || !children.every((c) => c.exited)) return;
    finished = true;
    if (killTimer) clearTimeout(killTimer);
    const code = failed ? 1 : 0;
    log(`tất cả tiến trình con đã thoát -> exit ${code}`);
    exit(code);
  };

  const stopAll = (signal, reason) => {
    if (stopping) return;
    stopping = true;
    log(`dừng (${reason}): gửi ${signal} cho ${children.filter((c) => !c.exited).map((c) => c.name).join(', ') || 'không ai'}; chờ tối đa ${timeoutMs} ms`);
    for (const c of children) if (!c.exited) c.child.kill(signal);
    killTimer = setTimeout(() => {
      for (const c of children) {
        if (!c.exited) {
          failed = true;
          log(`${c.name} chưa thoát sau ${timeoutMs} ms -> SIGKILL`);
          c.child.kill('SIGKILL');
        }
      }
    }, timeoutMs);
    killTimer.unref?.();
    finish();
  };

  for (const c of children) {
    c.child.on('exit', (code, signal) => {
      c.exited = true;
      c.code = code;
      log(`${c.name} thoát (code=${code}, signal=${signal ?? '-'})`);
      if (!stopping) {
        failed = true; // một con chết ngoài ý muốn: không để nửa sống
        stopAll('SIGTERM', `${c.name} thoát ngoài ý muốn`);
      } else if (code !== 0 && signal !== 'SIGTERM' && signal !== 'SIGINT') {
        if (code !== null && code !== 0 && code !== 143 && code !== 130) failed = true;
      }
      finish();
    });
    c.child.on('error', (err) => {
      log(`${c.name} không chạy được: ${err.message}`);
      c.exited = true;
      failed = true;
      stopAll('SIGTERM', `${c.name} lỗi spawn`);
      finish();
    });
  }
  const onSignal = (sig) => stopAll(sig, `nhận ${sig}`);
  return { children, stop: onSignal };
}

function main() {
  const env = process.env;
  const heap = (mb, def) => `--max-old-space-size=${parseInt(mb || def, 10)}`;
  const { supervisorTimeout: timeoutMs, api: apiEnv, worker: workerEnv } = buildChildEnvs(env);
  const sup = supervise(
    [
      { name: 'api', cmd: process.execPath, args: [heap(env.HUB_ALL_API_HEAP_MB, '200'), 'dist/apps/hub-api/src/main.js'], cwd: 'apps/hub-api', env: apiEnv },
      { name: 'worker', cmd: process.execPath, args: [heap(env.HUB_ALL_WORKER_HEAP_MB, '220'), 'dist/apps/hub-worker/src/main.js'], cwd: 'apps/hub-worker', env: workerEnv },
    ],
    { timeoutMs },
  );
  process.on('SIGTERM', () => sup.stop('SIGTERM'));
  process.on('SIGINT', () => sup.stop('SIGINT'));
}

if (require.main === module) main();

module.exports = { supervise, withConnectionLimit, buildChildEnvs };
