/**
 * VF8 (SPEC-verification §9.2): tập dượt buổi bảo vệ lần nào cũng giống lần nào.
 *
 *   npm run demo:reset -- --env local      verify:reset (hubv sạch) + một dev "demo" + 200 event nền (dashboard không trống)
 *   npm run demo:reset -- --env deployed   CHƯA hỗ trợ: cần API operator xoá dữ liệu project demo (CAN-ADMIN-QUYET-VF Q4)
 *   npm run demo:run -- --step 6 [--no-wait]   in lời thoại + thao tác, chờ Enter, rồi TỰ KIỂM (nếu bước có `check`)
 *   npm run demo:rehearse [-- --no-wait]   chạy hết 14 bước, ghi verify/results/rehearsal-<ngày>.md
 *   npm run demo:warm                      GET /health mỗi 30 s trong 10 phút — URL lấy từ DEMO_WARM_URLS (bắt buộc,
 *                                          không mặc định: phiên dev không gọi hạ tầng thật)
 * Kịch bản: verify/demo/steps.yaml. Bước env=deployed không bao giờ tự kiểm từ máy dev.
 */
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import * as yaml from 'js-yaml';
import { ROOT } from '../lib/compose';

export interface DemoStep {
  step: number;
  act: 1 | 2 | 3;
  env: 'local' | 'deployed';
  title: string;
  say: string;
  do: string[];
  expect: string;
  timeoutS: number;
  check?: { kind: 'e2e' | 'chaos' | 'jest'; tag?: string; file?: string };
}

export function loadSteps(file = path.join(ROOT, 'verify', 'demo', 'steps.yaml')): DemoStep[] {
  const doc = yaml.load(fs.readFileSync(file, 'utf8')) as { steps: DemoStep[] };
  const steps = doc.steps;
  steps.forEach((s, i) => {
    if (s.step !== i + 1) throw new Error(`steps.yaml: bước thứ ${i + 1} mang số ${s.step}`);
    for (const k of ['title', 'say', 'expect'] as const) if (!s[k]) throw new Error(`bước ${s.step} thiếu ${k}`);
    if (!['local', 'deployed'].includes(s.env)) throw new Error(`bước ${s.step}: env là local | deployed`);
    if (s.check && s.env !== 'local') throw new Error(`bước ${s.step}: chỉ bước local mới có check (không tự kiểm hạ tầng thật)`);
    if (s.check?.kind === 'jest' && !s.check.file) throw new Error(`bước ${s.step}: check jest cần file`);
    if (s.check && s.check.kind !== 'jest' && !s.check.tag) throw new Error(`bước ${s.step}: check ${s.check.kind} cần tag`);
  });
  return steps;
}

const tsNode = (args: string[]) =>
  spawnSync(process.execPath, [path.join(ROOT, 'node_modules', 'ts-node', 'dist', 'bin.js'), '--transpile-only', '-P', 'tsconfig.json', ...args], { cwd: ROOT, stdio: 'inherit' });

export function checkArgs(c: NonNullable<DemoStep['check']>): string[] {
  if (c.kind === 'e2e') return ['verify/cli/run.ts', 'e2e', '--tag', c.tag!];
  if (c.kind === 'chaos') return ['verify/cli/run.ts', 'chaos', '--tag', c.tag!];
  return ['verify/cli/run.ts', 'files', c.file!];
}

function ask(q: string): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((r) => rl.question(q, () => (rl.close(), r())));
}

