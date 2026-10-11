/**
 * VF2 (SPEC-verification §2, §3, §6.2): runner kiểm chứng.
 *
 *   npm run verify:unit            L0 — mọi *.spec.ts KHÔNG dùng describeDb. Không cần docker.
 *   npm run verify:db              L1 — mọi *.spec.ts dùng describeDb, RUN_DB_TESTS=1, Postgres/Redis của hubv.
 *                                  skip > 0 → ĐỎ (H1). hubv chưa lên → ĐỎ "skip > 0 ở L1".
 *   npm run verify:e2e [-- --tag smoke]   L2 — kịch bản HTTP vào hubv (VF4, verify/lib/e2e-runner.ts). Lọc tag thì
 *                                  KHÔNG cập nhật bánh cóc (tập con).
 *   npm run verify:deployed        L2 chỉ kịch bản `@deployed-safe`, vào VERIFY_API_URL (bắt buộc). Không bánh cóc.
 *   npm run verify                 L0 + L1 + L2.
 *   npm run verify:chaos           L3 — kill/restart/pause container hubv (VF5, verify/scenarios/chaos-l3.ts).
 *   npm run verify:all             L0 → L3.
 *   npm run verify:probe -- P-BB3-01 | --all [--overlay a,b]   probe §6.3 trong git worktree tạm (VF6).
 *   npm run verify:bb              bảng 5 bất biến: test BB:n xanh + probe đỏ (§8.2).
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
import { hostUrls, loadVerifyEnv, ROOT } from '../lib/compose';
import { analyzeMap, declaredCodes, MapResult, scanTags, SourcesConfig } from '../lib/map';
import { layerVerdict, ratchet, relFile, Summary, summarizeJest, unreachableSummary } from '../lib/results';
import { CHAOS_MODULES, L2Options, runL2 } from '../lib/e2e-runner';
import { isLocalUrl } from '../lib/local-url';
import { applyProbe, BB_PROBES, judgeProbe, loadProbes, Probe } from '../lib/probe';

const VERIFY_DIR = path.join(ROOT, 'verify');
const RESULTS_DIR = path.join(VERIFY_DIR, '.results');
const LAST_RUN = path.join(VERIFY_DIR, '.last-run.json');
const LAST_RED = path.join(VERIFY_DIR, '.last-red.json');
const BASELINE = path.join(VERIFY_DIR, 'baseline.json');
const SOURCES = path.join(VERIFY_DIR, 'spec-sources.json');
const TEST_MAP = path.join(ROOT, 'docs', 'TEST-MAP.md');
const SCAN_DIRS = ['apps', 'libs', 'verify', 'tools'];
const SKIP_DIRS = new Set(['node_modules', 'dist', '.next', '.results', '.git']);

type Layer = 'L0' | 'L1' | 'L2' | 'L3';

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

function runJest(layer: Layer, files: string[], env: NodeJS.ProcessEnv, cwd = ROOT, tag: string = layer): { summary: Summary; ms: number } {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const out = path.join(RESULTS_DIR, `${tag}.json`);
  if (fs.existsSync(out)) fs.unlinkSync(out);
  const workers = process.env.VERIFY_JEST_WORKERS || '2';
  const jestBin = path.join(ROOT, 'node_modules', 'jest', 'bin', 'jest.js');
  const args = [jestBin, `--maxWorkers=${workers}`, '--json', `--outputFile=${out}`, '--runTestsByPath', ...files];
  console.log(`\n▶ ${layer}: jest --maxWorkers=${workers} (${files.length} file)`);
  const t0 = Date.now();
  const r = spawnSync(process.execPath, args, { cwd, env, stdio: ['ignore', 'inherit', 'inherit'] });
  const ms = Date.now() - t0;
  if (!fs.existsSync(out)) {
    return { summary: { pass: 0, fail: 1, skip: 0, tests: [], note: `jest không ghi kết quả (exit ${r.status})` }, ms };
  }
  return { summary: summarizeJest(JSON.parse(fs.readFileSync(out, 'utf8')), cwd), ms };
}

/** Env của L1 (Postgres/Redis hubv, role hub_app cho code đang test, owner chỉ cho fixture — §4.3). */
function l1Env(): { env: NodeJS.ProcessEnv; dbUrl: string; redisUrl: string } {
  const hv = hostUrls();
  const dbUrl = process.env.VERIFY_DATABASE_URL || hv.DATABASE_URL;
  const redisUrl = process.env.VERIFY_REDIS_URL || hv.REDIS_URL;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    RUN_DB_TESTS: '1',
    DATABASE_URL: dbUrl,
    // AU6: owner chỉ cho fixture (newTestPrisma('owner')) + migrate; code đang test chạy bằng DATABASE_URL (hub_app).
    DIRECT_URL: process.env.VERIFY_DB_OWNER_URL || hv.DIRECT_URL,
    REDIS_URL: redisUrl,
    VERIFY_DB_OWNER_URL: process.env.VERIFY_DB_OWNER_URL || hv.DIRECT_URL,
    // S12 (ADR-082): dữ liệu mã hoá mà L1 ghi vào DB hubv phải đọc được bởi hub-api hubv (và ngược lại) -> cùng
    // MASTER_KEY của .env.verify. Không đặt thì seed.ts (dotenv) lấy MASTER_KEY của .env DEV -> lệch khoá.
    MASTER_KEY: process.env.VERIFY_MASTER_KEY || loadVerifyEnv().MASTER_KEY,
  };
  return { env, dbUrl, redisUrl };
}

