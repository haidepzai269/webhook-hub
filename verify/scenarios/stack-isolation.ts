/**
 * Kịch bản tự kiểm của bộ kiểm chứng (SPEC-verification §12): VT8, VT9.
 *   npm run verify:selftest
 * Dựng hubv (VT8: stack dev không đổi), rồi verify:down (VT9: volume hubv_* mất, volume dev còn).
 * Kết thúc với hubv TẮT. Không bao giờ đụng project `webhook-hub` ngoài việc ĐỌC `ps`/`volume ls`.
 */
import { spawnSync } from 'child_process';
import { ROOT } from '../lib/compose';

type Fn = () => void;
const results: { name: string; ok: boolean; err?: string }[] = [];
function scenario(name: string, fn: Fn) {
  const t0 = Date.now();
  try {
    fn();
    results.push({ name, ok: true });
    console.log(`✓ ${name} (${Math.round((Date.now() - t0) / 1000)}s)`);
  } catch (e) {
    results.push({ name, ok: false, err: (e as Error).message });
    console.log(`✗ ${name}: ${(e as Error).message}`);
  }
}

function sh(cmd: string, args: string[]): string {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', shell: process.platform === 'win32' });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} → exit ${r.status}: ${(r.stderr ?? '').slice(-400)}`);
  return (r.stdout ?? '').trim();
}
const devContainers = () => sh('docker', ['compose', '-p', 'webhook-hub', 'ps', '-q']).split(/\s+/).filter(Boolean).sort().join(',');
const volumes = () => sh('docker', ['volume', 'ls', '--format', '{{.Name}}']).split(/\s+/).filter(Boolean);

scenario('[VF:VT8] verify:up khi stack dev đang chạy → cả hai cùng sống; docker compose -p webhook-hub ps không đổi', () => {
  const before = devContainers();
  sh('npm', ['run', 'verify:up']);
  const after = devContainers();
  if (before !== after) throw new Error(`container dev đổi: ${before} → ${after}`);
  const hubv = sh('docker', ['compose', '-p', 'hubv', 'ps', '--format', '{{.Service}}={{.State}}']);
  if (!/hub-api=running/.test(hubv)) throw new Error(`hubv hub-api không chạy: ${hubv}`);
  console.log(`  dev: ${before.split(',').length} container, cùng ID trước/sau · hubv: ${hubv.split(/\s+/).join(' ')}`);
});

scenario('[VF:VT9] verify:down → volume hubv_* mất, volume stack dev còn nguyên', () => {
  const before = volumes();
  const hubvBefore = before.filter((v) => v.startsWith('hubv_'));
  const devBefore = before.filter((v) => v.startsWith('webhook-hub_')).sort().join(',');
  if (hubvBefore.length === 0) throw new Error('không thấy volume hubv_* trước khi down');
  sh('npm', ['run', 'verify:down']);
  const after = volumes();
  const hubvAfter = after.filter((v) => v.startsWith('hubv_'));
  const devAfter = after.filter((v) => v.startsWith('webhook-hub_')).sort().join(',');
  if (hubvAfter.length > 0) throw new Error(`còn volume hubv: ${hubvAfter.join(',')}`);
  if (devBefore !== devAfter) throw new Error(`volume dev đổi: ${devBefore} → ${devAfter}`);
  console.log(`  hubv: ${hubvBefore.join(',')} → (không còn) · dev: ${devAfter}`);
});

const failed = results.filter((r) => !r.ok);
console.log(`\nselftest: ${results.length - failed.length} pass / ${failed.length} fail`);
process.exit(failed.length > 0 ? 1 : 0);
