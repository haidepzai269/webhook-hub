import { HttpException } from '@nestjs/common';
import { TenantScopedRepository } from '@hub/database';
import { ApiController } from '../src/modules/api/api.controller';
import { listAuditPage, listDeliveryPage } from '../src/modules/api/console-lists';
import { decodeKeyset, encodeKeyset, isAuditId } from '../src/modules/api/list-params';

/**
 * ADR-163: Lượt giao / DLQ / Nhật ký thao tác — keyset `(created_at, id)`, Trước/Sau bằng `before`/`after`,
 * bộ lọc kiểm ở server (400 `bad_request` + `field`), mọi truy vấn qua TenantScopedRepository (BB-5).
 */

const TENANT = '00000000-0000-0000-0000-0000000000aa';
const DEST = '11111111-1111-1111-1111-111111111111';

/** Lỗi 400 đúng khuôn docs/ERRORS.md: `{ error: 'bad_request', field, message }`. */
async function expect400(p: Promise<unknown> | (() => unknown), field: string) {
  let err: unknown;
  try {
    await (typeof p === 'function' ? p() : p);
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(HttpException);
  const ex = err as HttpException;
  expect(ex.getStatus()).toBe(400);
  expect(ex.getResponse()).toMatchObject({ error: 'bad_request', field });
}

// ---------------------------------------------------------------------------------------------------------------
// Repo giả có ĐÚNG ngữ nghĩa keyset (so sánh BỘ (at, id)) trên dữ liệu có nhiều dòng TRÙNG mốc thời gian.
// ---------------------------------------------------------------------------------------------------------------
interface Row {
  id: string;
  cursorAt: string;
}
const cmp = (a: Row, b: { at: string; id: string }) => (a.cursorAt < b.at ? -1 : a.cursorAt > b.at ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

function keysetRepo(rows: Row[]) {
  const calls: any[] = [];
  const page = (f: any) => {
    calls.push(f);
    let r = [...rows];
    if (f.cursor) r = r.filter((x) => (f.dir === 'newer' ? cmp(x, f.cursor) > 0 : cmp(x, f.cursor) < 0));
    r.sort((a, b) => (f.dir === 'newer' ? cmp(a, { at: b.cursorAt, id: b.id }) : -cmp(a, { at: b.cursorAt, id: b.id })));
    return r.slice(0, f.limit + 1);
  };
  return {
    calls,
    repo: {
      findDeliveryPage: async (f: any) => ({ rows: page(f) }),
      findAuditLogPage: async (f: any) => page(f).map((r) => ({ ...r, id: BigInt(r.id) })),
    } as unknown as TenantScopedRepository,
  };
}

/** 23 dòng; 5 mốc thời gian, mỗi mốc 4–5 dòng (thế hoà) — trang 5 dòng cắt NGANG nhóm trùng mốc. */
function tiedRows(numericIds = false): Row[] {
  const out: Row[] = [];
  for (let i = 0; i < 23; i++) {
    const t = Math.floor(i / 5);
    const id = numericIds ? String(100 + i) : `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`;
    out.push({ id, cursorAt: `2026-10-12T03:00:0${t}.123456` });
  }
  return out;
}

describe('keyset (created_at, id) — thế hoà cùng mốc', () => {
  it('đi Sau đến hết rồi Trước về đầu: mỗi dòng đúng MỘT lần, không trùng không sót, thứ tự giảm dần', async () => {
    const rows = tiedRows();
    const { repo } = keysetRepo(rows);
    const expected = [...rows].sort((a, b) => -cmp(a, { at: b.cursorAt, id: b.id })).map((r) => r.id);

    const forward: string[][] = [];
    let res = await listDeliveryPage(repo, { limit: '5' }, 'deliveries');
    expect(res.prev).toBeNull();
    forward.push(res.items.map((i: any) => i.id));
    while (res.next) {
      res = await listDeliveryPage(repo, { limit: '5', before: res.next }, 'deliveries');
      expect(res.prev).not.toBeNull();
      forward.push(res.items.map((i: any) => i.id));
    }
    expect(forward.flat()).toEqual(expected);
    expect(forward.map((p) => p.length)).toEqual([5, 5, 5, 5, 3]);

    // Lùi lại bằng `after` = prev của trang hiện tại: từng trang khớp y hệt lúc đi tới.
    const back: string[][] = [forward[forward.length - 1]];
    while (res.prev) {
      res = await listDeliveryPage(repo, { limit: '5', after: res.prev }, 'deliveries');
      back.unshift(res.items.map((i: any) => i.id));
    }
    expect(back).toEqual(forward);
  });

  it('dòng MỚI chèn ở đầu không làm trang sau trùng/sót (lý do không dùng OFFSET)', async () => {
    const rows = tiedRows();
    const { repo } = keysetRepo(rows);
    const p1 = await listDeliveryPage(repo, { limit: '5' }, 'deliveries');
    rows.push({ id: '00000000-0000-0000-0000-000000000999', cursorAt: '2026-10-12T03:00:09.000000' });
    const p2 = await listDeliveryPage(repo, { limit: '5', before: p1.next! }, 'deliveries');
    const seen = new Set(p1.items.map((i: any) => i.id));
    expect(p2.items.some((i: any) => seen.has(i.id))).toBe(false);
    expect(p2.items[0].id).toBe('00000000-0000-0000-0000-000000000017'); // ngay sau dòng cuối trang 1 (…018)
  });

  it('Trước chạm đầu danh sách (ít hơn limit) -> trả trang ĐẦU đủ cỡ, prev = null', async () => {
    const rows = tiedRows();
    const { repo } = keysetRepo(rows);
    const head = await listDeliveryPage(repo, { limit: '5' }, 'deliveries');
    // cursor nằm giữa trang đầu: phía mới hơn chỉ còn 2 dòng
    const mid = encodeKeyset({ at: rows[20].cursorAt, id: rows[20].id });
    const res = await listDeliveryPage(repo, { limit: '5', after: mid }, 'deliveries');
    expect(res.items.map((i: any) => i.id)).toEqual(head.items.map((i: any) => i.id));
    expect(res.prev).toBeNull();
    expect(res.next).toBe(head.next);
  });

  it('audit: id đúng trần BIGINT vẫn hợp lệ', async () => {
    const { repo, calls } = keysetRepo([]);
    await listAuditPage(repo, { before: encodeKeyset({ at: '2026-10-12T03:00:00.000000', id: '9223372036854775807' }) });
    expect(calls[0].cursor.id).toBe('9223372036854775807');
  });

  it('audit: cùng keyset, id số (bigint -> chuỗi), nextBefore = next', async () => {
    const rows = tiedRows(true);
    const { repo } = keysetRepo(rows);
    const p1 = await listAuditPage(repo, { limit: '5' });
    expect(p1.items.map((i) => i.id)).toEqual(['122', '121', '120', '119', '118']);
    expect(p1.nextBefore).toBe(p1.next);
    const p2 = await listAuditPage(repo, { limit: '5', before: p1.next! });
    expect(p2.items.map((i) => i.id)).toEqual(['117', '116', '115', '114', '113']);
    expect(decodeKeyset(p2.prev!, 'x', isAuditId)).toEqual({ at: rows[17].cursorAt, id: '117' });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Kiểm đầu vào -> 400 bad_request + field
// ---------------------------------------------------------------------------------------------------------------
describe('kiểm tham số (400 bad_request, field)', () => {
  const { repo } = keysetRepo([]);
  const cases: [string, Record<string, string>, 'deliveries' | 'dlq', string][] = [
    ['destination không phải uuid', { destination: 'abc' }, 'deliveries', 'destination'],
    ['from không phải ISO', { from: '1696000000' }, 'deliveries', 'from'],
    ['to ngày sai', { to: '2026-13-45T00:00:00Z' }, 'deliveries', 'to'],
    ['from > to', { from: '2026-10-12T00:00:00Z', to: '2026-10-11T00:00:00Z' }, 'deliveries', 'from'],
    ['status lạ', { status: 'LOST' }, 'deliveries', 'status'],
    ['code lạ', { code: '99' }, 'deliveries', 'code'],
    ['code 6xx', { code: '6xx' }, 'deliveries', 'code'],
    ['errorKind ở /deliveries', { errorKind: 'http_4xx' }, 'deliveries', 'errorKind'],
    ['status ở /dlq', { status: 'DEAD' }, 'dlq', 'status'],
    ['errorKind lạ', { errorKind: 'boom' }, 'dlq', 'errorKind'],
    ['cursor rác', { before: 'not-a-cursor' }, 'deliveries', 'before'],
    ['cursor id không phải uuid', { after: encodeKeyset({ at: '2026-10-12T03:00:00.000000', id: "1'; drop" }) }, 'deliveries', 'after'],
    ['cursor mốc chỉ có ms', { before: Buffer.from(JSON.stringify(['2026-10-12T03:00:00.000Z', DEST])).toString('base64url') }, 'deliveries', 'before'],
    ['cả before lẫn after', { before: encodeKeyset({ at: '2026-10-12T03:00:00.000000', id: DEST }), after: encodeKeyset({ at: '2026-10-12T03:00:00.000000', id: DEST }) }, 'deliveries', 'before'],
    ['limit không phải số', { limit: '-1' }, 'deliveries', 'limit'],
    // L1: query lặp khoá / lồng object -> 400, không 500
    ['status lặp khoá (mảng)', { status: ['DEAD', 'RETRYING'] } as any, 'deliveries', 'status'],
    ['destination object', { destination: { $ne: 'x' } } as any, 'dlq', 'destination'],
    // L2: ngày đúng dạng nhưng không có thật
    ['from 31/02', { from: '2026-02-31T00:00:00Z' }, 'deliveries', 'from'],
    ['cursor tháng 13', { before: encodeKeyset({ at: '2026-13-12T03:00:00.000000', id: DEST }) }, 'deliveries', 'before'],
    ['cursor năm < 1970', { before: encodeKeyset({ at: '1969-12-31T23:59:59.000000', id: DEST }) }, 'deliveries', 'before'],
    ['cursor giờ 25', { after: encodeKeyset({ at: '2026-10-12T25:00:00.000000', id: DEST }) }, 'dlq', 'after'],
  ];
  it.each(cases)('%s', async (_name, q, mode, field) => {
    await expect400(listDeliveryPage(repo, q, mode), field);
  });

  it.each([
    ['action ký tự lạ', { action: "delivery'; --" }, 'action'],
    ['entityType có chấm', { entityType: 'delivery.batch' }, 'entityType'],
    ['actor quá dài', { actor: 'x'.repeat(200) }, 'actor'],
    ['cursor audit id uuid (phải là số)', { before: encodeKeyset({ at: '2026-10-12T03:00:00.000000', id: DEST }) }, 'before'],
    ['from sai', { from: 'hôm qua' }, 'from'],
    ['cursor audit id vượt BIGINT', { before: encodeKeyset({ at: '2026-10-12T03:00:00.000000', id: '9223372036854775808' }) }, 'before'],
    ['actor lặp khoá', { actor: ['a', 'b'] }, 'actor'],
  ])('audit: %s', async (_n, q, field) => {
    await expect400(listAuditPage(repo, q as any), field);
  });

  it('bộ lọc hợp lệ đi xuống repo đúng kiểu (uuid thường hoá, Date, code theo lớp)', async () => {
    const { repo: r, calls } = keysetRepo([]);
    await listDeliveryPage(r, { destination: DEST.toUpperCase(), code: '5xx', status: 'RETRYING', from: '2026-10-01T00:00:00Z' }, 'deliveries');
    expect(calls[0]).toMatchObject({ destinationId: DEST, httpCode: { klass: 5 }, status: 'RETRYING', dir: 'older', limit: 50 });
    expect(calls[0].from).toEqual(new Date('2026-10-01T00:00:00Z'));
    await listDeliveryPage(r, { errorKind: 'no_response', code: 'none' }, 'dlq');
    expect(calls[1]).toMatchObject({ dlq: true, errorKind: 'no_response' });
    expect(calls[1].httpCode).toBeUndefined(); // code chỉ dành cho /deliveries
  });
});

// ---------------------------------------------------------------------------------------------------------------
// SQL thật của TenantScopedRepository (client giả bắt câu lệnh): scope tenant + so sánh BỘ + chiều sắp xếp
// ---------------------------------------------------------------------------------------------------------------
function sqlClient() {
  const raw: { sql: string; values: unknown[] }[] = [];
  const findMany: any[] = [];
  const client: any = {
    $queryRaw: jest.fn(async (q: any) => {
      raw.push({ sql: q.sql, values: q.values });
      return [{ id: DEST, cursorAt: '2026-10-12T03:00:00.123456' }];
    }),
    delivery: { findMany: jest.fn(async (a: any) => (findMany.push(a), [{ id: DEST, tenantId: TENANT }])) },
  };
  return { client, raw, findMany };
}

describe('TenantScopedRepository.findDeliveryPage / findAuditLogPage — SQL', () => {
  it('trang cũ hơn: tenant_id ràng buộc, (created_at, id) < cursor, DESC, LIMIT limit+1; nạp quan hệ cũng scope tenant', async () => {
    const { client, raw, findMany } = sqlClient();
    const repo = new TenantScopedRepository(client, TENANT);
    const res = await repo.findDeliveryPage({ dir: 'older', cursor: { at: '2026-10-12T03:00:00.123456', id: DEST }, limit: 50, destinationId: DEST });
    const q = raw[0];
    expect(q.sql).toMatch(/WHERE d\.tenant_id = \?::uuid/);
    expect(q.values[0]).toBe(TENANT);
    expect(q.sql).toMatch(/\(d\.created_at, d\.id\) < \(\?::timestamp AT TIME ZONE 'UTC', \?::uuid\)/);
    expect(q.sql).toMatch(/ORDER BY d\.created_at DESC, d\.id DESC/);
    expect(q.sql).toMatch(/s\.destination_id = \?::uuid/);
    expect(q.values).toEqual(expect.arrayContaining(['2026-10-12T03:00:00.123456', DEST, 51]));
    expect(findMany[0].where).toMatchObject({ tenantId: TENANT, id: { in: [DEST] } });
    expect(res.rows[0].cursorAt).toBe('2026-10-12T03:00:00.123456');
  });

  it('trang mới hơn (Trước): > cursor, ASC', async () => {
    const { client, raw } = sqlClient();
    await new TenantScopedRepository(client, TENANT).findDeliveryPage({ dir: 'newer', cursor: { at: '2026-10-12T03:00:00.123456', id: DEST }, limit: 50 });
    expect(raw[0].sql).toMatch(/\(d\.created_at, d\.id\) > \(/);
    expect(raw[0].sql).toMatch(/ORDER BY d\.created_at ASC, d\.id ASC/);
  });

  it('DLQ: DEAD + chưa bị replay + loại lỗi theo HTTP lần thử cuối', async () => {
    const { client, raw } = sqlClient();
    await new TenantScopedRepository(client, TENANT).findDeliveryPage({ dir: 'older', limit: 50, dlq: true, errorKind: 'http_4xx' });
    expect(raw[0].sql).toMatch(/d\.status = 'DEAD' AND NOT EXISTS/);
    expect(raw[0].sql).toMatch(/ORDER BY a\.attempt_no DESC LIMIT 1\) BETWEEN 400 AND 499/);
  });

  it('replay hàng loạt dùng CÙNG điều kiện loại lỗi', async () => {
    const { client, raw } = sqlClient();
    await new TenantScopedRepository(client, TENANT).findDeadDeliveryRefs({ errorKind: 'http_4xx' }, 500);
    expect(raw[0].sql).toMatch(/ORDER BY a\.attempt_no DESC LIMIT 1\) BETWEEN 400 AND 499/);
    expect(raw[0].values[0]).toBe(TENANT);
  });

  it('audit: tenant_id ràng buộc, (created_at, id) < (…, ?::bigint), action là tiền tố', async () => {
    const { client, raw } = sqlClient();
    await new TenantScopedRepository(client, TENANT).findAuditLogPage({
      dir: 'older',
      limit: 50,
      cursor: { at: '2026-10-12T03:00:00.123456', id: '42' },
      action: 'delivery',
      actor: '50%_off',
    });
    expect(raw[0].sql).toMatch(/WHERE a\.tenant_id = \?::uuid/);
    expect(raw[0].values[0]).toBe(TENANT);
    expect(raw[0].sql).toMatch(/\(a\.created_at, a\.id\) < \(\?::timestamp AT TIME ZONE 'UTC', \?::bigint\)/);
    expect(raw[0].values).toEqual(expect.arrayContaining(['delivery', 'delivery.', '%50\\%\\_off%']));
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Controller: tenant lấy từ token, không từ query; replay hàng loạt nhận errorKind
// ---------------------------------------------------------------------------------------------------------------
describe('ApiController — deliveries / dlq / audit-logs / replay-bulk', () => {
  function build() {
    const repo = {
      findDeliveryPage: jest.fn(async () => ({ rows: [] })),
      findAuditLogPage: jest.fn(async () => []),
      findDeadDeliveryRefs: jest.fn(async () => []),
    };
    const prisma: any = { forTenant: jest.fn(() => repo) };
    return { controller: new ApiController(prisma), prisma, repo };
  }

  it('repo dựng theo tenant của phiên; response { items, next, prev }', async () => {
    const { controller, prisma, repo } = build();
    await expect(controller.listDeliveries(TENANT, { status: 'DEAD' })).resolves.toEqual({ items: [], next: null, prev: null });
    await controller.listDlq(TENANT, { destination: DEST });
    await controller.listAuditLogs(TENANT, { actor: 'admin' });
    expect(prisma.forTenant).toHaveBeenCalledTimes(3);
    for (const c of prisma.forTenant.mock.calls) expect(c[0]).toBe(TENANT);
    expect((repo.findDeliveryPage.mock.calls[1] as any)[0]).toMatchObject({ dlq: true, destinationId: DEST });
  });

  it('replay-bulk: errorKind hợp lệ đi vào bộ lọc; lạ -> 400', async () => {
    const { controller, repo } = build();
    await controller.replayBulk(TENANT, 'admin', { dryRun: true, reason: 'đích sống lại', errorKind: 'http_other' });
    expect((repo.findDeadDeliveryRefs.mock.calls[0] as any)[0]).toMatchObject({ errorKind: 'http_other' });
    await expect(controller.replayBulk(TENANT, 'admin', { dryRun: true, reason: 'đích sống lại', errorKind: 'x' })).rejects.toMatchObject({ status: 400 });
  });
});

describe('replay đơn — subscription đang tắt (ADR-163)', () => {
  it('-> 409 subscription_inactive (cùng điều kiện replayableOnly của replay hàng loạt), không mở transaction', async () => {
    const delivery = {
      id: DEST,
      status: 'DEAD',
      attemptGeneration: 1,
      subscription: { isActive: false, archivedAt: null, destination: { id: DEST, isActive: true, archivedAt: null } },
    };
    const prisma: any = { forTenant: () => ({ findDeliveryById: async () => delivery }), tenantTx: jest.fn() };
    const e = await new ApiController(prisma).replayDelivery(TENANT, 'u', DEST, {}).catch((x: any) => x);
    expect([e.getStatus(), e.getResponse().error, e.getResponse().field]).toEqual([409, 'subscription_inactive', 'subscriptionId']);
    expect(prisma.tenantTx).not.toHaveBeenCalled();
  });
});