function l0Env(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.RUN_DB_TESTS; // L0 không bao giờ chạm DB
  return env;
}

async function runLayer(layer: Layer, l2opt?: L2Options): Promise<{ summary: Summary; ms: number }> {
  // L2/L3 mới cần URL (và guard M-3); L0/L1 không bị chặn bởi VERIFY_API_URL lạ.
  const l2 = layer === 'L2' || layer === 'L3' ? (l2opt ?? defaultL2()) : (l2opt as L2Options);
  if (layer === 'L3') {
    if (l2.deployed) throw new Error('L3 chaos không bao giờ chạy vào deployed');
    console.log(`
▶ L3: chaos → ${l2.apiUrl} (docker compose -p hubv kill/restart/pause)`);
    const t0 = Date.now();
    const summary = await runL2({ ...l2, tags: l2.tags.length ? l2.tags : ['chaos'] }, CHAOS_MODULES, false);
    return { summary, ms: Date.now() - t0 };
  }
  if (layer === 'L2') {
    console.log(`
▶ L2: kịch bản e2e → ${l2.apiUrl}${l2.tags.length ? ` (tag ${l2.tags.join(', ')})` : ''}${l2.deployed ? ' [deployed: chỉ @deployed-safe]' : ''}`);
    const t0 = Date.now();
    const summary = await runL2(l2);
    return { summary, ms: Date.now() - t0 };
  }
  const files = specFiles().filter((f) => layerOfFile(f) === layer);
  if (layer === 'L0') return runJest('L0', files, l0Env());
  const { env, dbUrl, redisUrl } = l1Env();
  const [pgOk, redisOk] = await Promise.all([tcpReachable(dbUrl), tcpReachable(redisUrl)]);
  if (!pgOk || !redisOk) {
    const baseline = readJson<Record<string, number>>(BASELINE, {});
    const what = [!pgOk && `Postgres ${new URL(dbUrl).host}`, !redisOk && `Redis ${new URL(redisUrl).host}`].filter(Boolean).join(', ');
    return { summary: unreachableSummary(baseline.L1 ?? files.length, `${what} không kết nối được — chưa \`npm run verify:up\`?`), ms: 0 };
  }
  return runJest('L1', files, env);
}

function defaultL2(): L2Options {
  const apiUrl = process.env.VERIFY_API_URL || hostUrls().HUB_API_URL;
  // M-3: chỉ verify:deployed được trỏ ra ngoài. e2e/chaos/verify đăng ký user, bắn webhook, kill container — vào
  // production là ghi rác + đốt quota. Biến VERIFY_API_URL còn sót từ lần chạy verify:deployed không được lọt vào đây.
  if (!isLocalUrl(apiUrl)) {
    console.error(`✗ VERIFY_API_URL=${apiUrl} không phải hubv local (localhost/127.0.0.1/::1/hub-api/hubv-*). Lệnh này chỉ chạy local — dùng npm run verify:deployed cho môi trường thật, hoặc unset VERIFY_API_URL.`);
    process.exit(2);
  }
  return { tags: [], deployed: false, apiUrl };
}

