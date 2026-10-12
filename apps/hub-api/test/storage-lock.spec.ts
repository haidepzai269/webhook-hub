import { createHmac } from 'crypto';
import { HttpException } from '@nestjs/common';
import { aesGcmEncrypt } from '@hub/crypto';
import { PrismaService, TenantScopedRepository } from '@hub/database';
import { logger } from '@hub/common';
import { IngestService } from '../src/modules/ingest/ingest.service';
import { PenaltyBox } from '../src/modules/ingest/penalty-box';
import { toErrorBody } from '../src/modules/errors/service-exception.filter';
import { apiRegistry } from '../src/modules/metrics/metrics';

/**
 * QT3 (SPEC-han-muc-dung-luong §4 + ĐÍNH CHÍNH E1/E4/E5, ADR-182/189): khoá chiều ghi ở bước 2q — sau nạp source (nấc JOIN
 * cùng câu), trước hộp phạt theo cặp / verify / rate limit. Quyết định = `isWriteBlocked(level, keepLonger, lockEnabled)`.
 */
const MASTER = 'test-master-key-at-least-32-characters!!';
const SECRET = 'gh-secret-qt3';

type Src = { level: string | null; keepLonger?: boolean; tenantId?: string };

function setup(sources: Record<string, Src>, opts: { lockEnabled?: boolean } = {}) {
  const make = (key: string, s: Src) => ({
    id: `src-${key}`,
    tenantId: s.tenantId ?? `tenant-${key}`,
    provider: 'github',
    isActive: true,
    archivedAt: null,
    keepLonger: s.keepLonger ?? false,
    storageLevel: s.level,
    secrets: [{ id: 's', secretEncrypted: aesGcmEncrypt(SECRET, MASTER) }],
  });
  const tx = { rawEvent: { create: jest.fn(async () => ({ id: 'raw-1' })) }, outbox: { create: jest.fn() } };
  const traffic = jest.fn().mockResolvedValue(1);
  const prisma: any = {
    findSourceBySourceKeyForIngest: jest.fn(async (k: string) => (sources[k] ? make(k, sources[k]) : null)),
    tenantTx: jest.fn(async (_t: string, fn: any) => fn(tx)),
    forTenant: () => ({
      addSourceTraffic: traffic,
      findSourceById: jest.fn(async (id: string, o: any) => {
        expect(o).toEqual({ withStorageLevel: true }); // publish nạp nấc CÙNG câu nạp source
        const key = id.replace(/^src-/, '');
        return sources[key] ? { ...make(key, sources[key]), provider: 'api', secrets: undefined } : null;
      }),
    }),
  };
  const redis: any = {
    checkRateLimit: jest.fn(async () => true),
    getIdempotencyKey: jest.fn(async () => null),
    setIdempotencyKey: jest.fn(async () => undefined),
  };
  const svc = new IngestService(prisma, redis);
  svc.penalty = new PenaltyBox({ threshold404: 20, threshold401: 99, banMs: 600_000, maxEntries: 1000, windowMs: 60_000 });
  svc.storageLockEnabled = opts.lockEnabled ?? true;
  const redisCalls = () => redis.checkRateLimit.mock.calls.length + redis.getIdempotencyKey.mock.calls.length + redis.setIdempotencyKey.mock.calls.length;
  return { svc, prisma, redis, tx, traffic, redisCalls };
}

const body = JSON.stringify({ ref: 'refs/heads/main', after: 'abc', repository: { name: 'r' } });
let n = 0;
const hook = (sourceKey: string, extraHeaders: Record<string, string> = {}) => ({
  provider: 'github' as const,
  sourceKey,
  ip: '3.3.3.3',
  contentType: 'application/json',
  rawBody: Buffer.from(body),
  body: JSON.parse(body),
  headers: { 'x-hub-signature-256': `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`, 'x-github-delivery': `qt3-${++n}`, 'x-github-event': 'push', ...extraHeaders },
});
const publish = (svc: IngestService, key: string) => {
  const raw = Buffer.from(JSON.stringify({ type: 'order.created', idempotencyKey: `k-${++n}`, data: {} }));
  return svc.publishFromService(`tenant-${key}`, `src-${key}`, {
    provider: 'api', sourceKey: `api_${key}`, headers: {}, rawBody: raw, body: JSON.parse(raw.toString()), contentType: 'application/json', ip: '4.4.4.4',
  } as any);
};
const metric = async (name: string, path: string) => {
  const m = (await apiRegistry.getSingleMetric(name)?.get())?.values.find((v) => v.labels.path === path);
  return m?.value ?? 0;
};

