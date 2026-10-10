import * as fs from 'fs';
import * as path from 'path';
import { assertAppRoleNotPrivileged } from '../src/prisma.service';

const ROOT = path.resolve(__dirname, '..', '..', '..');
const NEEDLE = 'app.rls' + '_system'; // ghép chuỗi để chính file này không bị quét trúng

function walk(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'dist', '.next'].includes(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|js)$/.test(e.name)) out.push(p);
  }
  return out;
}

describe('RLS — đường hệ thống ở MỘT chỗ (SPEC-auth §5.12.6)', () => {
  it('[AU:UA30] quét mã nguồn: chuỗi app.rls_system CHỈ có trong libs/database/src/prisma.service.ts', () => {
    const srcDirs = fs.readdirSync(path.join(ROOT, 'apps')).map((a) => path.join(ROOT, 'apps', a, 'src'));
    srcDirs.push(...fs.readdirSync(path.join(ROOT, 'libs')).map((l) => path.join(ROOT, 'libs', l, 'src')));
    const hits = srcDirs
      .flatMap((d) => walk(d))
      .filter((f) => fs.readFileSync(f, 'utf8').includes(NEEDLE))
      .map((f) => path.relative(ROOT, f).split(path.sep).join('/'));
    expect(hits).toEqual(['libs/database/src/prisma.service.ts']);
  });
});

describe('Kiểm role lúc khởi động (SPEC-auth §5.12.2)', () => {
  const db = (row: { rolsuper: boolean; rolbypassrls: boolean; current_user?: string }) => ({
    $queryRaw: jest.fn().mockResolvedValue([{ current_user: 'x', ...row }]),
  });

  it('[AU:UA31] runtime là superuser hoặc BYPASSRLS -> process.exit(1) với thông báo rõ; role thường -> chạy tiếp', async () => {
    for (const row of [{ rolsuper: true, rolbypassrls: false }, { rolsuper: false, rolbypassrls: true }]) {
      const exit = jest.fn();
      await assertAppRoleNotPrivileged(db(row) as never, {}, exit as never);
      expect(exit).toHaveBeenCalledWith(1);
    }
    const ok = jest.fn();
    await assertAppRoleNotPrivileged(db({ rolsuper: false, rolbypassrls: false }) as never, {}, ok as never);
    expect(ok).not.toHaveBeenCalled();
  });

  it('RLS_ALLOW_PRIVILEGED=1 chỉ được chấp nhận khi NODE_ENV=test', async () => {
    const privileged = db({ rolsuper: true, rolbypassrls: true });
    const a = jest.fn();
    await assertAppRoleNotPrivileged(privileged as never, { RLS_ALLOW_PRIVILEGED: '1', NODE_ENV: 'test' }, a as never);
    expect(a).not.toHaveBeenCalled();
    const b = jest.fn();
    await assertAppRoleNotPrivileged(privileged as never, { RLS_ALLOW_PRIVILEGED: '1', NODE_ENV: 'production' }, b as never);
    expect(b).toHaveBeenCalledWith(1);
  });
});
