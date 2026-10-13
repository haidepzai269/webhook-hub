import { randomUUID } from 'crypto';
import { HUB_PROJECT_STORAGE } from '@hub/common';
import { PrismaService } from '@hub/database';
import { StorageAlerts } from '../src/scheduler/storage-alerts';
import { describeDb, newTestPrisma } from '../../../libs/database/test/support/test-db';

/**
 * QT6 (ADR-190, review QT-S3 M2) trên Postgres THẬT (`hub_app`, RLS bật): hai đường "báo" chạy SONG SONG thật (hai
 * PrismaService = hai pool, hai transaction) cho cùng một lần đổi nấc -> đúng MỘT `hub.project.storage`, MỘT alert, MỘT
 * thư mỗi người. Giữ bởi `SELECT … FOR UPDATE` trong `lockProjectUsageForSignal`.
 *
 * Rào chắn: cả hai transaction đều vào tới ngay trước câu khoá rồi mới cùng chạy câu khoá; đường lấy được dòng trước GIỮ
 * khoá thêm tới 500ms chờ đường kia cũng "lấy được". Có FOR UPDATE: đường kia bị chặn ở Postgres tới COMMIT, đọc lại
 * `signaled_level` mới -> không phát. Bỏ FOR UPDATE: cả hai cùng đọc ảnh chụp cũ (`signaled_level` = OK) rồi cùng phát
 * -> 2 event -> test đỏ.
 */
describeDb('QT6 StorageAlerts.signal song song (Postgres, hub_app)', () => {
  const owner = newTestPrisma('owner');
  const svc1 = new PrismaService();
  const svc2 = new PrismaService();
  const run = randomUUID().slice(0, 8);
  const P = randomUUID();
  const users: string[] = [];
  const MB = 1048576;

  beforeAll(async () => {
    await owner.project.create({ data: { id: P, slug: `qt6-par-${run}`, name: `qt6 par ${run}` } });
    const u = await owner.user.create({ data: { email: `qt6-par-${run}@t.vn`, name: 'Own', emailVerifiedAt: new Date() } });
    users.push(u.id);
    await owner.projectMember.create({ data: { tenantId: P, userId: u.id, role: 'owner' } });
    await owner.projectUsage.upsert({
      where: { tenantId: P },
      create: { tenantId: P, usedBytes: BigInt(48 * MB), level: 'LOCKED', signaledLevel: 'OK' },
      update: { usedBytes: BigInt(48 * MB), level: 'LOCKED', signaledLevel: 'OK', notifiedLevel: null, notifiedAt: null },
    });
  }, 60_000);

  afterAll(async () => {
    await owner.alertEmail.deleteMany({ where: { tenantId: P } });
    await owner.alert.deleteMany({ where: { tenantId: P } });
    await owner.delivery.deleteMany({ where: { tenantId: P } });
    await owner.event.deleteMany({ where: { tenantId: P } });
    await owner.projectMember.deleteMany({ where: { userId: { in: users } } });
    await owner.user.deleteMany({ where: { id: { in: users } } });
    await owner.project.deleteMany({ where: { id: P } }); // CASCADE project_usage
    await Promise.all([owner.$disconnect(), svc1.$disconnect(), svc2.$disconnect()]);
  });

  /** Rào hai bên: `arrive` đợi đủ 2 bên; `wait` đợi đủ 2 bên HOẶC hết `ms`. */
  function barrier(n: number) {
    let count = 0;
    let open!: () => void;
    const all = new Promise<void>((r) => (open = r));
    return {
      arrive: async () => {
        if (++count >= n) open();
        await all;
      },
      hit: () => {
        if (++count >= n) open();
      },
      wait: (ms: number) => Promise.race([all, new Promise<void>((r) => setTimeout(r, ms))]),
    };
  }

  /** Cắm rào vào `lockProjectUsageForSignal` của repo trong transaction (chỉ instance này — không đụng code thật). */
  function gated(svc: PrismaService, before: ReturnType<typeof barrier>, after: ReturnType<typeof barrier>) {
    const orig = svc.forTenant.bind(svc);
    (svc as any).forTenant = (tenantId: string, tx?: unknown) => {
      const repo = (orig as any)(tenantId, tx);
      const lock = repo.lockProjectUsageForSignal.bind(repo);
      repo.lockProjectUsageForSignal = async () => {
        await before.arrive(); // cả hai transaction đã BEGIN, chưa ai khoá
        const row = await lock();
        after.hit();
        await after.wait(500); // giữ dòng: có FOR UPDATE thì bên kia đang bị chặn, không thì bên kia cũng đã đọc ảnh chụp cũ
        return row;
      };
      return repo;
    };
    return svc;
  }

  it('[QT:T19] (phần b) hai signal() song song cho cùng lần đổi nấc OK -> LOCKED: đúng 1 event hub.project.storage, 1 alert, 1 thư/người', async () => {
    const before = barrier(2);
    const after = barrier(2);
    const a1 = new StorageAlerts(gated(svc1, before, after));
    const a2 = new StorageAlerts(gated(svc2, before, after));
    const results = await Promise.all([a1.signal(P, 50 * MB), a2.signal(P, 50 * MB)]);
    expect(results.sort()).toEqual([false, true]); // đường sau thấy signaled_level đã khớp -> không làm gì

    const events = await owner.event.findMany({ where: { tenantId: P, type: HUB_PROJECT_STORAGE } });
    expect(events).toHaveLength(1);
    expect(events[0].data).toMatchObject({ level: 'LOCKED', previousLevel: 'OK' });
    const alerts = await owner.alert.findMany({ where: { tenantId: P, rule: 'project.storage_locked' } });
    expect(alerts).toHaveLength(1);
    const emails = await owner.alertEmail.findMany({ where: { tenantId: P, userId: users[0] } });
    expect(emails).toHaveLength(1);
    const usage = await owner.projectUsage.findUnique({ where: { tenantId: P } });
    expect(usage).toMatchObject({ signaledLevel: 'LOCKED', notifiedLevel: 'LOCKED' });
  }, 60_000);
});