function fmtRow(cols: (string | number)[]): string {
  const w = [6, 6, 6, 6, 8];
  return cols.map((c, i) => String(c).padStart(w[i] ?? 6)).join(' |');
}

async function verify(layers: Layer[], l2?: L2Options): Promise<number> {
  const results: Record<string, { summary: Summary; ms: number }> = {};
  const problems: string[] = [];
  for (const layer of layers) {
    const r = await runLayer(layer, l2);
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
    // Tập con (lọc tag / deployed) không phải "số test của tầng" — không đụng bánh cóc.
    if ((layer === 'L2' || layer === 'L3') && l2 && (l2.tags.length > 0 || l2.deployed)) continue;
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
  for (const layer of ['L0', 'L1', 'L2', 'L3']) {
    const r = results[layer];
    if (r) console.log(fmtRow([layer, r.summary.pass, r.summary.fail, r.summary.skip, `${Math.round(r.ms / 1000)}s`]) + (r.summary.note ? `   ${r.summary.note}` : ''));
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
  if (file.startsWith('verify/scenarios/')) return /stack-isolation/.test(file) ? 'L2*' : 'L2';
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
    '> `L2` = kịch bản e2e qua HTTP vào hubv (`npm run verify:e2e`, VF4). `L2*` = kịch bản tự kiểm của bộ kiểm chứng (`stack-isolation`), chạy bằng tay qua `npm run verify:selftest`.',
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
  for (const layer of ['L0', 'L1', 'L2', 'L3']) {
    const l = last.layers?.[layer];
    if (l) lines.push(`  ${layer.padEnd(4)} ${String(l.pass).padStart(4)} pass / ${l.fail} fail / ${l.skip} skip  ${Math.round(l.ms / 1000)}s${l.note ? ` (${l.note})` : ''}`);
  }
  const r = m.result;
  lines.push(`  map   ${r.covered.size} mã có test · ${r.orphans.length} mồ côi · ${r.acceptedOrphans.length} mồ côi có lý do · ${r.ghosts.length} ma · ${r.dups.length} trùng`);
  console.log(lines.join('\n'));
  return 0;
}

// ---------------------------------------------------------------- probe (VF6, §6.3)

const PROBES_DIR = path.join(VERIFY_DIR, 'probes');
const PROBE_WT_DIR = path.join(ROOT, '.claude', 'worktrees');

/**
 * Một probe: git worktree tạm từ HEAD (dưới `.claude/worktrees/` — jest.config đã bỏ qua thư mục này, và node_modules
 * của repo vẫn tìm được khi đi ngược lên), chép đè các đường `overlay` + test đích từ cây làm việc (test chưa commit),
 * áp đột biến, chạy test đích ở đúng tầng, phán, rồi XOÁ worktree. Cây làm việc thật không bị sửa (VT11).
 */
/** Test phụ chỉ chạy ở lượt đối chứng: mọi @hub/* phải trỏ vào worktree đang probe. */
const RESOLVE_SPEC = 'verify/test/zz-probe-resolve.spec.ts';
const RESOLVE_SPEC_SRC = [
  "import * as path from 'path';",
  "it('probe-resolve: @hub/* phân giải vào worktree', () => {",
  "  const root = path.resolve(__dirname, '..', '..');",
  "  for (const m of ['@hub/common', '@hub/crypto', '@hub/messaging', '@hub/database', '@hub/providers', '@hub/sdk']) {",
  "    expect(require.resolve(m).startsWith(root + path.sep)).toBe(true);",
  "  }",
  "});",
  '',
].join('\n');

/** Worktree probe đang mở — Ctrl-C (SIGINT/SIGTERM) dọn trước khi thoát (L-6). */
const openWorktrees = new Set<string>();

function removeWorktree(wt: string): void {
  const rm = spawnSync('git', ['worktree', 'remove', '--force', wt], { cwd: ROOT, encoding: 'utf8' });
  if (rm.status !== 0) {
    fs.rmSync(wt, { recursive: true, force: true });
    spawnSync('git', ['worktree', 'prune'], { cwd: ROOT });
  }
  openWorktrees.delete(wt);
}

/** L-6: worktree `probe-P-*` sót từ lượt bị giết (pid không còn sống) -> dọn trước khi chạy. */
function cleanStaleProbeWorktrees(): void {
  spawnSync('git', ['worktree', 'prune'], { cwd: ROOT });
  if (!fs.existsSync(PROBE_WT_DIR)) return;
  for (const name of fs.readdirSync(PROBE_WT_DIR)) {
    const m = /^probe-P-.+-(\d+)$/.exec(name);
    if (!m) continue;
    let alive = false;
    try {
      process.kill(Number(m[1]), 0);
      alive = Number(m[1]) !== process.pid;
    } catch {
      alive = false;
    }
    if (!alive) {
      console.log(`  dọn worktree sót: ${name}`);
      removeWorktree(path.join(PROBE_WT_DIR, name));
    }
  }
}

let signalHooked = false;
function hookSignals(): void {
  if (signalHooked) return;
  signalHooked = true;
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      for (const wt of [...openWorktrees]) removeWorktree(wt);
      process.exit(130);
    });
  }
}

