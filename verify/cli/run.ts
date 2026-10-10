/**
 * VF2 (SPEC-verification §2, §3, §6.2): runner kiểm chứng.
 *
 *   npm run verify:unit            L0 — mọi *.spec.ts KHÔNG dùng describeDb. Không cần docker.
 *   npm run verify:db              L1 — mọi *.spec.ts dùng describeDb, RUN_DB_TESTS=1, Postgres/Redis của hubv.
 *                                  skip > 0 → ĐỎ (H1). hubv chưa lên → ĐỎ "skip > 0 ở L1".
 *   npm run verify                 L0 + L1 (+ L2 khi VF4 có runner).
 *   npm run verify:map [-- --story VF2]   sinh docs/TEST-MAP.md; mồ côi / ma / trùng → ĐỎ.
 *   npm run verify -- --evidence   in khối "Verify:" cho commit từ lần chạy cuối (không chạy lại).
 *
 * jest LUÔN chạy với --maxWorkers=2 (máy dev từng sập Docker vì hết RAM). Ngoại lệ duy nhất: biến
 * VERIFY_JEST_WORKERS (CI đặt). L1 nhận VERIFY_DATABASE_URL / VERIFY_REDIS_URL / VERIFY_DB_OWNER_URL nếu có
 * (CI dùng service container), không thì trỏ hubv (localhost:15433 / 16379).
 */
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import { hostUrls, ROOT } from '../lib/compose';
import { analyzeMap, declaredCodes, MapResult, scanTags, SourcesConfig } from '../lib/map';
import { layerVerdict, ratchet, relFile, Summary, summarizeJest, unreachableSummary } from '../lib/results';

const VERIFY_DIR = path.join(ROOT, 'verify');
const RESULTS_DIR = path.join(VERIFY_DIR, '.results');
const LAST_RUN = path.join(VERIFY_DIR, '.last-run.json');
const LAST_RED = path.join(VERIFY_DIR, '.last-red.json');
const BASELINE = path.join(VERIFY_DIR, 'baseline.json');
const SOURCES = path.join(VERIFY_DIR, 'spec-sources.json');
const TEST_MAP = path.join(ROOT, 'docs', 'TEST-MAP.md');
const SCAN_DIRS = ['apps', 'libs', 'verify', 'tools'];
const SKIP_DIRS = new Set(['node_modules', 'dist', '.next', '.results', '.git']);

type Layer = 'L0' | 'L1';

function walk(dir: string, match: (f: string) => boolean, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, match, out);
    else if (match(p)) out.push(p);
  }
  return out;
}

export function specFiles(): string[] {
  return SCAN_DIRS.flatMap((d) => walk(path.join(ROOT, d), (f) => f.endsWith('.spec.ts'))).map((f) => relFile(f, ROOT)).sort();
}

