import {
  advanceCommandPeriod,
  decideNotify,
  formatQuotaMessage,
  parseInfoNumber,
  quotaLevelFor,
  quotaPct,
  resolveQuotaConfig,
  scrubTelegramToken,
} from '../src/quota';

const cfg = { warnPct: 80, critPct: 95 };

describe('quota-alert (ADR-263)', () => {
  it('tính % và kẹp số hỏng về 0', () => {
    expect(quotaPct(256, 512)).toBe(50);
    expect(quotaPct(1, 0)).toBe(0);
    expect(quotaPct(NaN, 10)).toBe(0);
  });

  it('mức theo ngưỡng + độ trễ khi hạ', () => {
    expect(quotaLevelFor(79.9, 'ok', cfg)).toBe('ok');
    expect(quotaLevelFor(80, 'ok', cfg)).toBe('warning');
    expect(quotaLevelFor(95, 'warning', cfg)).toBe('critical');
    expect(quotaLevelFor(94, 'critical', cfg)).toBe('critical'); // trong vùng đệm 2 điểm
    expect(quotaLevelFor(92.9, 'critical', cfg)).toBe('warning');
    expect(quotaLevelFor(79, 'warning', cfg)).toBe('warning');
    expect(quotaLevelFor(77.9, 'warning', cfg)).toBe('ok');
  });

  it('chuyển mức: lên/xuống báo, cùng mức thì im, nhắc lại sau repeatMs', () => {
    const DAY = 86_400_000;
    expect(decideNotify(undefined, 'ok', 0, DAY)).toBeNull(); // khởi động mà vẫn ok: không báo
    expect(decideNotify(undefined, 'warning', 0, DAY)).toBe('up');
    expect(decideNotify({ level: 'warning', notifiedAt: 0 }, 'critical', 1, DAY)).toBe('up');
    expect(decideNotify({ level: 'critical', notifiedAt: 0 }, 'warning', 1, DAY)).toBe('down');
    expect(decideNotify({ level: 'warning', notifiedAt: 0 }, 'ok', 1, DAY)).toBe('down');
    expect(decideNotify({ level: 'warning', notifiedAt: 0 }, 'warning', DAY - 1, DAY)).toBeNull();
    expect(decideNotify({ level: 'warning', notifiedAt: 0 }, 'warning', DAY, DAY)).toBe('repeat');
    expect(decideNotify({ level: 'ok', notifiedAt: 0 }, 'ok', 10 * DAY, DAY)).toBeNull();
  });

  it('cấu hình: mặc định theo DEPLOYMENT, env ghi đè, ngưỡng sai quay về mặc định', () => {
    const d = resolveQuotaConfig({});
    expect(d).toMatchObject({ warnPct: 80, critPct: 95, neonStorageBytes: 512 * 1024 * 1024, upstashCommandsPerMonth: 500_000, upstashMemoryBytes: null, upstashMaxCmdPerSec: 200, upstashMaxGapSec: 1800 });
    expect(resolveQuotaConfig({ DB_DISK_BUDGET_MB: '100' }).neonStorageBytes).toBe(100 * 1024 * 1024);
    expect(resolveQuotaConfig({ QUOTA_NEON_STORAGE_BYTES: '1000', QUOTA_UPSTASH_MEMORY_BYTES: '2000' })).toMatchObject({ neonStorageBytes: 1000, upstashMemoryBytes: 2000 });
    expect(resolveQuotaConfig({ QUOTA_WARN_PCT: '90', QUOTA_CRIT_PCT: '85' })).toMatchObject({ warnPct: 80, critPct: 95 });
  });

  it('INFO: đọc số, thiếu thì null', () => {
    const info = '# Stats\r\ntotal_commands_processed:12345\r\nused_memory:999\r\n';
    expect(parseInfoNumber(info, 'total_commands_processed')).toBe(12345);
    expect(parseInfoNumber(info, 'used_memory')).toBe(999);
    expect(parseInfoNumber(info, 'nope')).toBeNull();
  });

  it('cộng dồn lệnh: mốc đầu, delta, reset thật (giá trị nhỏ), qua tháng', () => {
    const t = (s: string) => Date.parse(s);
    let p = advanceCommandPeriod(undefined, 1000, t('2026-10-10T00:00:00Z'));
    expect(p).toMatchObject({ period: '2026-10', last: 1000, acc: 0 });
    p = advanceCommandPeriod(p, 1500, t('2026-10-10T01:00:00Z'));
    expect(p.acc).toBe(500);
    p = advanceCommandPeriod(p, 200, t('2026-10-10T02:00:00Z')); // server reset thật: 200 <= kẹp
    expect(p).toMatchObject({ last: 200, acc: 700, anomalies: 0 });
    p = advanceCommandPeriod(p, 300, t('2026-11-01T00:00:00Z'));
    expect(p).toMatchObject({ period: '2026-11', last: 300, acc: 0 });
  });

  it('kẹp: tăng vượt giây×maxPerSec thì bỏ mẫu; dao động 11M<->9M không phồng', () => {
    const t0 = Date.parse('2026-10-10T00:00:00Z');
    let p = advanceCommandPeriod(undefined, 11_000_000, t0);
    // tăng 100k sau 15 phút (cap 180k) -> cộng; tăng 1M -> bỏ
    p = advanceCommandPeriod(p, 11_100_000, t0 + 900_000);
    expect(p.acc).toBe(100_000);
    p = advanceCommandPeriod(p, 12_100_000, t0 + 1_800_000);
    expect(p).toMatchObject({ acc: 100_000, last: 12_100_000, anomalies: 1 });
    // dao động
    let q = advanceCommandPeriod(undefined, 11_000_000, t0);
    for (let i = 1; i <= 8; i++) q = advanceCommandPeriod(q, i % 2 ? 9_000_000 : 11_000_000, t0 + i * 900_000);
    expect(q.acc).toBe(0);
    expect(q.anomalies).toBe(8);
  });

  it('khoảng ngủ dài (8h): mẫu lệch nhỏ hơn mức kẹp cũ vẫn bị bỏ, không cộng phồng', () => {
    const t0 = Date.parse('2026-10-10T00:00:00Z');
    const p = advanceCommandPeriod(undefined, 11_000_000, t0);
    const night = advanceCommandPeriod(p, 9_000_000, t0 + 8 * 3_600_000); // 9M < 200×28800 = 5,76M? không: 9M > 5,76M nhưng thử cả mẫu 4M
    expect(night.acc).toBe(0);
    const small = advanceCommandPeriod(p, 4_000_000, t0 + 8 * 3_600_000); // kẹp cũ 5,76M sẽ coi là reset và cộng 4M
    expect(small).toMatchObject({ acc: 0, anomalies: 1 });
    expect(advanceCommandPeriod(p, 11_000_000 + 300_000, t0 + 8 * 3_600_000).acc).toBe(300_000); // tăng thật ≤ 360k vẫn cộng
  });

  it('tin nhắn tiếng Việt có tài nguyên, %, số/trần, mức, gợi ý; mức ok không có gợi ý', () => {
    const m = formatQuotaMessage({ id: 'neon_storage', used: 450 * 1048576, cap: 512 * 1048576, pct: 87.9, level: 'warning' }, 'up');
    expect(m).toContain('CẢNH BÁO');
    expect(m).toContain('87.9%');
    expect(m).toContain('450.0 MB / 512.0 MB');
    expect(m).toContain('warning');
    expect(m).toContain('Gợi ý');
    const ok = formatQuotaMessage({ id: 'upstash_commands', used: 100, cap: 500000, pct: 0.02, level: 'ok' }, 'down');
    expect(ok).toContain('ĐÃ HẠ');
    expect(ok).not.toContain('Gợi ý');
    expect(formatQuotaMessage({ id: 'upstash_commands', used: 1, cap: 2, pct: 96, level: 'critical' }, 'repeat')).toContain('nhắc lại');
  });

  it('scrub token bot khỏi chuỗi lỗi', () => {
    expect(scrubTelegramToken('fail https://api.telegram.org/bot123456:ABC-def_ghi/sendMessage')).not.toContain('ABC-def_ghi');
    expect(scrubTelegramToken('x SECRETTOKEN123 y', 'SECRETTOKEN123')).toBe('x *** y');
  });
});
