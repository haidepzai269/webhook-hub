import { TenantScopedRepository } from '../src/tenant-scoped.repository';

/**
 * R3-M1 (review DX-A vòng 3): bất biến của ORCHESTRATED_METHODS (`latestPollCursor`) — chỉ được gọi phương thức repo
 * khác, mỗi lời gọi một transaction có `app.project_id`; KHÔNG BAO GIỜ chạm client gốc chưa scope.
 */
const T = '11111111-1111-4111-8111-111111111111';
/** Tagged template (`$queryRaw\`…\``) hoặc `Prisma.sql` truyền làm đối số. */
const sqlOf = (args: unknown[]) => {
  const a: any = args[0];
  if (Array.isArray(a)) return (a as string[]).join('?');
  if (a && Array.isArray(a.strings)) return a.strings.join('?');
  return String(a);
};
const valuesOf = (args: unknown[]): unknown[] => {
  const a: any = args[0];
  return a && Array.isArray(a.values) && !Array.isArray(a) ? a.values : args.slice(1);
};

/** Client giả: truy vấn ở client GỐC (ngoài callback `$transaction`) -> ném; trong tx thì trả kết quả hợp lý. */
function fakeClient(backlog: number) {
  let unassigned = backlog;
  let max = 100n;
  const txs: { sql: string[]; projectSet: boolean }[] = [];
  const outside = () => {
    throw new Error('query on ROOT client outside $transaction (unscoped!)');
  };
  const root: any = {
    $queryRaw: outside,
    $executeRaw: outside,
    $transaction: async (fn: any) => {
      if (typeof fn !== 'function') throw new Error('batch $transaction không mong đợi ở đây');
      const rec = { sql: [] as string[], projectSet: false };
      txs.push(rec);
      const tx: any = {
        $executeRaw: async (...args: unknown[]) => {
          const sql = sqlOf(args);
          rec.sql.push(sql);
          if (sql.includes('set_config')) {
            rec.projectSet = true;
            return 1;
          }
          if (sql.includes('UPDATE')) {
            const vals = valuesOf(args);
            const batch = Number(vals[vals.length - 1]) || 1000;
            const n = Math.min(batch, unassigned);
            unassigned -= n;
            max += BigInt(n);
            return n;
          }
          throw new Error(`execute lạ: ${sql}`);
        },
        $queryRaw: async (...args: unknown[]) => {
          const sql = sqlOf(args);
          rec.sql.push(sql);
          if (!rec.projectSet) throw new Error('query trong tx TRƯỚC khi set app.project_id');
          if (sql.includes('EXISTS')) return [{ pending: unassigned > 0 }];
          if (sql.includes('pg_advisory_xact_lock')) return [{ locked: '' }];
          if (sql.includes('max(poll_seq)')) return [{ max }];
          throw new Error(`query lạ: ${sql}`);
        },
      };
      return fn(tx);
    },
  };
  return { root, txs, left: () => unassigned };
}

describe('[DX:UX11] R3-M1 ORCHESTRATED_METHODS — latestPollCursor không chạm client gốc chưa scope', () => {
  it('(a) client gốc ném nếu truy vấn ngoài tx: latestPollCursor KHÔNG ném; mỗi lời gọi repo bên trong mở đúng MỘT tx có set_config', async () => {
    const f = fakeClient(5);
    const repo = new TenantScopedRepository(f.root, T);
    await expect(repo.latestPollCursor({ maxRounds: 5, batch: 2 })).resolves.toBe(105n);
    expect(f.left()).toBe(0);
    // 3 lô assignPollSeq (2,2,1) + maxPollCursor = 4 tx; lô cuối không đầy -> không hỏi hasUnassignedPollSeq.
    expect(f.txs).toHaveLength(4);
    expect(f.txs.every((t) => t.projectSet && t.sql[0].includes('set_config'))).toBe(true);
    expect(f.txs.slice(0, 3).every((t) => t.sql.some((s) => s.includes('UPDATE')))).toBe(true);
    expect(f.txs[3].sql.some((s) => s.includes('max(poll_seq)'))).toBe(true);
  });

  it('(a) trần: backlog > maxRounds × batch -> null, mỗi lô một tx, + 1 tx kiểm còn tồn', async () => {
    const f = fakeClient(10);
    const repo = new TenantScopedRepository(f.root, T);
    await expect(repo.latestPollCursor({ maxRounds: 2, batch: 2 })).resolves.toBeNull();
    expect(f.txs).toHaveLength(3);
    expect(f.left()).toBe(6);
  });

  it('(b) phương thức điều phối mà đụng `this.prisma` -> NÉM to rõ (không âm thầm trả cursor 0 / dội lịch sử)', async () => {
    const f = fakeClient(0);
    const proto = TenantScopedRepository.prototype as any;
    const orig = proto.latestPollCursor;
    proto.latestPollCursor = async function (this: any) {
      return this.prisma.$queryRaw`SELECT max(poll_seq) AS max FROM "hub"."events"`;
    };
    try {
      await expect(new TenantScopedRepository(f.root, T).latestPollCursor()).rejects.toThrow(/ORCHESTRATED|orchestrated/);
    } finally {
      proto.latestPollCursor = orig;
    }
  });

  it('(b) phương thức KHÔNG điều phối vẫn như cũ (đọc this.prisma bình thường, một tx có scope)', async () => {
    const f = fakeClient(0);
    await expect(new TenantScopedRepository(f.root, T).maxPollCursor()).resolves.toBe(100n);
    expect(f.txs).toHaveLength(1);
    expect(f.txs[0].projectSet).toBe(true);
  });
});