describe('QT3 — khoá chiều ghi (507 project_storage_full)', () => {
  beforeAll(() => {
    process.env.MASTER_KEY = MASTER;
  });

  it('[QT:T2] LOCKED: /hooks trả 507 đúng khuôn lỗi, KHÔNG ghi raw_events/outbox, KHÔNG tốn lệnh Redis; lưu lượng ghi STORAGE_FULL bytes 0', async () => {
    const { svc, tx, redisCalls, traffic } = setup({ full: { level: 'LOCKED' } });
    const res = await svc.ingestWebhook(hook('full', { 'x-request-id': 'req-qt3-000001' }));
    expect(res.status).toBe(507);
    expect(res.body).toEqual({
      error: 'project_storage_full',
      message: expect.stringContaining('storage quota'),
      fix: expect.stringContaining('keep longer'),
      docsUrl: expect.stringMatching(/#project_storage_full$/),
      requestId: 'req-qt3-000001',
    });
    expect(tx.rawEvent.create).not.toHaveBeenCalled();
    expect(tx.outbox.create).not.toHaveBeenCalled();
    expect(redisCalls()).toBe(0);
    await svc.traffic.flush();
    expect(traffic.mock.calls[0][0]).toEqual([expect.objectContaining({ outcome: 'STORAGE_FULL', count: 1, bytes: 0 })]);
  });

  it('[QT:T3] (phần a) LOCKED: publish /v1/p trả 507; qua exception filter ra khuôn {error, message, fix, docsUrl, requestId} giữ status 507', async () => {
    const { svc, tx, redisCalls } = setup({ full: { level: 'LOCKED' } });
    const r = await publish(svc, 'full');
    expect(r).toEqual({ status: 507, body: { error: 'project_storage_full' } });
    expect(tx.rawEvent.create).not.toHaveBeenCalled();
    expect(redisCalls()).toBe(0);
    // controller ném HttpException({error}, status) như mọi lỗi lõi ingest — filter KHÔNG được biến 507 thành internal_error
    const { status, body } = toErrorBody(new HttpException({ error: 'project_storage_full' }, 507), 'rid-1');
    expect(status).toBe(507);
    expect(body).toMatchObject({ error: 'project_storage_full', requestId: 'rid-1', docsUrl: expect.stringMatching(/#project_storage_full$/) });
    expect(body.fix).toEqual(expect.any(String));
    // 5xx khác vẫn bị che như cũ
    expect(toErrorBody(new HttpException({ error: 'project_storage_full' }, 500), 'rid-2').body.error).toBe('internal_error');
  });

  it('[QT:T3] (phần b) chỉ 507 project_storage_full được giữ; internal_error/service_unavailable của catalog vẫn che message/detail như trước QT (review M1)', async () => {
    // internal_error mang message nội bộ -> 500, KHÔNG detail, không lộ chuỗi; `original` chỉ để log
    const ie = toErrorBody(new HttpException({ error: 'internal_error', message: 'db at 10.0.0.5' }, 500), 'r1');
    expect(ie.status).toBe(500);
    expect(ie.body.error).toBe('internal_error');
    expect(ie.body).not.toHaveProperty('detail');
    expect(JSON.stringify(ie.body)).not.toContain('10.0.0.5');
    expect(ie.original).toEqual({ error: 'internal_error', message: 'db at 10.0.0.5' });
    // service_unavailable (hubError kèm câu tiếng Việt) -> 503, không detail, original giữ cho log
    const su = toErrorBody(new HttpException({ error: 'service_unavailable', message: 'Không gửi được email thử' }, 503), 'r2');
    expect(su.status).toBe(503);
    expect(su.body.error).toBe('service_unavailable');
    expect(su.body).not.toHaveProperty('detail');
    expect(su.original).toEqual({ error: 'service_unavailable', message: 'Không gửi được email thử' });
    // 507 vẫn 507, có detail, không original
    const full = toErrorBody(new HttpException({ error: 'project_storage_full', message: 'Project hết dung lượng' }, 507), 'r3');
    expect(full.status).toBe(507);
    expect(full.body).toMatchObject({ error: 'project_storage_full', detail: 'Project hết dung lượng' });
    expect(full.original).toBeUndefined();
  });

  it('[QT:T5] project A LOCKED thì project B cùng hub vẫn nhận 200 (/hooks và publish)', async () => {
    const { svc, tx } = setup({ a: { level: 'LOCKED' }, b: { level: 'OK' } });
    expect((await svc.ingestWebhook(hook('a'))).status).toBe(507);
    expect((await svc.ingestWebhook(hook('b'))).status).toBe(200);
    expect((await publish(svc, 'a')).status).toBe(507);
    expect((await publish(svc, 'b')).status).toBe(202);
    expect(tx.rawEvent.create).toHaveBeenCalledTimes(2);
  });

  it('[QT:T29] LOCKED: source "Giữ lâu" 200, source thường 507; HARD_LOCKED: cả hai 507 — như nhau cho /hooks và publish; 507 không tốn lệnh Redis', async () => {
    const cases: [string, Src, number, number][] = [
      ['lk', { level: 'LOCKED', keepLonger: true }, 200, 202],
      ['ln', { level: 'LOCKED', keepLonger: false }, 507, 507],
      ['hk', { level: 'HARD_LOCKED', keepLonger: true }, 507, 507],
      ['hn', { level: 'HARD_LOCKED', keepLonger: false }, 507, 507],
      ['ck', { level: 'CRITICAL_95', keepLonger: false }, 200, 202],
    ];
    for (const [key, src, hooksStatus, publishStatus] of cases) {
      const { svc, redisCalls } = setup({ [key]: src });
      expect([key, (await svc.ingestWebhook(hook(key))).status]).toEqual([key, hooksStatus]);
      expect([key, (await publish(svc, key)).status]).toEqual([key, publishStatus]);
      if (hooksStatus === 507) expect(redisCalls()).toBe(0);
      else expect(redisCalls()).toBe(6); // 2 đường × (EVAL + GET + SET) — y như khi không có QT
    }
  });

  it('[QT:T30] (phần b) STORAGE_LOCK_ENABLED=0: LOCKED / HARD_LOCKED vẫn 200 và tăng hub_ingest_storage_would_reject_total, không tăng rejected', async () => {
    const { svc } = setup({ x: { level: 'HARD_LOCKED' }, y: { level: 'LOCKED' } }, { lockEnabled: false });
    const before = { hooks: await metric('hub_ingest_storage_would_reject_total', 'hooks'), pub: await metric('hub_ingest_storage_would_reject_total', 'publish') };
    const rejectedBefore = await metric('hub_ingest_storage_rejected_total', 'hooks');
    expect((await svc.ingestWebhook(hook('x'))).status).toBe(200);
    expect((await svc.ingestWebhook(hook('y'))).status).toBe(200);
    expect((await publish(svc, 'x')).status).toBe(202);
    expect(await metric('hub_ingest_storage_would_reject_total', 'hooks')).toBe(before.hooks + 2);
    expect(await metric('hub_ingest_storage_would_reject_total', 'publish')).toBe(before.pub + 1);
    expect(await metric('hub_ingest_storage_rejected_total', 'hooks')).toBe(rejectedBefore);
    // mặc định của code: tắt
    delete process.env.STORAGE_LOCK_ENABLED;
    expect(new IngestService({} as any, {} as any).storageLockEnabled).toBe(false);
  });

  it('[QT:T8] nấc đọc không được (giá trị hỏng) -> fail-open (coi như OK) + ghi log; chưa đo (null) -> OK, không log', async () => {
    const warns: unknown[] = [];
    const realChild = logger.child.bind(logger);
    const spy = jest.spyOn(logger, 'child').mockImplementation((b: any, o?: any) => {
      const c = realChild(b, o);
      const w = c.warn.bind(c);
      (c as any).warn = (obj: unknown, msg?: string) => {
        warns.push(msg);
        return w(obj as any, msg as any);
      };
      return c;
    });
    try {
      const { svc } = setup({ bad: { level: 'L0CKED??' }, none: { level: null } });
      expect((await svc.ingestWebhook(hook('bad'))).status).toBe(200);
      expect((await publish(svc, 'bad')).status).toBe(202);
      expect(warns.filter((m) => String(m).includes('fail-open'))).toHaveLength(2);
      warns.length = 0;
      expect((await svc.ingestWebhook(hook('none'))).status).toBe(200);
      expect(warns.filter((m) => String(m).includes('fail-open'))).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });

  it('[QT:T6] đường ACCEPTED không đổi số lệnh Redis (EVAL + GET + SET), 507 = 0 lệnh — redis-budget.spec.ts giữ nguyên', async () => {
    const ok = setup({ s: { level: 'WARN_85' } });
    expect((await ok.svc.ingestWebhook(hook('s'))).status).toBe(200);
    expect([ok.redis.checkRateLimit.mock.calls.length, ok.redis.getIdempotencyKey.mock.calls.length, ok.redis.setIdempotencyKey.mock.calls.length]).toEqual([1, 1, 1]);
    const full = setup({ s: { level: 'HARD_LOCKED' } });
    expect((await full.svc.ingestWebhook(hook('s'))).status).toBe(507);
    expect(full.redisCalls()).toBe(0);
  });

  it('[QT:T7] (phần a) số truy vấn DB của đường ingest KHÔNG tăng: bước 2 vẫn MỘT batch (set_config + câu source⋈project_usage + câu secrets); publish nạp source + nấc bằng MỘT câu', async () => {
    const svc = new PrismaService();
    const batches: unknown[][] = [];
    const sql: string[] = [];
    const fake = {
      $transaction: jest.fn(async (arr: unknown[]) => {
        batches.push(arr);
        return [1, [{ id: 'S', tenantId: 'T', provider: 'github', isActive: true, archivedAt: null, keepLonger: true, storageLevel: 'LOCKED' }], [{ id: 'sec', sourceId: 'S' }, { id: 'other', sourceId: 'X' }]];
      }),
      $executeRaw: jest.fn(() => 'set_config'),
      $queryRaw: jest.fn((strings: TemplateStringsArray) => {
        sql.push(strings.join('?'));
        return 'select-source';
      }),
      sourceSecret: { findMany: jest.fn(() => 'select-secrets') },
      source: { findUnique: jest.fn() },
    };
    (svc as any).client = fake;
    const s = await svc.findSourceBySourceKeyForIngest('key');
    expect(fake.$transaction).toHaveBeenCalledTimes(1); // một lượt gửi
    expect(batches[0]).toEqual(['set_config', 'select-source', 'select-secrets']); // 2 câu SQL như trước (sources + secrets)
    expect(fake.source.findUnique).not.toHaveBeenCalled();
    expect(sql[0]).toMatch(/LEFT JOIN hub\.project_usage pu ON pu\.tenant_id = s\.tenant_id/);
    expect(s).toMatchObject({ id: 'S', storageLevel: 'LOCKED', keepLonger: true, secrets: [{ id: 'sec', sourceId: 'S' }] });

    // publish: repo trong tx có sẵn -> đúng MỘT $queryRaw (không include secrets)
    const q: string[] = [];
    const tx: any = {
      $executeRaw: jest.fn(async () => 1),
      $queryRaw: jest.fn(async (p: { strings?: string[]; sql?: string }) => {
        q.push(String(p.sql ?? p.strings?.join('?')));
        return [{ id: 'S', storageLevel: null }];
      }),
      source: { findFirst: jest.fn() },
    };
    const repo = new TenantScopedRepository(tx, '00000000-0000-0000-0000-0000000000aa');
    expect(await repo.findSourceById('00000000-0000-0000-0000-0000000000bb', { withStorageLevel: true })).toEqual({ id: 'S', storageLevel: null });
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(tx.source.findFirst).not.toHaveBeenCalled();
    expect(q[0]).toMatch(/LEFT JOIN hub\.project_usage/);
  });
});
