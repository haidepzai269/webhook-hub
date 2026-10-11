import { spawnSync } from 'child_process';
import * as path from 'path';
import { isLocalUrl } from '../lib/local-url';

/** M-3 (review VF): e2e/chaos/verify/seed-demo chỉ được trỏ hubv local; chỉ verify:deployed được ra ngoài. */
describe('VERIFY_API_URL chỉ local (M-3)', () => {
  const ROOT = path.resolve(__dirname, '..', '..');

  it('VF4 (M-3): localhost/127.0.0.1/::1/hub-api/hubv-* là local; Render/Vercel/IP công khai/URL hỏng thì không', () => {
    for (const u of ['http://localhost:14000', 'http://127.0.0.1:14000', 'http://[::1]:14000', 'http://hub-api:4000', 'http://hubv-hub-api-1:4000']) expect([u, isLocalUrl(u)]).toEqual([u, true]);
    for (const u of ['https://hub-api.onrender.com', 'https://webhook-hub.vercel.app', 'http://203.0.113.5:14000', 'http://localhost.evil.com', 'khong-phai-url']) expect([u, isLocalUrl(u)]).toEqual([u, false]);
  });

  it('VF4 (M-3): `run.ts e2e` với VERIFY_API_URL trỏ ra ngoài -> thoát 2, không chạy kịch bản nào', () => {
    const ts = path.join(ROOT, 'node_modules', 'ts-node', 'dist', 'bin.js');
    const r = spawnSync(process.execPath, [ts, '--transpile-only', '-P', 'tsconfig.json', 'verify/cli/run.ts', 'e2e', '--tag', 'smoke'], {
      cwd: ROOT,
      env: { ...process.env, VERIFY_API_URL: 'https://hub-api.onrender.com' },
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/không phải hubv local/);
    expect(r.stdout).not.toMatch(/▶ L2/);
  }, 90_000);
});
