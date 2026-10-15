import { Prisma } from '@prisma/client';
import { describeDb, newTestPrisma } from '../../../libs/database/test/support/test-db';
import { classifyInfraError } from '../src/consumers/infra-errors';
import { classifyNormalizeError } from '../src/consumers/normalize-errors';

/**
 * ADR-194 (review TB-1) trên Postgres THẬT: khuôn lỗi mà Prisma đang dùng thật sự sinh ra khi backend bị cắt giữa truy vấn
 * (`pg_terminate_backend` chính mình -> 57P01) phải được xếp `transient`; lỗi dữ liệu thật qua `$executeRaw` vẫn không.
 * Test này đỏ khi bản Prisma mới đổi dạng lỗi (P2010/meta.code) — đó là lúc phải xem lại `classifyInfraError`.
 */
describeDb('ADR-194 classifyInfraError với lỗi Prisma thật (Postgres, hub_app)', () => {
  const app = newTestPrisma('app');
  // client RIÊNG cho ca lỗi dữ liệu: ca trên cắt chính kết nối của `app` (lần dùng kế tiếp ra P1017, không phải lỗi cần kiểm)
  const app2 = newTestPrisma('app');
  afterAll(() => Promise.all([app.$disconnect(), app2.$disconnect()]));

  it('backend bị cắt giữa $executeRaw (pg_terminate_backend chính mình, 57P01) -> transient (normalize: transient)', async () => {
    const err = await app.$executeRaw`SELECT pg_terminate_backend(pg_backend_pid())`.then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).not.toBeNull();
    // ghi lại dạng lỗi thật cho người đọc log CI khi Prisma đổi khuôn
    const e = err as { name?: string; code?: string; meta?: unknown };
    console.log(`Prisma ném: ${e.name} ${e.code} ${JSON.stringify(e.meta)}`);
    expect(classifyInfraError(err)).toBe('transient');
    expect(classifyNormalizeError(err)).toBe('transient');
  });

  it('lỗi dữ liệu thật qua $executeRaw (cast "08006" sang uuid -> 22P02, câu lỗi chứa "08006") -> unknown', async () => {
    const err = await app2.$executeRaw`SELECT '08006'::uuid`.then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect((err as Prisma.PrismaClientKnownRequestError).code).toBe('P2010');
    expect(classifyInfraError(err)).toBe('unknown');
    expect(classifyNormalizeError(err)).toBe('permanent');
  });
});