async function runProbe(p: Probe, overlay: string[]): Promise<{ p: Probe; ok: boolean; invalid: boolean; detail: string[]; ms: number }> {
  const t0 = Date.now();
  hookSignals();
  const wt = path.join(PROBE_WT_DIR, `probe-${p.id}-${process.pid}`);
  const add = spawnSync('git', ['worktree', 'add', '--detach', '--force', wt, 'HEAD'], { cwd: ROOT, encoding: 'utf8' });
  if (add.status !== 0) return { p, ok: false, invalid: true, detail: [`git worktree add lỗi: ${add.stderr.trim()}`], ms: 0 };
  openWorktrees.add(wt);
  try {
    const targets = ([] as string[]).concat(p.testFile ?? []);
    for (const rel of new Set([...overlay, ...targets])) {
      const src = path.join(ROOT, rel);
      if (fs.existsSync(src)) fs.cpSync(src, path.join(wt, rel), { recursive: true });
    }
    let files = targets;
    if (files.length === 0) files = specFiles().filter((f) => fs.existsSync(path.join(wt, f)) && layerOfFile(f) === p.layer);
    let env: NodeJS.ProcessEnv;
    if (p.layer === 'L1') {
      const l1 = l1Env();
      if (!(await tcpReachable(l1.dbUrl)) || !(await tcpReachable(l1.redisUrl))) {
        return { p, ok: false, invalid: true, detail: ['L1: Postgres/Redis hubv không kết nối được — chưa `npm run verify:up`?'], ms: Date.now() - t0 };
      }
      env = l1.env;
    } else {
      env = l0Env();
    }
    // H-1: ĐỐI CHỨNG — test đích trên worktree CHƯA phá (cùng overlay, môi trường bình thường) phải XANH, và mọi
    // `@hub/*` phải phân giải VÀO worktree (jest moduleNameMapper rootDir = worktree). node_modules/@hub/* của repo là
    // link workspace trỏ cây CHÍNH — nếu jest rơi về đó, đột biến ở libs/ sẽ không bao giờ được chạy.
    fs.mkdirSync(path.join(wt, 'verify', 'test'), { recursive: true });
    fs.writeFileSync(path.join(wt, RESOLVE_SPEC), RESOLVE_SPEC_SRC);
    const control = runJest(p.layer, [...files, RESOLVE_SPEC], env, wt, `probe-${p.id}-control`).summary.tests;
    const resolveRow = control.find((t) => t.name.includes('probe-resolve'));
    if (!resolveRow || resolveRow.status !== 'passed') {
      return { p, ok: false, invalid: true, detail: [`✗ INVALID: @hub/* không phân giải vào worktree — ${(resolveRow?.failure ?? 'không chạy').replace(/\s+/g, ' ').slice(0, 200)}`], ms: Date.now() - t0 };
    }
    fs.rmSync(path.join(wt, RESOLVE_SPEC));
    if (p.file) {
      const target = path.join(wt, p.file);
      if (!fs.existsSync(target)) return { p, ok: false, invalid: false, detail: [`probe MỤC: không còn file ${p.file}`], ms: Date.now() - t0 };
      const applied = applyProbe(fs.readFileSync(target, 'utf8'), p);
      if ('reason' in applied) return { p, ok: false, invalid: false, detail: [applied.reason], ms: Date.now() - t0 };
      fs.writeFileSync(target, applied.text);
    }
    // VT12: code đang test chạy bằng owner -> test RLS phải tự đỏ ở assert tiền đề (không pass âm thầm).
    if (p.ownerAsApp) env = { ...env, DATABASE_URL: env.VERIFY_DB_OWNER_URL };
    const r = runJest(p.layer, files, env, wt, `probe-${p.id}`);
    const verdict = judgeProbe(p, r.summary.tests, control);
    return { p, ok: verdict.ok, invalid: verdict.invalid, detail: verdict.detail, ms: Date.now() - t0 };
  } finally {
    removeWorktree(wt);
  }
}

