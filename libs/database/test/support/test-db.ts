/**
 * VF2 (SPEC-verification §4.3): chỗ DUY NHẤT trong test được `new PrismaClient(`. Grep gác cổng §7.3 chặn chỗ khác.
 *
 * - `describeDb`: khối test cần Postgres/Redis thật. Chạy khi `RUN_DB_TESTS=1` (runner `npm run verify:db` luôn đặt).
 *   File nào dùng `describeDb` là file tầng L1; `verify:db` đỏ nếu còn skip (đóng H1).
 * - `newTestPrisma('app')`: kết nối của CODE ĐANG ĐƯỢC TEST — `DATABASE_URL`.
 * - `newTestPrisma('owner')`: CHỈ dựng/dọn fixture hoặc đọc xuyên tenant để assert — `VERIFY_DB_OWNER_URL`.
 *
 * Trước AU6 chỉ có một role (`hub_user`, owner + superuser), nên hai kết nối trùng nhau và mọi file cũ dùng `app`.
 * AU6 tạo role `hub_app`: khi đó file test phải tách fixture sang `owner`, và test RLS phải assert tiền đề
 * `current_user = hub_app, rolsuper = false, rolbypassrls = false` (§4.3, VT12).
 */
import { PrismaClient } from '@prisma/client';

export const describeDb: jest.Describe = process.env.RUN_DB_TESTS === '1' ? describe : describe.skip;

export type TestDbRole = 'owner' | 'app';

export function testDbUrl(role: TestDbRole): string | undefined {
  if (role === 'owner') return process.env.VERIFY_DB_OWNER_URL || process.env.DATABASE_URL;
  return process.env.DATABASE_URL;
}

export function newTestPrisma(role: TestDbRole = 'app', urlOverride?: string): PrismaClient {
  const url = urlOverride ?? testDbUrl(role);
  return new PrismaClient(url ? { datasources: { db: { url } } } : undefined);
}