/** Tầng của file test: dùng describeDb (helper §4.3) = L1, còn lại L0. */
export function layerOfFile(file: string): Layer {
  const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
  return /\bdescribe(Db|Redis)\s*\(/.test(text) ? 'L1' : 'L0';
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function git(args: string[]): string {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  return (r.stdout ?? '').trim();
}

function tcpReachable(url: string, timeoutMs = 2000): Promise<boolean> {
  const u = new URL(url);
  const port = Number(u.port || (u.protocol.startsWith('redis') ? 6379 : 5432));
  return new Promise((resolve) => {
    const s = net.connect({ host: u.hostname, port });
    const done = (ok: boolean) => {
      s.destroy();
      resolve(ok);
    };
    s.setTimeout(timeoutMs, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

function runJest(layer: Layer, files: string[], env: NodeJS.ProcessEnv): { summary: Summary; ms: number } {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const out = path.join(RESULTS_DIR, `${layer}.json`);
  if (fs.existsSync(out)) fs.unlinkSync(out);
  const workers = process.env.VERIFY_JEST_WORKERS || '2';
  const jestBin = path.join(ROOT, 'node_modules', 'jest', 'bin', 'jest.js');
  const args = [jestBin, `--maxWorkers=${workers}`, '--json', `--outputFile=${out}`, '--runTestsByPath', ...files];
  console.log(`\n▶ ${layer}: jest --maxWorkers=${workers} (${files.length} file)`);
  const t0 = Date.now();
  const r = spawnSync(process.execPath, args, { cwd: ROOT, env, stdio: ['ignore', 'inherit', 'inherit'] });
  const ms = Date.now() - t0;
  if (!fs.existsSync(out)) {
    return { summary: { pass: 0, fail: 1, skip: 0, tests: [], note: `jest không ghi kết quả (exit ${r.status})` }, ms };
  }
  return { summary: summarizeJest(JSON.parse(fs.readFileSync(out, 'utf8')), ROOT), ms };
}

async function runLayer(layer: Layer): Promise<{ summary: Summary; ms: number }> {
  const files = specFiles().filter((f) => layerOfFile(f) === layer);
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (layer === 'L0') {
    delete env.RUN_DB_TESTS; // L0 không bao giờ chạm DB
    return runJest('L0', files, env);
  }
  const hv = hostUrls();
  const dbUrl = process.env.VERIFY_DATABASE_URL || hv.DATABASE_URL;
  const redisUrl = process.env.VERIFY_REDIS_URL || hv.REDIS_URL;
  Object.assign(env, {
    RUN_DB_TESTS: '1',
    DATABASE_URL: dbUrl,
    DIRECT_URL: dbUrl,
    REDIS_URL: redisUrl,
    VERIFY_DB_OWNER_URL: process.env.VERIFY_DB_OWNER_URL || dbUrl,
  });
  const [pgOk, redisOk] = await Promise.all([tcpReachable(dbUrl), tcpReachable(redisUrl)]);
  if (!pgOk || !redisOk) {
    const baseline = readJson<Record<string, number>>(BASELINE, {});
    const what = [!pgOk && `Postgres ${new URL(dbUrl).host}`, !redisOk && `Redis ${new URL(redisUrl).host}`].filter(Boolean).join(', ');
    return { summary: unreachableSummary(baseline.L1 ?? files.length, `${what} không kết nối được — chưa \`npm run verify:up\`?`), ms: 0 };
  }
  return runJest('L1', files, env);
}

function fmtRow(cols: (string | number)[]): string {
  const w = [6, 6, 6, 6, 8];
  return cols.map((c, i) => String(c).padStart(w[i] ?? 6)).join(' |');
}

async function verify(layers: Layer[]): Promise<number> {
  const results: Record<string, { summary: Summary; ms: number }> = {};
  const problems: string[] = [];
  for (const layer of layers) {
    const r = await runLayer(layer);
    results[layer] = r;
    problems.push(...layerVerdict(layer, r.summary));
    // Tầng thấp đỏ thì không chạy tầng cao hơn (§2)
    if (r.summary.fail > 0) break;
  }

  // Bánh cóc §3.3
  let baseline = readJson<Record<string, number>>(BASELINE, {});
  const commitMsg = [git(['log', '-1', '--format=%B']), process.env.VERIFY_BASELINE_NOTE ?? ''].join('\n');
  const ratchetNotes: string[] = [];
  for (const [layer, r] of Object.entries(results)) {
    if (r.summary.fail > 0 || r.summary.note) continue;
    const rr = ratchet(baseline, layer, r.summary.pass, commitMsg);
    ratchetNotes.push(rr.message);
    if (!rr.ok) problems.push(rr.message);
    baseline = rr.baseline;
  }
  fs.writeFileSync(BASELINE, JSON.stringify(baseline, null, 2) + '\n');

  // Lưu lần chạy cuối (giữ tầng không chạy lần này)
  const last = readJson<any>(LAST_RUN, { layers: {} });
  last.at = new Date().toISOString();
  last.commit = git(['rev-parse', '--short', 'HEAD']);
  for (const [layer, r] of Object.entries(results)) {
    last.layers[layer] = { pass: r.summary.pass, fail: r.summary.fail, skip: r.summary.skip, ms: r.ms, note: r.summary.note, at: last.at, tests: r.summary.tests.map(({ failure, ...t }) => t) };
  }
  fs.writeFileSync(LAST_RUN, JSON.stringify(last, null, 2) + '\n');

  const failures = Object.entries(results).flatMap(([layer, r]) => r.summary.tests.filter((t) => t.status === 'failed').map((t) => ({ layer, ...t })));
  if (failures.length > 0) {
    fs.writeFileSync(
      LAST_RED,
      JSON.stringify(
        {
          at: last.at,
          commit: last.commit,
          failures: failures.slice(0, 20).map((f) => ({
            layer: f.layer,
            name: f.name,
            file: f.file,
            lines: (f.failure ?? '').replace(/\x1b\[[0-9;]*m/g, '').split('\n').map((l) => l.trim()).filter((l) => /Expected|Received|Error|expect\(/.test(l)).slice(0, 3),
          })),
        },
        null,
        2,
      ) + '\n',
    );
  }

  console.log('\n' + fmtRow(['tầng', 'pass', 'fail', 'skip', 'thời gian']));
  for (const layer of ['L0', 'L1', 'L2']) {
    const r = results[layer];
    if (r) console.log(fmtRow([layer, r.summary.pass, r.summary.fail, r.summary.skip, `${Math.round(r.ms / 1000)}s`]) + (r.summary.note ? `   ${r.summary.note}` : ''));
    else if (layer === 'L2' && layers.length > 1) console.log(fmtRow(['L2', '—', '—', '—', '—']) + '   chưa có runner L2 (VF4) — không tính');
  }
  for (const n of ratchetNotes) console.log(`  bánh cóc: ${n}`);
  if (problems.length > 0) {
    console.log('\n✗ ĐỎ:\n  - ' + problems.join('\n  - '));
    return 1;
  }
  console.log('\n✓ xanh');
  return 0;
}

// ---------------------------------------------------------------- map

function loadMap(): { config: SourcesConfig; result: MapResult; declared: ReturnType<typeof declaredCodes>; missing: string[] } {
  const config = readJson<SourcesConfig>(SOURCES, null as any);
  const missing: string[] = [];
  const read = (f: string) => {
    const p = path.join(ROOT, f);
    if (!fs.existsSync(p)) {
      missing.push(f);
      return '';
    }
    return fs.readFileSync(p, 'utf8');
  };
  const declared = declaredCodes(config, read);
  const scenarioFiles = walk(path.join(VERIFY_DIR, 'scenarios'), (f) => f.endsWith('.ts')).map((f) => relFile(f, ROOT));
  const files = [...specFiles(), ...scenarioFiles].map((file) => ({ file, text: fs.readFileSync(path.join(ROOT, file), 'utf8') }));
  return { config, result: analyzeMap(declared, scanTags(files), config), declared, missing };
}

function layerLabel(file: string): string {
  if (file.startsWith('verify/scenarios/')) return 'L2*';
  return file.endsWith('.spec.ts') ? layerOfFile(file) : '?';
}

function writeTestMap(m: ReturnType<typeof loadMap>): void {
  const last = readJson<any>(LAST_RUN, { layers: {} });
  const statusOf = (key: string): string => {
    const tag = `[${key}]`;
    const sts: string[] = [];
    for (const l of Object.values<any>(last.layers ?? {})) for (const t of l.tests ?? []) if (t.name.includes(tag)) sts.push(t.status);
    if (sts.length === 0) return 'chưa chạy';
    if (sts.includes('failed')) return '❌ fail';
    if (sts.includes('skipped')) return '⏭ skip';
    return '✅ pass';
  };
  const rows: string[] = [];
  const keys = [...m.declared.keys()].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  for (const key of keys) {
    const d = m.declared.get(key)!;
    const hits = m.result.covered.get(key) ?? [];
    const accepted = m.config.acceptedOrphans[key];
    if (hits.length === 0 && !(d.done && d.requireTest)) continue; // chỉ liệt kê mã có test hoặc mã bắt buộc
    const where = hits.map((h) => `${h.file}:${h.line}`).join('<br>') || '—';
    const layer = [...new Set(hits.map((h) => layerLabel(h.file)))].join(',') || '—';
    const state = hits.length > 0 ? statusOf(key) : accepted ? `mồ côi có lý do: ${accepted}` : '**MỒ CÔI**';
    rows.push(`| \`${key}\` | ${d.file.split('/').pop()}${d.story ? ` · ${d.story}` : ''} | ${layer} | ${where} | ${state} |`);
  }
  const untagged = specFiles()
    .map((file) => ({ file, n: (fs.readFileSync(path.join(ROOT, file), 'utf8').match(/^\s*(it|test)(\.each\([^)]*\))?\s*\(/gm) ?? []).length }))
    .filter((x) => x.n > 0);
  const md = [
    '# TEST-MAP — mã spec → test (tự sinh, đừng sửa tay)',
    '',
    `> Sinh bởi \`npm run verify:map\` (VF2, SPEC-verification §3.2). Trạng thái lấy từ lần \`verify\` cuối (${last.at ?? 'chưa chạy'}, commit ${last.commit ?? '—'}).`,
    '> Chỉ liệt kê mã đã có test, hoặc mã của story đã xong (bắt buộc có test). Mã của story chưa làm được phép mồ côi.',
    '> `L2*` = kịch bản tự kiểm của bộ kiểm chứng (`verify/scenarios`), chạy bằng tay qua `npm run verify:selftest`.',
    '',
    `Tổng: ${m.declared.size} mã khai báo · ${m.result.covered.size} mã có test · ${m.result.orphans.length} mồ côi · ${m.result.acceptedOrphans.length} mồ côi có lý do · ${m.result.ghosts.length} ma · ${m.result.dups.length} trùng.`,
    '',
    '| mã | spec · story | tầng | file:dòng | trạng thái lần chạy cuối |',
    '|---|---|---|---|---|',
    ...rows,
    '',
    `## File test (${untagged.length} file, ${untagged.reduce((s, x) => s + x.n, 0)} khai báo it/test)`,
    '',
    'Test không ứng với dòng spec nào thì không mang mã (§3.1) — vẫn chạy ở L0/L1 và được bánh cóc đếm.',
    '',
  ].join('\n');
  fs.writeFileSync(TEST_MAP, md);
}

function mapCmd(story?: string): number {
  const m = loadMap();
  if (m.missing.length > 0) {
    console.log(`✗ thiếu file spec nguồn (spec-sources.json): ${m.missing.join(', ')} — commit spec trước khi chạy map/CI.`);
    return 1;
  }
  writeTestMap(m);
  const r = m.result;
  if (story) {
    const mine = [...m.declared.values()].filter((d) => d.story === story);
    console.log(`Story ${story}: ${mine.length} mã`);
    for (const d of mine) console.log(`  ${r.covered.has(d.key) ? '✓' : '·'} ${d.key}${r.covered.has(d.key) ? '  ' + r.covered.get(d.key)!.map((h) => `${h.file}:${h.line}`).join(', ') : '  (mồ côi)'}`);
  }
  console.log(`map: ${m.declared.size} mã khai báo · ${r.covered.size} có test · ${r.orphans.length} mồ côi · ${r.acceptedOrphans.length} mồ côi có lý do · ${r.ghosts.length} ma · ${r.dups.length} trùng → docs/TEST-MAP.md`);
  for (const o of r.orphans) console.log(`  MỒ CÔI ${o.key} (${o.file}:${o.line}${o.story ? `, story ${o.story}` : ''})`);
  for (const g of r.ghosts) console.log(`  MA     ${g.key} ở ${g.file}:${g.line}`);
  for (const d of r.dups) console.log(`  TRÙNG  ${d.key}: ${d.hits.map((h) => `${h.file}:${h.line}`).join(', ')} — thêm "(phần a/b)"`);
  return r.ok ? 0 : 1;
}

function evidence(): number {
  const last = readJson<any>(LAST_RUN, null);
  if (!last) {
    console.log('Chưa có lần chạy nào (verify/.last-run.json).');
    return 1;
  }
  const red = readJson<any>(LAST_RED, null);
  const m = loadMap();
  const lines = ['Verify:'];
  for (const f of red?.failures?.slice(0, 3) ?? []) {
    const code = /\[[A-Z]{2}:[^\]]+\]/.exec(f.name)?.[0] ?? f.name.slice(0, 60);
    lines.push(`  RED   ${code} ${(f.lines ?? []).join(' ').slice(0, 140)}   (${red.at}, ${red.commit})`);
  }
  for (const layer of ['L0', 'L1', 'L2']) {
    const l = last.layers?.[layer];
    if (l) lines.push(`  ${layer.padEnd(4)} ${String(l.pass).padStart(4)} pass / ${l.fail} fail / ${l.skip} skip  ${Math.round(l.ms / 1000)}s${l.note ? ` (${l.note})` : ''}`);
  }
  const r = m.result;
  lines.push(`  map   ${r.covered.size} mã có test · ${r.orphans.length} mồ côi · ${r.acceptedOrphans.length} mồ côi có lý do · ${r.ghosts.length} ma · ${r.dups.length} trùng`);
  console.log(lines.join('\n'));
  return 0;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const flag = (n: string) => rest.includes(n);
  const opt = (n: string) => (rest.includes(n) ? rest[rest.indexOf(n) + 1] : undefined);
  if (flag('--evidence')) process.exit(evidence());
  switch (cmd) {
    case 'unit':
      process.exit(await verify(['L0']));
    case 'db':
      process.exit(await verify(['L1']));
    case 'all': {
      const code = await verify(['L0', 'L1']);
      const mapCode = mapCmd();
      process.exit(code || mapCode);
    }
    case 'map':
      process.exit(mapCmd(opt('--story')));
    default:
      console.error('Dùng: run.ts unit|db|all|map [--story X] [--evidence]');
      process.exit(2);
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
