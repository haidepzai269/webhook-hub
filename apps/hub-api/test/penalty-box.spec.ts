import { createHmac } from 'crypto';
import { aesGcmEncrypt } from '@hub/crypto';
import { IngestService } from '../src/modules/ingest/ingest.service';
import { PenaltyBox, PenaltyConfig, ipKey, resolvePenaltyConfig } from '../src/modules/ingest/penalty-box';
import { apiRegistry } from '../src/modules/metrics/metrics';

/**
 * EG2 (SPEC-chong-qua-tai §4, ADR-177): hộp phạt IP trong bộ nhớ của `/hooks/*` — 0 Redis, 0 DB, fail-open.
 */
const MASTER = 'test-master-key-at-least-32-characters!!';
const SECRET = 'gh-secret-eg';
const body = JSON.stringify({ ref: 'refs/heads/main', after: 'abc', repository: { name: 'r' } });
const sign = (s: string) => `sha256=${createHmac('sha256', s).update(body).digest('hex')}`;

type Src = { id: string; tenantId: string; isActive: boolean; archivedAt: Date | null; secrets: { id: string; secretEncrypted: string }[] };

function build(sources: Record<string, Src | null>) {
  const tx = { rawEvent: { create: jest.fn().mockResolvedValue({ id: 'raw-1' }) }, outbox: { create: jest.fn() } };
  const prisma: any = {
    findSourceBySourceKeyForIngest: jest.fn(async (k: string) => sources[k] ?? null),
    tenantTx(_t: any, fn: any) { return this.$transaction(fn); },
    $transaction: jest.fn(async (fn: any) => fn(tx)),
  };
  const redis: any = {
    checkRateLimit: jest.fn().mockResolvedValue(true),
    getIdempotencyKey: jest.fn().mockResolvedValue(null),
    setIdempotencyKey: jest.fn().mockResolvedValue(undefined),
  };
  return { svc: new IngestService(prisma, redis), prisma, redis };
}

const src = (id: string, extra: Partial<Src> = {}): Src => ({
  id, tenantId: `tenant-${id}`, isActive: true, archivedAt: null, secrets: [{ id: 's', secretEncrypted: aesGcmEncrypt(SECRET, MASTER) }], ...extra,
});

let delivery = 0;
const req = (sourceKey: string, ip: string, signature = sign(SECRET)) => ({
  provider: 'github' as const,
  sourceKey,
  headers: { 'x-hub-signature-256': signature, 'x-github-delivery': `d-${++delivery}`, 'x-github-event': 'push' },
  rawBody: Buffer.from(body),
  body: JSON.parse(body),
  contentType: 'application/json',
  ip,
});

const cfg = (o: Partial<PenaltyConfig> = {}): PenaltyConfig => ({ threshold404: 20, threshold401: 30, banMs: 600_000, maxEntries: 50_000, windowMs: 60_000, ...o });

