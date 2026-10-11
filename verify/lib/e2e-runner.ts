/**
 * VF4 (SPEC-verification §2 L2): gom kịch bản L2.
 *   - File kịch bản dạng module (`ScenarioFile`, vd `verify/scenarios/ingest-e2e.ts`) chạy TRONG tiến trình.
 *   - Bộ kịch bản cũ dạng script (`auth-e2e.ts`, tự `process.exit`) chạy như tiến trình con; dòng `✓ …`/`✗ …` của nó
 *     thành hàng kết quả, dòng `∅ …` (bỏ qua vì thiếu hạ tầng, vd web hubv chưa lên) tính SKIP — L2 không được skip (§4.2).
 * Không import code hub.
 */
import { spawnSync } from 'child_process';
import * as net from 'net';
import * as path from 'path';
import { ROOT } from './compose';
import { Summary, TestRow } from './results';
import { runScenarioFiles, ScenarioFile } from './scenario';

/** Script cũ: tag để lọc (không truyền tag = chạy). Không bao giờ `@deployed-safe` (đăng ký + mail capture + Redis). */
export const EXTERNAL_SUITES: { file: string; tags: string[] }[] = [{ file: 'verify/scenarios/auth-e2e.ts', tags: ['auth', 'AU1', 'AU2', 'AU3', 'AU4', 'AU5', 'AU6'] }];

/** File kịch bản module — thêm file mới vào đây (mỗi spec tự thêm kịch bản của mình). */
export const SCENARIO_MODULES = ['verify/scenarios/ingest-e2e.ts'];

export interface L2Options {
  tags: string[];
  deployed: boolean;
  apiUrl: string;
}

export function parseExternalOutput(out: string, file: string): TestRow[] {
  const rows: TestRow[] = [];
  for (const ln of out.split(/\r?\n/)) {
    const m = /^([✓✗∅])\s+(.*)$/.exec(ln);
    if (!m) continue;
    if (m[1] === '✓') rows.push({ name: m[2].replace(/\s+\(\d+ms\)$/, ''), file, status: 'passed' });
    else if (m[1] === '✗') rows.push({ name: m[2].split(': ')[0], file, status: 'failed', failure: m[2] });
    else rows.push({ name: m[2], file, status: 'skipped' });
  }
  return rows;
}

function reachable(url: string, timeoutMs = 2000): Promise<boolean> {
  const u = new URL(url);
  return new Promise((resolve) => {
    const s = net.connect({ host: u.hostname, port: Number(u.port || (u.protocol === 'https:' ? 443 : 80)) });
    const done = (ok: boolean) => {
      s.destroy();
      resolve(ok);
    };
    s.setTimeout(timeoutMs, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

export async function runL2(o: L2Options): Promise<Summary> {
  if (!(await reachable(o.apiUrl))) {
    return { pass: 0, fail: 0, skip: 1, tests: [], note: `hub-api ${o.apiUrl} không kết nối được — chưa \`npm run verify:up\`?` };
  }
  const env = { ...process.env, VERIFY_API_URL: o.apiUrl, ...(o.deployed ? { VERIFY_DEPLOYED: '1' } : {}) };
  Object.assign(process.env, env);
  const files: ScenarioFile[] = [];
  for (const m of SCENARIO_MODULES) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require(path.join(ROOT, m));
    files.push((mod.default ?? mod) as ScenarioFile);
  }
  const s = await runScenarioFiles(files, o.tags, o.deployed);
  const tests = [...s.tests];
  if (!o.deployed) {
    for (const ext of EXTERNAL_SUITES) {
      if (o.tags.length > 0 && !o.tags.some((t) => ext.tags.includes(t))) continue;
      console.log(`\n▶ L2 ${ext.file}`);
      const ts = path.join(ROOT, 'node_modules', 'ts-node', 'dist', 'bin.js');
      const r = spawnSync(process.execPath, [ts, '--transpile-only', '-P', 'tsconfig.json', ext.file], { cwd: ROOT, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      process.stdout.write(r.stdout ?? '');
      process.stderr.write(r.stderr ?? '');
      const rows = parseExternalOutput(r.stdout ?? '', ext.file);
      if (rows.length === 0 || (r.status !== 0 && !rows.some((x) => x.status === 'failed'))) {
        rows.push({ name: `(suite) ${ext.file}`, file: ext.file, status: 'failed', failure: `exit ${r.status}: ${(r.stderr ?? '').slice(-500)}` });
      }
      tests.push(...rows);
    }
  }
  return {
    pass: tests.filter((t) => t.status === 'passed').length,
    fail: tests.filter((t) => t.status === 'failed').length,
    skip: tests.filter((t) => t.status === 'skipped').length,
    tests,
  };
}
