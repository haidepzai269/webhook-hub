import { HttpException } from '@nestjs/common';
import { TenantScopedRepository } from '@hub/database';
import { FlowScopedRepository } from '../src/modules/flow/flow.repository';
import { FlowService } from '../src/modules/flow/flow.service';

/**
 * ADR-163: `/flow/executions` thêm provider, probes=hide (cờ events.probe ADR-159), from/to, q (tiền tố id) —
 * kiểm đầu vào (400 bad_request + field), bộ lọc xuống repo, cờ `probe` có trong từng dòng, SQL scope tenant.
 */
const TENANT = '00000000-0000-0000-0000-0000000000bb';

function row(over: Record<string, unknown> = {}) {
  return {
    cursorAt: '2026-10-12T03:00:00.123456',
    cursorKey: 'k1',
    at: new Date('2026-10-12T03:00:00Z'),
    rawId: '22222222-2222-2222-2222-222222222222',
    rawStatus: 'ACCEPTED',
    signatureValid: true,
    sourceId: '33333333-3333-3333-3333-333333333333',
    sourceName: 'PayOS',
    provider: 'payos',
    processed: true,
    eventId: '01JA0000000000000000000000',
    type: 'payos.webhook_test',
    subject: null,
    normalized: false,
    origin: 'webhook',
    eventAt: new Date('2026-10-12T03:00:00Z'),
    probe: true,
    deliveries: [],
    ...over,
  };
}

function build(rows = [row()]) {
  const findExecutions = jest.fn(async () => rows);
  const svc = new FlowService({ forTenant: () => ({ extend: () => ({ findExecutions }) }) } as never);
  return { svc, findExecutions };
}

async function expect400(p: Promise<unknown>, field: string) {
  const e = await p.then(() => null, (x) => x);
  expect(e).toBeInstanceOf(HttpException);
  expect((e as HttpException).getStatus()).toBe(400);
  expect((e as HttpException).getResponse()).toMatchObject({ error: 'bad_request', field });
}

describe('FlowService.listExecutions — bộ lọc ADR-163', () => {
  it('bộ lọc hợp lệ đi xuống repo; mỗi dòng mang cờ probe của SERVER', async () => {
    const { svc, findExecutions } = build();
    const res = await svc.listExecutions(TENANT, { provider: 'payos', probes: 'hide', from: '2026-10-01T00:00:00Z', to: '2026-10-12T00:00:00Z', q: '01JA00' });
    expect((findExecutions.mock.calls[0] as any)[0]).toMatchObject({
      provider: 'payos',
      hideProbes: true,
      from: new Date('2026-10-01T00:00:00Z'),
      to: new Date('2026-10-12T00:00:00Z'),
      idPrefix: '01JA00',
    });
    expect(res.items[0].probe).toBe(true);
    // probe đi vào buildEventFlow -> lý do định tuyến là provider_probe, không phải "không subscription nào khớp".
    expect(JSON.stringify(res.items[0].summary)).not.toContain('no_subscription');
  });

  it('probes vắng / show -> không ẩn', async () => {
    const { svc, findExecutions } = build([row({ probe: false })]);
    const res = await svc.listExecutions(TENANT, { probes: 'show' });
    expect((findExecutions.mock.calls[0] as any)[0].hideProbes).toBe(false);
    expect(res.items[0].probe).toBe(false);
  });

  it.each([
    [{ provider: 'Pay OS' }, 'provider'],
    [{ probes: 'yes' }, 'probes'],
    [{ from: '12/10/2026' }, 'from'],
    [{ from: '2026-10-12T00:00:00Z', to: '2026-10-01T00:00:00Z' }, 'from'],
    [{ q: 'ab' }, 'q'],
    [{ q: "01JA'--" }, 'q'],
    [{ q: ['01JA', '01JB'] }, 'q'],
    [{ provider: { $ne: 'x' } }, 'provider'],
    [{ cursor: Buffer.from(JSON.stringify(['2026-13-40T25:00:00.000000', 'k'])).toString('base64url') }, 'cursor'],
    [{ cursor: Buffer.from(JSON.stringify(['0001-01-01T00:00:00.000000', 'k'])).toString('base64url') }, 'cursor'],
  ])('%j -> 400 (%s)', async (q, field) => {
    await expect400(build().svc.listExecutions(TENANT, q as any), field);
  });
});

describe('FlowScopedRepository.findExecutions — SQL', () => {
  it('provider / probe / thời gian / tiền tố id áp cho CẢ hai nhánh (raw + event không raw), scope tenant giữ nguyên', async () => {
    const raw: any[] = [];
    const client: any = { $queryRaw: jest.fn(async (q: any) => (raw.push(q), [])) };
    const repo = new TenantScopedRepository(client, TENANT).extend(FlowScopedRepository);
    await repo.findExecutions({ provider: 'github', hideProbes: true, from: new Date('2026-10-01T00:00:00Z'), idPrefix: '01J_A', limit: 51, orphanMinAgeSeconds: 120 });
    const sql: string = raw[0].sql;
    expect(sql.match(/AND provider = \?/g)).toHaveLength(2);
    // Ẩn probe chỉ khi KHÔNG có delivery — probe có lỗi thật không bao giờ bị ẩn (một lần, ở WHERE ngoài).
    expect(sql.match(/AND NOT \(j\.probe AND dl\.deliveries IS NULL\)/g)).toHaveLength(1);
    expect(sql.match(/AND x_at >= \?/g)).toHaveLength(2);
    expect(sql).toMatch(/COALESCE\(e\.probe, false\) AS probe/);
    expect(sql).toMatch(/s\.tenant_id = \?::uuid/);
    expect(raw[0].values).toContain(TENANT);
    expect(sql).toMatch(/upper\(event_id\) LIKE \?/);
    expect(raw[0].values).toContain('01J\\_A%'); // `_` thoát -> không phải wildcard; đã viết hoa cho ULID
  });
});