async function probeCmd(ids: string[], overlay: string[]): Promise<number> {
  const all = loadProbes(PROBES_DIR);
  const unknown = ids.filter((i) => !all.some((p) => p.id === i));
  if (unknown.length) {
    console.error(`không có probe: ${unknown.join(', ')}`);
    return 2;
  }
  const chosen = ids.length ? all.filter((p) => ids.includes(p.id)) : all;
  cleanStaleProbeWorktrees();
  // VT11: probe không được rò ra cây làm việc thật. Cây có thể đang được phiên khác sửa song song, nên KHÔNG so cả
  // `git status`: kiểm (1) file bị nhắm KHÔNG mang đúng nội dung đã phá, (2) không còn worktree probe-* sót lại.
  const before = new Map(chosen.filter((p) => p.file).map((p) => [p.id, fs.existsSync(path.join(ROOT, p.file)) ? fs.readFileSync(path.join(ROOT, p.file), 'utf8') : '']));
  const rows: Awaited<ReturnType<typeof runProbe>>[] = [];
  for (const p of chosen) {
    console.log(`\n■ ${p.id} — ${p.claim}`);
    const r = await runProbe(p, overlay);
    for (const d of r.detail) console.log(`    ${d}`);
    rows.push(r);
  }
  const leftover = git(['worktree', 'list']).split(/\r?\n/).filter((l) => /probe-P-/.test(l));
  const leaked = chosen.filter((p) => {
    if (!p.file || !fs.existsSync(path.join(ROOT, p.file))) return false;
    const mutated = applyProbe(before.get(p.id) ?? '', p);
    return mutated.ok && fs.readFileSync(path.join(ROOT, p.file), 'utf8') === mutated.text;
  });
  console.log('\n| probe | phá gì | test mục tiêu | kết quả |\n|---|---|---|---|');
  for (const r of rows) {
    const want = [...(r.p.expectRed ?? []).map((x) => `${x} → đỏ`), ...(r.p.expectGreen ?? []).map((x) => `${x} → xanh`)].join('<br>');
    const res = r.ok ? '✅' : (r.invalid ? '⚠ INVALID ' : '❌ ') + r.detail.filter((d) => !d.startsWith('✓')).join('; ');
    console.log(`| ${r.p.id} | ${r.p.claim} | ${want} | ${res} |`);
  }
  const bad = rows.filter((r) => !r.ok);
  const treeChanged = leaked.length > 0 || leftover.length > 0;
  const vt11 = treeChanged ? `✗ VT11: đột biến rò ra cây thật (${leaked.map((p) => p.id).join(', ')}) / worktree sót: ${leftover.length}` : 'cây làm việc không bị đột biến, không worktree sót (VT11)';
  console.log(`\nprobe: ${rows.length - bad.length}/${rows.length} đúng kỳ vọng · ${vt11}`);
  return bad.length > 0 || treeChanged ? 1 : 0;
}

