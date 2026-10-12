import { createHmac } from 'crypto';
import { aesGcmEncrypt } from '@hub/crypto';
import { IngestService } from '../src/modules/ingest/ingest.service';
import { PenaltyBox, PenaltyConfig, ipKey, isLocalOrPrivateIp, resolvePenaltyConfig } from '../src/modules/ingest/penalty-box';
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
    box.recordUnknownSource('203.0.113.1');
    box.recordUnknownSource('203.0.113.1'); // bị phạt (khoá cũ nhất)
    for (let i = 0; i < 100; i++) box.recordUnknownSource(`198.51.${i >> 8}.${i & 255}`);
    expect(box.size()).toBe(10);
    expect(box.checkIp('203.0.113.1').blocked).toBe(true);
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
    expect(resolvePenaltyConfig({})).toMatchObject({ threshold404: 20, threshold401: 30, banMs: 600_000, maxEntries: 50_000, enabled: true, goodTtlMs: 86_400_000 });
    expect(resolvePenaltyConfig({ EDGE_PENALTY_ENABLED: '0', EDGE_PENALTY_GOOD_TTL: '1' })).toMatchObject({ enabled: false, goodTtlMs: 300_000 });
    expect(resolvePenaltyConfig({ EDGE_PENALTY_404_THRESHOLD: '1', EDGE_PENALTY_401_THRESHOLD: 'abc', EDGE_PENALTY_BAN_SECONDS: '999999999', EDGE_PENALTY_MAX_ENTRIES: '5' }))
      .toMatchObject({ threshold404: 5, threshold401: 30, banMs: 86_400_000, maxEntries: 1_000 });
  });

  it('[EG:T17] luật (a) không chặn CẶP TỐT (đã verify đúng) của IP đang bị phạt, vẫn chặn key lạ — flood 404 vào IP GitHub không cắt source của tenant khác', async () => {
    const { svc, prisma } = build({ srcA: src('A') });
    const gh = '140.82.115.20'; // IP hook chung của GitHub
    expect((await svc.ingestWebhook(req('srcA', gh))).status).toBe(200); // tenant A nhận bình thường -> cặp tốt
    // kẻ xấu trỏ repo của nó vào key không tồn tại: 20 lần 404 từ CÙNG IP GitHub -> IP bị phạt
    for (let i = 0; i < 20; i++) expect((await svc.ingestWebhook(req(`khong_co_${i}`, gh))).status).toBe(404);
    const calls = prisma.findSourceBySourceKeyForIngest.mock.calls.length;
    expect((await svc.ingestWebhook(req('khong_co_moi', gh))).status).toBe(429); // key lạ vẫn bị chặn trước DB
    expect(prisma.findSourceBySourceKeyForIngest.mock.calls.length).toBe(calls);
    expect((await svc.ingestWebhook(req('srcA', gh))).status).toBe(200); // cặp tốt vẫn đi tiếp
    // hộp thuần: hết hạn cặp tốt -> lại bị chặn
    let now = 0;
    const box = new PenaltyBox(cfg({ threshold404: 2, goodTtlMs: 1000, banMs: 600_000 }), {}, () => now);
    box.markGood(gh, 'k');
    box.recordUnknownSource(gh);
    box.recordUnknownSource(gh);
    expect(box.checkIp(gh, 'k').blocked).toBe(false);
    expect(box.checkIp(gh, 'la').blocked).toBe(true);
    expect(box.checkIp(gh).blocked).toBe(true);
    now = 1001;
    expect(box.checkIp(gh, 'k').blocked).toBe(true);
  });

  it('[EG:T18] luật (b) với cặp tốt NÂNG ngưỡng (×10), không miễn: sai/đúng xen kẽ của GitHub không bị ban oan; flood 401 vô hạn cuối cùng vẫn bị ban', async () => {
    const { svc } = build({ srcA: src('A') });
    const gh = '140.82.115.30';
    expect((await svc.ingestWebhook(req('srcA', gh))).status).toBe(200); // cặp tốt
    // kẻ biết key nạn nhân đặt secret sai ở GitHub: 100 lần sai/phút xen với giao hàng thật -> không ban (ngưỡng 30 × 10)
    for (let i = 0; i < 100; i++) {
      expect((await svc.ingestWebhook(req('srcA', gh, sign('secret-cua-ke-xau')))).status).toBe(401);
      if (i % 10 === 0) expect((await svc.ingestWebhook(req('srcA', gh))).status).toBe(200);
    }
    expect(svc.penalty.activeBansFor('A')).toEqual([]);
    // flood không giới hạn trên cặp tốt (1 request đúng rồi bắn sai mãi): tới 300 lần trong cửa sổ thì bị ban
    for (let i = 0; i < 200; i++) await svc.ingestWebhook(req('srcA', gh, sign('secret-cua-ke-xau')));
    expect((await svc.ingestWebhook(req('srcA', gh, sign('secret-cua-ke-xau')))).status).toBe(429);
    expect(svc.penalty.activeBansFor('A')).toHaveLength(1);
    // cặp CHƯA từng verify đúng vẫn bị ban ở ngưỡng thường (30)
    for (let i = 0; i < 30; i++) await svc.ingestWebhook(req('srcA', '203.0.113.99', sign('sai')));
    expect((await svc.ingestWebhook(req('srcA', '203.0.113.99'))).status).toBe(429);
  });

  it('review lượt 2 CHẶN A: cache tốt chia theo sourceKey — 1 key × N IP (N > trần) không đẩy được cặp tốt của key khác; bảng ngoài loại key hoạt động cũ nhất', () => {
    const box = new PenaltyBox(cfg({ threshold404: 2, maxEntries: 1000, goodIpsPerKey: 64, maxGoodKeys: 3 }));
    const gh = '140.82.115.40';
    box.markGood(gh, 'key-nan-nhan');
    // kẻ xấu: source riêng, 50k request ký đúng, mỗi request một /64 khác nhau
    for (let i = 0; i < 50_000; i++) box.markGood(`2001:db8:${(i >> 16) & 0xffff}:${i & 0xffff}::1`, 'key-ke-xau');
    expect(box.goodSize()).toBe(64 + 1);
    box.recordUnknownSource(gh);
    box.recordUnknownSource(gh); // IP GitHub bị ban qua chiêu 404
    expect(box.checkIp(gh, 'key-nan-nhan').blocked).toBe(false); // cặp tốt của nạn nhân còn nguyên
    expect(box.checkIp(gh, 'khong_co').blocked).toBe(true);
    // muốn đẩy key thật ra phải có nhiều key hợp lệ ĐANG hoạt động hơn trần bảng ngoài
    box.markGood('198.51.100.1', 'k1');
    box.markGood('198.51.100.1', 'k2');
    box.markGood('198.51.100.1', 'k3');
    expect(box.checkIp(gh, 'key-nan-nhan').blocked).toBe(true);
  });

  it('review lượt 2 CHẶN A(3): request bị rate limit (429) KHÔNG được đánh dấu cặp tốt', async () => {
    const { svc, redis } = build({ srcA: src('A') });
    redis.checkRateLimit.mockResolvedValue(false);
    expect((await svc.ingestWebhook(req('srcA', '203.0.113.60'))).status).toBe(429);
    expect(svc.penalty.goodSize()).toBe(0);
    redis.checkRateLimit.mockResolvedValue(true);
    expect((await svc.ingestWebhook(req('srcA', '203.0.113.60'))).status).toBe(200);
    expect(svc.penalty.goodSize()).toBe(1);
  });

  it('review CHẶN 1: ban hết hạn được quét, ban có trần riêng (≤50%), khoá vừa chèn không bị loại — hộp đầy không tự vô hiệu', () => {
    let now = 0;
    const skipped = jest.fn();
    const box = new PenaltyBox(cfg({ threshold404: 2, maxEntries: 1000 }), { onBanSkipped: skipped }, () => now);
    const ipOf = (i: number) => `203.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`;
    for (let i = 0; i < 1000; i++) {
      box.recordUnknownSource(ipOf(i));
      box.recordUnknownSource(ipOf(i));
    }
    expect(box.bannedSize()).toBe(500); // trần riêng của ban
    expect(box.size()).toBeLessThanOrEqual(1000);
    expect(skipped).toHaveBeenCalledWith('unknown_source', 'capacity'); // đầy -> không phạt, có tiếng
    // đang đầy: IP mới vẫn được ĐẾM (khoá vừa chèn không bị loại ngay)
    box.recordUnknownSource('198.51.100.1');
    expect(box.size()).toBeLessThanOrEqual(1000);
    now += 3_600_000; // mọi ban đã hết hạn
    for (let i = 0; i < 50; i++) box.recordUnknownSource('198.51.100.77');
    expect(box.checkIp('198.51.100.77').blocked).toBe(true);
    expect(box.bannedSize()).toBe(1);
  });

  it('review NÊN 3: IP loopback/private không chấm điểm, không chặn; EDGE_PENALTY_ENABLED=0 tắt hẳn; IPv4-mapped dạng hex', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.1.1', '100.64.0.1', '100.127.255.255', '::1', '::ffff:127.0.0.1', '::ffff:7f00:1', 'fd00::1', 'fc12::5', 'fe80::1', 'febf::1']) {
      expect([ip, isLocalOrPrivateIp(ip)]).toEqual([ip, true]);
    }
    for (const ip of ['172.32.0.1', '100.128.0.1', '203.0.113.7', '2001:db8::1', 'fec0::1', '::ffff:cb00:7107']) expect([ip, isLocalOrPrivateIp(ip)]).toEqual([ip, false]);
    expect(ipKey('::ffff:cb00:7107')).toBe('203.0.113.7');
    const skippedPrivate = jest.fn();
    const box = new PenaltyBox(cfg({ threshold404: 2 }), { onSkippedPrivate: skippedPrivate });
    for (let i = 0; i < 10; i++) box.recordUnknownSource('172.18.0.5'); // NAT của Docker
    expect(skippedPrivate).toHaveBeenCalledTimes(10); // không câm: metric skipped{cause="private_ip"}
    expect(box.checkIp('172.18.0.5').blocked).toBe(false);
    expect(box.size()).toBe(0);
    const off = new PenaltyBox(cfg({ threshold404: 2, enabled: false }));
    for (let i = 0; i < 10; i++) off.recordUnknownSource('203.0.113.7');
    expect(off.checkIp('203.0.113.7').blocked).toBe(false);
  });

  it('review THẤP: metric lỗi không lật verdict blocked thành cho qua; 429 của hộp phạt ghi outcome BLOCKED', async () => {
    const { svc } = build({});
    for (let i = 0; i < 20; i++) await svc.ingestWebhook(req(`x${i}`, '203.0.113.150'));
    const spy = jest.spyOn(require('../src/modules/metrics/metrics').penaltyEntries, 'set').mockImplementation(() => {
      throw new Error('metric hỏng');
    });
    expect((await svc.ingestWebhook(req('x21', '203.0.113.150'))).status).toBe(429);
    spy.mockRestore();
    expect(await apiRegistry.metrics()).toMatch(/hub_ingest_requests_total\{provider="github",outcome="BLOCKED"\} [1-9]/);
  });
});
