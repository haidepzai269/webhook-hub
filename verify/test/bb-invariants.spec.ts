import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { GATES, runGates } from '../lib/gates';

/**
 * VF6 (SPEC-verification §8.2): BB-1 và BB-4 thành test L0 mang mã — để `verify:bb` có đủ năm dòng và probe
 * P-BB1-01 (thêm `orderCode` vào hub-worker) có test đích để làm đỏ. BB-2/3/5 ở ingest-invariants, delivery-consumer,
 * rls-db, chaos-l3.
 */
const ROOT = path.resolve(__dirname, '..', '..');

function repoFiles(): string[] {
  const r = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8' });
  return [...new Set(r.stdout.split('\n').map((s) => s.trim()).filter(Boolean))].filter((f) => fs.existsSync(path.join(ROOT, f)));
}
const read = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf8');

describe('Bất biến BB-1, BB-4 (L0)', () => {
  it('[BB:1] hub không biết "đơn hàng": gate bb1 trên apps/hub-* + libs/*/src = 0 vi phạm (ngoại lệ chỉ có lý do đã duyệt)', () => {
    const [r] = runGates(GATES.filter((g) => g.id === 'bb1'), repoFiles(), read);
    expect(r.violations.map((v) => `${v.file}:${v.line} ${v.text}`)).toEqual([]);
  });

  it('[BB:4] hub-api và hub-worker là HAI tiến trình: hai service compose, hai lệnh khởi động riêng; không bên nào import mã của bên kia', () => {
    const compose = read('docker-compose.yml');
    expect(compose).toMatch(/\n {2}hub-api:\n[\s\S]*?command: \["hub-api"\]/);
    expect(compose).toMatch(/\n {2}hub-worker:\n[\s\S]*?command: \["hub-worker"\]/);
    const cross: string[] = [];
    for (const f of repoFiles().filter((x) => /^apps\/hub-(api|worker)\/src\/.*\.ts$/.test(x))) {
      const other = f.startsWith('apps/hub-api/') ? 'hub-worker' : 'hub-api';
      read(f)
        .split(/\r?\n/)
        .forEach((ln, i) => {
          if (/^\s*(import|export)\b.*from\s+['"]/.test(ln) && ln.includes(`${other}/`)) cross.push(`${f}:${i + 1} ${ln.trim()}`);
        });
    }
    expect(cross).toEqual([]);
    expect(read('apps/hub-api/src/main.ts')).not.toMatch(/Consumer\b/);
  });
});
