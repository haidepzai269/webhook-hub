/**
 * VF7: npm run verify:gates — chạy mọi luật grep §7.3 trên file của repo (đã track + chưa track nhưng không bị ignore).
 * Exit ≠ 0 nếu có vi phạm. Ngoại lệ có lý do luôn được in ra để người review thấy.
 */
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { ROOT } from '../lib/compose';
import { GATES, runGates } from '../lib/gates';

function repoFiles(): string[] {
  const r = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ls-files lỗi: ${r.stderr}`);
  return [...new Set(r.stdout.split('\n').map((s) => s.trim()).filter(Boolean))].filter((f) => fs.existsSync(path.join(ROOT, f)));
}

const results = runGates(GATES, repoFiles(), (f) => fs.readFileSync(path.join(ROOT, f), 'utf8'));
let bad = 0;
for (const r of results) {
  const mark = r.violations.length === 0 ? '✓' : '✗';
  console.log(`${mark} [${r.gate.id}] ${r.gate.rule}${r.excepted.length ? `  (ngoại lệ có lý do: ${r.excepted.length})` : ''}`);
  for (const v of r.violations) console.log(`    VI PHẠM ${v.file}:${v.line}  ${v.text}`);
  for (const v of r.excepted) console.log(`    ngoại lệ ${v.file}:${v.line} — ${v.reason}`);
  bad += r.violations.length;
}
console.log(`\ngates: ${results.length} luật · ${bad} vi phạm · ${results.reduce((s, r) => s + r.excepted.length, 0)} ngoại lệ có lý do`);
process.exit(bad > 0 ? 1 : 0);