describe('EG2 hộp phạt IP (ADR-177)', () => {
  beforeAll(() => {
    process.env.MASTER_KEY = MASTER;
  });

  it('[EG:T1] 20 lần 404 do source==null từ một IP -> request thứ 21 nhận 429 ip_temporarily_blocked + Retry-After, KHÔNG gọi findSourceBySourceKeyForIngest', async () => {
    const { svc, prisma } = build({});
    for (let i = 0; i < 20; i++) expect((await svc.ingestWebhook(req(`rac_${i}`, '203.0.113.7'))).status).toBe(404);
    expect(prisma.findSourceBySourceKeyForIngest).toHaveBeenCalledTimes(20);
    const res = await svc.ingestWebhook(req('rac_21', '203.0.113.7'));
    expect(res.status).toBe(429);
    expect(res.headers?.['Retry-After']).toBe('600');
    expect(res.body).toMatchObject({ error: 'ip_temporarily_blocked', retryAfter: 600, docsUrl: expect.stringContaining('#ip_temporarily_blocked') });
    expect((res.body as any).fix).toMatch(/600 seconds/);
    expect(prisma.findSourceBySourceKeyForIngest).toHaveBeenCalledTimes(20);
    // IP khác không bị vạ lây
    expect((await svc.ingestWebhook(req('rac_x', '198.51.100.9'))).status).toBe(404);
    // metric
    const m = await apiRegistry.metrics();
    expect(m).toMatch(/hub_ingest_penalty_bans_total\{reason="unknown_source"\} [1-9]/);
    expect(m).toMatch(/hub_ingest_penalty_blocked_total\{reason="unknown_source"\} [1-9]/);
    expect(m).toMatch(/hub_ingest_unknown_source_total [1-9]/);
    expect(m).toMatch(/hub_ingest_penalty_entries \d/);
  });

  it('[EG:T4] 404 do source ĐÃ LƯU TRỮ hoặc TẮT không tính điểm: 100 lần vẫn không bị phạt', async () => {
    const { svc, prisma } = build({
      archived: src('a1', { isActive: false, archivedAt: new Date() }),
      off: src('a2', { isActive: false }),
    });
    for (let i = 0; i < 100; i++) {
      expect((await svc.ingestWebhook(req(i % 2 ? 'archived' : 'off', '192.0.2.10'))).status).toBe(404);
    }
    expect(prisma.findSourceBySourceKeyForIngest).toHaveBeenCalledTimes(100);
    expect(svc.penalty.size()).toBe(0);
  });

  it('[EG:T5] 401 phạt THEO CẶP: IP X bị phạt trên source A nhưng vẫn gửi vào source B bình thường (một tenant cấu hình sai secret GitHub)', async () => {
    const { svc } = build({ srcA: src('A'), srcB: src('B') });
    const ip = '140.82.115.10'; // IP chung của GitHub
    for (let i = 0; i < 30; i++) expect((await svc.ingestWebhook(req('srcA', ip, sign('sai-secret')))).status).toBe(401);
    const blocked = await svc.ingestWebhook(req('srcA', ip)); // kể cả chữ ký ĐÚNG: cặp đang bị phạt
    expect(blocked.status).toBe(429);
    expect(blocked.body).toMatchObject({ error: 'ip_temporarily_blocked' });
    expect(Number(blocked.headers?.['Retry-After'])).toBeGreaterThan(0);
    // cùng IP, source khác (tenant khác) -> không bị chặn
    expect((await svc.ingestWebhook(req('srcB', ip))).status).toBe(200);
    // EG5: hộp phạt nhớ chủ của khoá phạt
    expect(svc.penalty.activeBansFor('A')).toEqual([{ ip, remainingSec: 600 }]);
    expect(svc.penalty.activeBansFor('B')).toEqual([]);
  });

  it('[EG:T6] IPv6 cùng /64 là MỘT khoá; trần MAX_ENTRIES được tôn trọng, khoá đang bị phạt không bị loại trước', () => {
    expect(ipKey('2001:db8:aa:bb:1::1')).toBe(ipKey('2001:db8:aa:bb:ffff:2:3:4'));
    expect(ipKey('2001:db8:aa:bb::1')).toBe('2001:db8:aa:bb::/64');
    expect(ipKey('2001:db8:aa:bc::1')).not.toBe(ipKey('2001:db8:aa:bb::1'));
    expect(ipKey('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(ipKey('khong-phai-ip')).toBeNull();

    const v6 = new PenaltyBox(cfg({ threshold404: 3 }));
    v6.recordUnknownSource('2001:db8:aa:bb::1');
    v6.recordUnknownSource('2001:db8:aa:bb::2');
    v6.recordUnknownSource('2001:db8:aa:bb:9:9:9:9');
    expect(v6.checkIp('2001:db8:aa:bb::abcd').blocked).toBe(true);
    expect(v6.checkIp('2001:db8:aa:bc::1').blocked).toBe(false);

    const box = new PenaltyBox(cfg({ threshold404: 2, maxEntries: 10 }));
    box.recordUnknownSource('10.0.0.1');
    box.recordUnknownSource('10.0.0.1'); // bị phạt (khoá cũ nhất)
    for (let i = 0; i < 100; i++) box.recordUnknownSource(`10.1.${i >> 8}.${i & 255}`);
    expect(box.size()).toBe(10);
    expect(box.checkIp('10.0.0.1').blocked).toBe(true);
  });

  it('[EG:T7] hộp phạt ném lỗi -> request vẫn chạy bình thường (fail-open)', async () => {
    const { svc } = build({ ok: src('ok') });
    const boom = () => {
      throw new Error('hộp phạt hỏng');
    };
    svc.penalty = { checkIp: boom, checkPair: boom, recordUnknownSource: boom, recordBadSignature: boom, size: boom } as any;
    expect((await svc.ingestWebhook(req('ok', '203.0.113.50'))).status).toBe(200);
    expect((await svc.ingestWebhook(req('khong_co', '203.0.113.50'))).status).toBe(404);
    expect((await svc.ingestWebhook(req('ok', '203.0.113.50', sign('sai')))).status).toBe(401);
  });

  it('không có IP (gọi nội bộ/test) -> không chấm điểm, không chặn; cửa sổ 60s hết hạn thì đếm lại; hết hạn phạt thì thả', () => {
    let now = 0;
    const box = new PenaltyBox(cfg({ threshold404: 3, banMs: 30_000 }), {}, () => now);
    for (let i = 0; i < 10; i++) box.recordUnknownSource(undefined);
    expect(box.size()).toBe(0);
    box.recordUnknownSource('1.2.3.4');
    box.recordUnknownSource('1.2.3.4');
    now = 61_000; // qua cửa sổ -> đếm lại từ 0
    box.recordUnknownSource('1.2.3.4');
    expect(box.checkIp('1.2.3.4').blocked).toBe(false);
    box.recordUnknownSource('1.2.3.4');
    box.recordUnknownSource('1.2.3.4');
    const v = box.checkIp('1.2.3.4');
    expect(v).toMatchObject({ blocked: true, reason: 'unknown_source', retryAfterSec: 30 });
    now += 30_001;
    expect(box.checkIp('1.2.3.4').blocked).toBe(false);
  });

  it('tham số env được kẹp (giống resolveSendTimeoutMs)', () => {
    expect(resolvePenaltyConfig({})).toMatchObject({ threshold404: 20, threshold401: 30, banMs: 600_000, maxEntries: 50_000 });
    expect(resolvePenaltyConfig({ EDGE_PENALTY_404_THRESHOLD: '1', EDGE_PENALTY_401_THRESHOLD: 'abc', EDGE_PENALTY_BAN_SECONDS: '999999999', EDGE_PENALTY_MAX_ENTRIES: '5' }))
      .toMatchObject({ threshold404: 5, threshold401: 30, banMs: 86_400_000, maxEntries: 1_000 });
  });
});