/** §8.2: bảng 5 bất biến — test mang mã BB:n xanh trên code thật + probe làm đỏ. */
async function bbCmd(overlay: string[]): Promise<number> {
  const tagged = specFiles().filter((f) => /\[BB:\d\]/.test(fs.readFileSync(path.join(ROOT, f), 'utf8')));
  const l0 = tagged.filter((f) => layerOfFile(f) === 'L0');
  const l1 = tagged.filter((f) => layerOfFile(f) === 'L1');
  const tests: Summary['tests'] = [];
  if (l0.length) tests.push(...runJest('L0', l0, l0Env(), ROOT, 'bb-L0').summary.tests);
  if (l1.length) tests.push(...runJest('L1', l1, l1Env().env, ROOT, 'bb-L1').summary.tests);
  const probes = loadProbes(PROBES_DIR);
  const scenarioText = walk(path.join(VERIFY_DIR, 'scenarios'), (f) => f.endsWith('.ts'))
    .map((f) => fs.readFileSync(f, 'utf8'))
    .join('\n');
  const rows: string[] = [];
  let ok = true;
  for (const n of ['1', '2', '3', '4', '5']) {
    const mine = tests.filter((t) => t.name.includes(`[BB:${n}]`));
    const green = mine.length > 0 && mine.every((t) => t.status === 'passed');
    const l23 = (scenarioText.match(new RegExp(`\\[BB:${n}\\]`, 'g')) ?? []).length;
    const pr: string[] = [];
    for (const id of BB_PROBES[n]) {
      const p = probes.find((x) => x.id === id);
      if (!p) {
        pr.push(`${id} ❌ thiếu`);
        ok = false;
        continue;
      }
      const r = await runProbe(p, overlay);
      const good = p.expectGreen?.length ? '✅ sống sót đúng (lớp sau vẫn chặn)' : '✅ đỏ';
      pr.push(`${id} ${r.ok ? good : (r.invalid ? '⚠ INVALID ' : '❌ ') + r.detail.join('; ')}`);
      if (!r.ok) ok = false;
    }
    if (!green) ok = false;
    const testCol = `${mine.length} test L0/L1${l23 ? ` + ${l23} kịch bản L2/L3` : ''}`;
    rows.push(`| BB-${n} | ${testCol} | ${green ? '✅' : '❌'} | ${pr.join('<br>') || '— (hình dạng hệ thống, không có nhánh code để phá)'} |`);
  }
  console.log('\n| bất biến | test | xanh trên code thật | đỏ khi probe |\n|---|---|---|---|');
  for (const r of rows) console.log(r);
  return ok ? 0 : 1;
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
    case 'e2e': {
      const tags = rest.flatMap((x, i) => (rest[i - 1] === '--tag' ? x.split(',') : []));
      process.exit(await verify(['L2'], { ...defaultL2(), tags }));
    }
    case 'deployed': {
      const apiUrl = process.env.VERIFY_API_URL;
      if (!apiUrl) {
        console.error('verify:deployed cần VERIFY_API_URL (+ VERIFY_API_KEY, VERIFY_PROJECT_SLUG=demo). Không có mặc định — không bao giờ tự trỏ vào hạ tầng thật.');
        process.exit(2);
      }
      process.exit(await verify(['L2'], { tags: [], deployed: true, apiUrl }));
    }
    case 'chaos': {
      const tags = rest.flatMap((x, i) => (rest[i - 1] === '--tag' ? x.split(',') : []));
      process.exit(await verify(['L3'], { ...defaultL2(), tags }));
    }
    case 'all-l3': {
      const code = await verify(['L0', 'L1', 'L2', 'L3']);
      process.exit(code || mapCmd());
    }
    case 'all': {
      const code = await verify(['L0', 'L1', 'L2']);
      const mapCode = mapCmd();
      process.exit(code || mapCode);
    }
    case 'probe': {
      const ids = rest.filter((x, i) => /^P-/.test(x) && rest[i - 1] !== '--overlay');
      process.exit(await probeCmd(flag('--all') ? [] : ids, (opt('--overlay') ?? '').split(',').filter(Boolean)));
    }
    case 'bb':
      process.exit(await bbCmd((opt('--overlay') ?? '').split(',').filter(Boolean)));
    case 'files': {
      // demo:run (VF8): chạy đúng các file test được chỉ, mỗi file ở tầng của nó (L1 có Postgres/Redis hubv).
      const files = rest.filter((x) => x.endsWith('.spec.ts'));
      let code = 0;
      const l0 = files.filter((f) => layerOfFile(f) === 'L0');
      const l1 = files.filter((f) => layerOfFile(f) === 'L1');
      if (l0.length) code ||= runJest('L0', l0, l0Env(), ROOT, 'files-L0').summary.fail > 0 ? 1 : 0;
      if (l1.length) {
        const r = runJest('L1', l1, l1Env().env, ROOT, 'files-L1').summary;
        code ||= r.fail > 0 || r.skip > 0 || r.pass === 0 ? 1 : 0;
      }
      process.exit(code);
    }
    case 'map':
      process.exit(mapCmd(opt('--story')));
    default:
      console.error('Dùng: run.ts unit|db|e2e [--tag x]|deployed|chaos|all|all-l3|probe [P-…|--all] [--overlay a,b]|bb|map [--story X] [--evidence]');
      process.exit(2);
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