async function runStep(s: DemoStep, wait: boolean): Promise<{ s: DemoStep; ok: boolean | null; ms: number }> {
  console.log(`\n━━━ Bước ${s.step} · Hồi ${s.act} · ${s.env.toUpperCase()} · ${s.title} (≤ ${s.timeoutS}s)`);
  console.log(`  NÓI: ${s.say}`);
  for (const d of s.do ?? []) console.log(`  LÀM: ${d}`);
  console.log(`  THẤY: ${s.expect}`);
  const t0 = Date.now();
  if (wait) await ask('  [Enter khi xong thao tác] ');
  let ok: boolean | null = null;
  if (s.check) {
    console.log(`  TỰ KIỂM: ${s.check.kind} ${s.check.tag ?? s.check.file}`);
    ok = tsNode(checkArgs(s.check)).status === 0;
  }
  const ms = Date.now() - t0;
  console.log(`  → ${ok === null ? '· (kiểm bằng mắt)' : ok ? '✅' : '❌'} ${Math.round(ms / 1000)}s${ms / 1000 > s.timeoutS ? ' — VƯỢT ngân sách' : ''}`);
  return { s, ok, ms };
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const opt = (n: string) => (rest.includes(n) ? rest[rest.indexOf(n) + 1] : undefined);
  const wait = !rest.includes('--no-wait');
  switch (cmd) {
    case 'reset': {
      const env = opt('--env');
      if (env === 'deployed') {
        console.error('demo:reset --env deployed CHƯA hỗ trợ: cần API operator `DELETE /api/v1/operator/projects/demo/data` (chưa có) — xem _bmad-output/planning-artifacts/verification/CAN-ADMIN-QUYET-VF.md Q4. Không xoá gì.');
        process.exit(2);
      }
      if (env !== 'local') {
        console.error('demo:reset -- --env local|deployed');
        process.exit(2);
      }
      if (tsNode(['verify/cli/stack.ts', 'reset']).status !== 0) process.exit(1);
      process.exit(tsNode(['verify/demo/seed-demo.ts']).status ?? 1);
    }
    case 'run': {
      const n = Number(opt('--step'));
      const s = loadSteps().find((x) => x.step === n);
      if (!s) {
        console.error('demo:run -- --step 1..14');
        process.exit(2);
      }
      const r = await runStep(s, wait);
      process.exit(r.ok === false ? 1 : 0);
    }
    case 'rehearse': {
      const rows = [];
      const t0 = Date.now();
      for (const s of loadSteps()) rows.push(await runStep(s, wait));
      const total = Math.round((Date.now() - t0) / 1000);
      const day = new Date().toISOString().slice(0, 10);
      const out = path.join(ROOT, 'verify', 'results', `rehearsal-${day}.md`);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      const md = [
        `# Tập dượt ${day}`,
        '',
        `Tổng: **${Math.floor(total / 60)}' ${total % 60}"** (mục tiêu ≤ 11'). Bước ❌: ${rows.filter((r) => r.ok === false).map((r) => r.s.step).join(', ') || 'không'}.`,
        '',
        '| bước | hồi | env | việc | thời gian | ngân sách | tự kiểm |',
        '|---|---|---|---|---|---|---|',
        ...rows.map((r) => `| ${r.s.step} | ${r.s.act} | ${r.s.env} | ${r.s.title} | ${Math.round(r.ms / 1000)}s | ${r.s.timeoutS}s | ${r.ok === null ? '· mắt' : r.ok ? '✅' : '❌'} |`),
        '',
      ].join('\n');
      fs.writeFileSync(out, md);
      console.log(`\n${md}\n→ ${path.relative(ROOT, out)}`);
      process.exit(rows.some((r) => r.ok === false) || total > 11 * 60 ? 1 : 0);
    }
    case 'warm': {
      const urls = (process.env.DEMO_WARM_URLS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      if (urls.length === 0) {
        console.error('demo:warm cần DEMO_WARM_URLS="https://<hub-api>/health,https://<shop>/health,https://<web>/" — không có mặc định.');
        process.exit(2);
      }
      for (let i = 0; i < 20; i++) {
        const res = await Promise.all(urls.map(async (u) => `${u} ${await fetch(u).then((r) => r.status).catch((e) => (e as Error).message)}`));
        console.log(`${new Date().toISOString().slice(11, 19)}  ${res.join('  ·  ')}`);
        if (i < 19) await new Promise((r) => setTimeout(r, 30_000));
      }
      process.exit(0);
    }
    default:
      console.error('demo.ts reset --env local|deployed | run --step N [--no-wait] | rehearse [--no-wait] | warm');
      process.exit(2);
  }
}

if (require.main === module) main();
