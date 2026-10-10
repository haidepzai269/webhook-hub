import { PrismaClient } from '@prisma/client';

/**
 * AU6 (SPEC-auth §5.12.1, ADR-108) — CHỈ local / docker-compose: bảo đảm role runtime `hub_app` ĐĂNG NHẬP được với
 * mật khẩu `HUB_APP_DB_PASSWORD`, không superuser, không BYPASSRLS. Chạy bằng OWNER (`DIRECT_URL`) trong
 * docker-entrypoint, TRƯỚC `prisma migrate deploy` (migration cấp quyền + bật RLS).
 * Mật khẩu không bao giờ nằm trong migration (commit được). Neon: tạo role trong console (docs/DEPLOYMENT.md).
 *
 *   ts-node src/ensure-app-role.ts
 */
export const APP_ROLE = 'hub_app';

/** Mật khẩu đi thẳng vào câu SQL (DO-block không nhận tham số) -> chỉ chấp nhận ký tự an toàn, đủ dài. */
export function appRolePasswordProblem(pw: string | undefined): string | null {
  if (!pw) return 'thiếu HUB_APP_DB_PASSWORD';
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(pw)) return 'HUB_APP_DB_PASSWORD phải 16–128 ký tự [A-Za-z0-9_-]';
  return null;
}

export function ensureAppRoleSql(pw: string): string {
  const problem = appRolePasswordProblem(pw);
  if (problem) throw new Error(problem);
  return `DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${APP_ROLE}') THEN
    CREATE ROLE ${APP_ROLE} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD '${pw}';
  ELSE
    ALTER ROLE ${APP_ROLE} WITH LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD '${pw}';
  END IF;
END
$$;`;
}

async function main() {
  const url = process.env.DIRECT_URL || process.env.DATABASE_URL;
  const pw = process.env.HUB_APP_DB_PASSWORD;
  const problem = appRolePasswordProblem(pw);
  if (!url || problem) {
    console.error(`ensure-app-role: ${problem ?? 'thiếu DIRECT_URL'}`);
    process.exit(2);
  }
  const db = new PrismaClient({ datasources: { db: { url } } });
  try {
    await db.$executeRawUnsafe(ensureAppRoleSql(pw!));
    const [{ current_database }] = await db.$queryRaw<{ current_database: string }[]>`SELECT current_database()`;
    await db.$executeRawUnsafe(`GRANT CONNECT ON DATABASE "${current_database.replace(/"/g, '')}" TO ${APP_ROLE}`);
    console.log(`ensure-app-role: role ${APP_ROLE} sẵn sàng (LOGIN, không superuser, không BYPASSRLS)`);
  } finally {
    await db.$disconnect();
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error('ensure-app-role lỗi:', (e as Error).message);
    process.exit(1);
  });
}
