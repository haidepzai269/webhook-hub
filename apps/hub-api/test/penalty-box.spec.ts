import { createHmac } from 'crypto';
import { aesGcmEncrypt } from '@hub/crypto';
import { IngestService } from '../src/modules/ingest/ingest.service';
import { PenaltyBox, PenaltyConfig, clampEnvInt, ipKey, isLocalOrPrivateIp, resolvePenaltyConfig } from '../src/modules/ingest/penalty-box';
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

  it('[EG:T1] (phần a) 20 lần 404 do source==null từ một IP -> request thứ 21 nhận 429 ip_temporarily_blocked + Retry-After, KHÔNG gọi findSourceBySourceKeyForIngest', async () => {
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
    box.markGood(gh, 'k', 't');
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

  it('review lượt 2 CHẶN A: cache tốt chia theo sourceKey — 1 key × N IP (N > trần) không đẩy được cặp tốt của key khác; bảng ngoài có trần, loại theo tenant giữ nhiều nhất', () => {
    const box = new PenaltyBox(cfg({ threshold404: 2, maxEntries: 1000, goodIpsPerKey: 64, maxGoodKeys: 3 }));
    const gh = '140.82.115.40';
    box.markGood(gh, 'key-nan-nhan', 'tenant-Y');
    // kẻ xấu: source riêng, 50k request ký đúng, mỗi request một /64 khác nhau
    for (let i = 0; i < 50_000; i++) box.markGood(`2001:db8:${(i >> 16) & 0xffff}:${i & 0xffff}::1`, 'key-ke-xau', 'tenant-X');
    expect(box.goodSize()).toBe(64 + 1);
    box.recordUnknownSource(gh);
    box.recordUnknownSource(gh); // IP GitHub bị ban qua chiêu 404
    expect(box.checkIp(gh, 'key-nan-nhan').blocked).toBe(false); // cặp tốt của nạn nhân còn nguyên
    expect(box.checkIp(gh, 'khong_co').blocked).toBe(true);
    // muốn đẩy key thật ra phải có nhiều key hợp lệ ĐANG hoạt động hơn trần bảng ngoài
    box.markGood('198.51.100.1', 'k1', 'tenant-1');
    box.markGood('198.51.100.1', 'k2', 'tenant-2');
    box.markGood('198.51.100.1', 'k3', 'tenant-3');
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
    const box = new PenaltyBox(cfg({ threshold404: 2 }));
    for (let i = 0; i < 10; i++) box.recordUnknownSource('172.18.0.5'); // NAT của Docker
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

  it('review lượt 3 CHẶN 1: trần TỔNG số cặp tốt được tôn trọng (50k key × 64 IP không làm phình RAM), loại key cũ nhất của tenant giữ nhiều nhất', () => {
    const box = new PenaltyBox(cfg({ goodIpsPerKey: 16, maxGoodKeys: 10_000, goodMaxEntries: 2_000, goodKeysPerTenant: 1_000_000 }));
    for (let key = 0; key < 500; key++) {
      for (let i = 0; i < 64; i++) box.markGood(`198.${key >> 8}.${key & 255}.${i}`, `k${key}`, `t${key % 7}`);
      expect(box.goodSize()).toBeLessThanOrEqual(2_000);
    }
    expect(box.goodSize()).toBe(2_000); // 125 key × 16 IP
    expect(box.goodKeyCount()).toBe(125);
    expect(resolvePenaltyConfig({})).toMatchObject({ goodIpsPerKey: 16, maxGoodKeys: 10_000, goodMaxEntries: 100_000, goodKeysPerTenant: 64 });
    const keys = new PenaltyBox(cfg({ maxGoodKeys: 100, goodKeysPerTenant: 1_000_000 }));
    for (let key = 0; key < 1_000; key++) keys.markGood('203.0.113.1', `k${key}`, `t${key}`);
    expect(keys.goodKeyCount()).toBe(100);
  });

  it('review lượt 3 NÊN 2: tenant X tạo 1000 key tốt không đẩy được key của tenant Y (LRU theo tenant)', () => {
    const box = new PenaltyBox(cfg({ threshold404: 2, goodKeysPerTenant: 64, maxGoodKeys: 10_000 }));
    const gh = '140.82.115.50';
    box.markGood(gh, 'key-Y', 'tenant-Y');
    for (let i = 0; i < 1_000; i++) box.markGood(gh, `key-X-${i}`, 'tenant-X');
    expect(box.goodKeyCount()).toBe(64 + 1);
    box.recordUnknownSource(gh);
    box.recordUnknownSource(gh);
    expect(box.checkIp(gh, 'key-Y').blocked).toBe(false);
    expect(box.checkIp(gh, 'key-X-999').blocked).toBe(false); // key mới nhất của X còn
    expect(box.checkIp(gh, 'key-X-0').blocked).toBe(true); // X chỉ đẩy được key của chính nó
  });

  it('review lượt 3 NÊN 3: một request từ IP private chỉ tăng hub_ingest_penalty_skipped_private_total đúng 1', async () => {
    const { svc } = build({ srcA: src('A') });
    const metric = async () => Number(/hub_ingest_penalty_skipped_private_total (\d+)/.exec(await apiRegistry.metrics())?.[1] ?? 0);
    const before = await metric();
    expect((await svc.ingestWebhook(req('srcA', '172.18.0.5', sign('sai')))).status).toBe(401); // checkIp + checkPair + record
    expect(await metric()).toBe(before + 1);
    expect((await svc.ingestWebhook(req('srcA', '172.18.0.5'))).status).toBe(200); // + markGood
    expect(await metric()).toBe(before + 2);
    await svc.ingestWebhook(req('srcA', '203.0.113.5'));
    expect(await metric()).toBe(before + 2);
  });

  it('review lần 4 NÊN: chạm trần toàn cục thì loại key cũ nhất của tenant giữ NHIỀU key nhất — 157 tenant × 64 key không đẩy được victim', () => {
    const box = new PenaltyBox(cfg({ threshold404: 2 })); // trần mặc định: 10k key, 64 key/tenant
    const gh = '140.82.115.60';
    box.markGood(gh, 'victim', 'tenant-victim');
    for (let t = 0; t < 157; t++) for (let k = 0; k < 64; k++) box.markGood(gh, `t${t}-k${k}`, `tenant-${t}`);
    expect(box.goodKeyCount()).toBe(10_000);
    box.recordUnknownSource(gh);
    box.recordUnknownSource(gh);
    expect(box.checkIp(gh, 'victim').blocked).toBe(false); // victim (1 key) còn nguyên
    // tenant 1–2 key chỉ bị đụng khi mọi tenant đã xuống còn chừng ấy: trần 3 key, 3 tenant mỗi tenant 1 key + 1 tenant 2 key
    const small = new PenaltyBox(cfg({ maxGoodKeys: 3, goodKeysPerTenant: 64 }));
    small.markGood(gh, 'a1', 'A');
    small.markGood(gh, 'b1', 'B');
    small.markGood(gh, 'b2', 'B');
    small.markGood(gh, 'c1', 'C'); // B giữ nhiều nhất -> b1 bị loại, không phải a1 (cũ nhất toàn cục)
    expect([...['a1', 'b1', 'b2', 'c1']].map((k) => (small as any).good.has(k))).toEqual([true, false, true, true]);
  });
});

/** Review lượt 5 (R5): bất biến đếm/bucket của cache cặp tốt — đọc trạng thái riêng của PenaltyBox. */
function checkGoodInvariants(box: PenaltyBox): string[] {
  const b = box as any;
  const errs: string[] = [];
  let entries = 0;
  const perTenantKeys = new Map<string, number>();
  const perTenantEntries = new Map<string, number>();
  for (const [key, e] of b.good as Map<string, { tenantId: string; ips: Map<string, number> }>) {
    entries += e.ips.size;
    if (e.ips.size === 0) errs.push(`key ${key} rỗng IP`);
    if (!b.tenantKeys.get(e.tenantId)?.has(key)) errs.push(`key ${key} thiếu trong tenantKeys`);
    perTenantKeys.set(e.tenantId, (perTenantKeys.get(e.tenantId) ?? 0) + 1);
    perTenantEntries.set(e.tenantId, (perTenantEntries.get(e.tenantId) ?? 0) + e.ips.size);
  }
  if (entries !== b.goodEntries) errs.push(`goodEntries ${b.goodEntries} != Σ ${entries}`);
  for (const [t, tk] of b.tenantKeys as Map<string, Set<string>>) {
    if (tk.size === 0) errs.push(`tenant ${t} Set rỗng`);
    if (tk.size !== perTenantKeys.get(t)) errs.push(`tenant ${t} tk.size lệch`);
  }
  if (b.tenantKeys.size !== perTenantKeys.size) errs.push('số tenant lệch');
  const tally = (name: string, want: Map<string, number>) => {
    const tl = b[name];
    let inBuckets = 0;
    let top = 0;
    for (const [n, set] of tl.buckets as Map<number, Set<string>>) {
      if (set.size === 0) errs.push(`${name} bucket ${n} rỗng`);
      for (const t of set) if (tl.counts.get(t) !== n) errs.push(`${name} tenant ${t} sai bucket ${n}`);
      inBuckets += set.size;
      if (n > top) top = n;
    }
    if (tl.max !== top) errs.push(`${name} max ${tl.max} != ${top}`);
    if (inBuckets !== tl.counts.size || tl.counts.size !== want.size) errs.push(`${name} số tenant lệch`);
    for (const [t, n] of want) if (tl.counts.get(t) !== n) errs.push(`${name} ${t} đếm ${tl.counts.get(t)} != ${n}`);
  };
  tally('keyTally', perTenantKeys);
  tally('entryTally', perTenantEntries);
  if (b.good.size > b.maxGoodKeys) errs.push('vượt maxGoodKeys');
  if (b.goodEntries > b.goodMaxEntries) errs.push('vượt goodMaxEntries');
  return errs;
}

describe('EG2 hộp phạt — review lượt 5 (cache cặp tốt)', () => {
  const gh = '140.82.115.70';
  const present = (box: PenaltyBox, k: string) => (box as any).good.has(k) as boolean;

  it('TB-1: cùng bucket thì tenant VỪA HOẠT ĐỘNG bị loại sau tenant nằm im (bucket là LRU theo hoạt động)', () => {
    const box = new PenaltyBox(cfg({ maxGoodKeys: 100 }));
    box.markGood(gh, 'victim', 'tenant-victim'); // vào bucket 1 sớm nhất
    for (let i = 0; i < 99; i++) box.markGood(gh, `a${i}`, `atk-${i}`);
    box.markGood(gh, 'victim', 'tenant-victim'); // nạn nhân vừa gửi request đúng
    box.markGood(gh, 'a99', 'atk-99'); // vượt trần
    expect(present(box, 'victim')).toBe(true);
    expect(present(box, 'a0')).toBe(false); // nằm im lâu nhất -> bị loại
    expect(checkGoodInvariants(box)).toEqual([]);
  });

  it('THẤP-1 (R6): tenant bị GIẢM do hết hạn không thành "vừa hoạt động" — đứng trước tenant đang gửi cùng mức', () => {
    let now = 0;
    const box = new PenaltyBox(cfg({ maxGoodKeys: 2, goodTtlMs: 1_000 }), {}, () => now);
    box.markGood(gh, 'q1', 'tenant-quiet'); // hết hạn lúc 1000
    now = 500;
    box.markGood(gh, 'q2', 'tenant-quiet'); // tenant-quiet: 2 key, nằm im từ đây
    now = 900;
    box.markGood('140.82.115.71', 'a1', 'tenant-active'); // ĐANG gửi
    now = 1_001;
    box.recordBadSignature(gh, 'q1', { tenantId: 'tenant-quiet', sourceId: 's-q1' }); // isGood thấy q1 hết hạn -> giảm về 1 key
    expect(present(box, 'q1')).toBe(false);
    box.markGood('140.82.115.72', 'n1', 'tenant-new'); // vượt trần key: bucket 1 = {quiet (nguội), active, new}
    expect(present(box, 'a1')).toBe(true); // trước fix: quiet về CUỐI bucket như vừa hoạt động -> a1 bị loại
    expect(present(box, 'q2')).toBe(false);
    expect(checkGoodInvariants(box)).toEqual([]);
  });

  it('THẤP-1 (R6): tenant đang gọi bị đẩy IP (goodIpsPerKey) vẫn là "vừa hoạt động"', () => {
    const box = new PenaltyBox(cfg({ goodMaxEntries: 8, goodIpsPerKey: 4, maxGoodKeys: 100 }));
    for (let i = 0; i < 4; i++) box.markGood(`2001:db8:1:${i}::1`, 'old', 'tenant-old'); // 4 mục, nằm im
    for (let i = 0; i < 4; i++) box.markGood(`2001:db8:2:${i}::1`, 'cur', 'tenant-cur'); // 4 mục
    box.markGood('2001:db8:2:9::1', 'cur', 'tenant-cur'); // đẩy 1 IP của chính nó: +1 -1, vẫn 4 mục, vẫn nóng
    box.markGood('2001:db8:3::1', 'n', 'tenant-n'); // vượt trần mục: bucket 4 = {old, cur} -> loại old
    expect(present(box, 'cur')).toBe(true);
    expect(present(box, 'old')).toBe(false);
    expect(checkGoodInvariants(box)).toEqual([]);
  });

  it('THẤP-A (R7): tenant đang gọi bị loại key của CHÍNH NÓ vì trần tổng vẫn là "vừa hoạt động" — tenant nằm im bị loại trước', () => {
    const box = new PenaltyBox(cfg({ maxGoodKeys: 4, goodKeysPerTenant: 64 }));
    box.markGood(gh, 'b1', 'B');
    box.markGood(gh, 'b2', 'B'); // B: 2 key, nằm im từ đây
    box.markGood(gh, 'a1', 'A');
    box.markGood(gh, 'a2', 'A');
    box.markGood(gh, 'a3', 'A'); // vượt trần: A (3 key) bị loại a1, về bucket 2 — phải NÓNG (đang gọi)
    expect(present(box, 'a1')).toBe(false);
    box.markGood(gh, 'c1', 'C'); // vượt trần: bucket 2 = {B (nằm im), A (vừa gọi)} -> loại b1
    expect(present(box, 'b1')).toBe(false); // trước fix: A thành nguội, đứng trước B -> a2 bị loại
    expect(['b2', 'a2', 'a3', 'c1'].map((k) => present(box, k))).toEqual([true, true, true, true]);
    expect(checkGoodInvariants(box)).toEqual([]);
  });

  it('NÊN-1: chạm trần MỤC thì loại theo số mục của tenant — tenant 3 key × 1 IP không bị 130 tenant × 16 IP đẩy', () => {
    const box = new PenaltyBox(cfg({ goodMaxEntries: 2_000, goodIpsPerKey: 16, maxGoodKeys: 10_000 }));
    for (const k of ['v1', 'v2', 'v3']) box.markGood(gh, k, 'tenant-victim');
    for (let t = 0; t < 130; t++) for (let i = 0; i < 16; i++) box.markGood(`2001:db8:${t.toString(16)}:${i.toString(16)}::1`, `x${t}`, `atk-${t}`);
    expect(box.goodSize()).toBeLessThanOrEqual(2_000);
    expect(['v1', 'v2', 'v3'].map((k) => present(box, k))).toEqual([true, true, true]);
    expect(checkGoodInvariants(box)).toEqual([]);
  });

  it('NÊN-1: chạm trần KEY vẫn loại theo số key — đường trần mục không làm hỏng tính chất lần 4', () => {
    const small = new PenaltyBox(cfg({ maxGoodKeys: 3, goodKeysPerTenant: 64 }));
    small.markGood(gh, 'a1', 'A');
    small.markGood(gh, 'b1', 'B');
    small.markGood(gh, 'b2', 'B');
    small.markGood(gh, 'c1', 'C');
    expect(['a1', 'b1', 'b2', 'c1'].map((k) => present(small, k))).toEqual([true, false, true, true]);
    expect(checkGoodInvariants(small)).toEqual([]);
  });

  it('NÊN-2/TB-2/THẤP-3: kẹp env — GOOD_MAX_ENTRIES ≤ 500k, GOOD_MAX_KEYS ≤ 50k, chuỗi trắng -> mặc định', () => {
    expect(resolvePenaltyConfig({ EDGE_PENALTY_GOOD_MAX_ENTRIES: '2000000' }).goodMaxEntries).toBe(500_000);
    expect(resolvePenaltyConfig({ EDGE_PENALTY_GOOD_MAX_ENTRIES: '0' }).goodMaxEntries).toBe(2_000);
    expect(resolvePenaltyConfig({ EDGE_PENALTY_GOOD_MAX_KEYS: '1000000' }).maxGoodKeys).toBe(50_000);
    expect(resolvePenaltyConfig({ EDGE_PENALTY_GOOD_MAX_KEYS: '1' }).maxGoodKeys).toBe(100);
    const blank = resolvePenaltyConfig({ EDGE_PENALTY_GOOD_MAX_ENTRIES: ' ', EDGE_PENALTY_GOOD_MAX_KEYS: '\t', EDGE_PENALTY_404_THRESHOLD: '  ' });
    expect(blank).toMatchObject({ goodMaxEntries: 100_000, maxGoodKeys: 10_000, threshold404: 20 });
    expect(clampEnvInt('abc', 7, 1, 10)).toBe(7);
  });

  it('NÊN-2: forgetGoodKey đưa đếm về 0, bucket sạch, gọi hai lần không lỗi', () => {
    const box = new PenaltyBox(cfg());
    box.markGood(gh, 'k1', 'T');
    box.markGood('203.0.113.9', 'k1', 'T');
    box.markGood(gh, 'k2', 'T');
    box.forgetGoodKey('k1');
    expect([box.goodKeyCount(), box.goodSize()]).toEqual([1, 1]);
    expect(checkGoodInvariants(box)).toEqual([]);
    box.forgetGoodKey('k2');
    box.forgetGoodKey('k2');
    box.forgetGoodKey('khong-co');
    expect([box.goodKeyCount(), box.goodSize()]).toEqual([0, 0]);
    expect((box as any).tenantKeys.size).toBe(0);
    expect(checkGoodInvariants(box)).toEqual([]);
  });

  it('NÊN-2: bất biến đếm/bucket giữ đúng sau mọi đường, kể cả hết hạn (fuzz nhỏ, đồng hồ giả)', () => {
    let seed = 12345;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    for (let round = 0; round < 8; round++) {
      let now = 1_000_000;
      const box = new PenaltyBox(
        cfg({ threshold404: 3, threshold401: 3, goodTtlMs: 5_000, maxGoodKeys: 5 + rnd(20), goodIpsPerKey: 2 + rnd(4), goodMaxEntries: 8 + rnd(40), goodKeysPerTenant: 1 + rnd(6) }),
        {},
        () => now,
      );
      for (let op = 0; op < 1_500; op++) {
        const ip = `198.51.100.${rnd(12)}`;
        const key = `k${rnd(30)}`;
        const r = rnd(10);
        if (r < 5) box.markGood(ip, key, `t${rnd(6)}`);
        else if (r < 6) box.forgetGoodKey(key);
        else if (r < 8) box.checkIp(ip, key);
        else box.recordBadSignature(ip, key, { tenantId: 't', sourceId: 's' });
        if (rnd(5) === 0) now += rnd(2_000);
        const errs = checkGoodInvariants(box);
        if (errs.length) throw new Error(`round ${round} op ${op}: ${errs.join('; ')}`);
      }
    }
  });
});
