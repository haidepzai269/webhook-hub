/**
 * LOG-CAUSE số 7 (ADR-263): cảnh báo VẬN HÀNH khi Neon/Upstash gần trần gói free (nhà cung cấp không tự cảnh báo).
 * Hàm THUẦN — job trong hub-worker gọi. Không chạm Redis/DB/mạng ở đây.
 *
 * Mức: ok -> warning (>= QUOTA_WARN_PCT, mặc định 80) -> critical (>= QUOTA_CRIT_PCT, mặc định 95).
 * Chống spam: chỉ báo khi ĐỔI mức (lên hoặc xuống) hoặc nhắc lại thưa (QUOTA_REPEAT_MS, mặc định 24h); hạ mức có
 * độ trễ 2 điểm % để số dao động quanh ngưỡng không báo liên tục.
 */
export type QuotaLevel = 'ok' | 'warning' | 'critical';
export type QuotaResourceId = 'neon_storage' | 'upstash_commands' | 'upstash_memory';

export const QUOTA_HYSTERESIS_PCT = 2;
/** Số theo docs/DEPLOYMENT.md §5.2 (Upstash free, kiểm 10/10/2026): 500.000 lệnh/tháng. */
export const DEFAULT_UPSTASH_COMMANDS_PER_MONTH = 500_000;
/**
 * Mặc định 200 lệnh/giây: hub free-tier thật chạy ~vài lệnh/giây (ngân sách R1 ≤ 8 lệnh/sự kiện, quota 500k/tháng ≈ 0,2/giây
 * trung bình); 200/s dư >100 lần cho đỉnh thật mà vẫn chặn số nhảy hàng triệu giữa hai lần INFO (đọc nhầm node/tenant).
 */
export const DEFAULT_UPSTASH_MAX_CMD_PER_SEC = 200;
export const DEFAULT_QUOTA_WARN_PCT = 80;
export const DEFAULT_QUOTA_CRIT_PCT = 95;
export const DEFAULT_QUOTA_INTERVAL_MS = 15 * 60_000;
export const DEFAULT_QUOTA_REPEAT_MS = 24 * 3_600_000;

export interface QuotaConfig {
  warnPct: number;
  critPct: number;
  intervalMs: number;
  repeatMs: number;
  /** Trần byte ổ Postgres (Neon). Mặc định DB_DISK_BUDGET_MB (512MB) — cùng con số với chốt toàn cục hub.storage_near_full. */
  neonStorageBytes: number;
  upstashCommandsPerMonth: number;
  /** Docs chưa ghi dung lượng Upstash free -> không đặt thì KHÔNG đo dung lượng (cần Admin xác nhận). */
  upstashMemoryBytes: number | null;
  /** Trần tốc độ hợp lý của bộ đếm lệnh (lệnh/giây) — kẹp delta giữa hai lần INFO. */
  upstashMaxCmdPerSec: number;
}

function num(v: string | undefined): number | null {
  if (v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function resolveQuotaConfig(env: Record<string, string | undefined> = process.env): QuotaConfig {
  let warnPct = Math.min(99, num(env.QUOTA_WARN_PCT) ?? DEFAULT_QUOTA_WARN_PCT);
  let critPct = Math.min(100, num(env.QUOTA_CRIT_PCT) ?? DEFAULT_QUOTA_CRIT_PCT);
  if (critPct <= warnPct) {
    warnPct = DEFAULT_QUOTA_WARN_PCT;
    critPct = DEFAULT_QUOTA_CRIT_PCT;
  }
  const budgetMb = num(env.DB_DISK_BUDGET_MB) ?? 512;
  return {
    warnPct,
    critPct,
    intervalMs: Math.min(3_600_000, Math.max(60_000, num(env.QUOTA_CHECK_INTERVAL_MS) ?? DEFAULT_QUOTA_INTERVAL_MS)),
    repeatMs: Math.max(3_600_000, num(env.QUOTA_REPEAT_MS) ?? DEFAULT_QUOTA_REPEAT_MS),
    neonStorageBytes: num(env.QUOTA_NEON_STORAGE_BYTES) ?? budgetMb * 1024 * 1024,
    upstashCommandsPerMonth: num(env.QUOTA_UPSTASH_COMMANDS_PER_MONTH) ?? DEFAULT_UPSTASH_COMMANDS_PER_MONTH,
    upstashMemoryBytes: num(env.QUOTA_UPSTASH_MEMORY_BYTES),
    upstashMaxCmdPerSec: num(env.QUOTA_UPSTASH_MAX_CMD_PER_SEC) ?? DEFAULT_UPSTASH_MAX_CMD_PER_SEC,
  };
}

export function quotaPct(used: number, cap: number): number {
  if (!Number.isFinite(used) || !Number.isFinite(cap) || cap <= 0 || used < 0) return 0;
  return (used / cap) * 100;
}

/** Mức theo %, có độ trễ khi hạ: đang ở mức cao thì chỉ hạ khi % < ngưỡng − 2 điểm. */
export function quotaLevelFor(pct: number, prev: QuotaLevel, cfg: Pick<QuotaConfig, 'warnPct' | 'critPct'>): QuotaLevel {
  const raw: QuotaLevel = pct >= cfg.critPct ? 'critical' : pct >= cfg.warnPct ? 'warning' : 'ok';
  if (prev === 'critical' && raw !== 'critical' && pct >= cfg.critPct - QUOTA_HYSTERESIS_PCT) return 'critical';
  if (prev !== 'ok' && raw === 'ok' && pct >= cfg.warnPct - QUOTA_HYSTERESIS_PCT) return 'warning';
  return raw;
}

export interface QuotaNotifyRecord {
  level: QuotaLevel;
  /** epoch ms của lần báo gần nhất. */
  notifiedAt: number;
}

export type QuotaNotifyKind = 'up' | 'down' | 'repeat';

/** Có nên gửi tin không? Chưa có bản ghi = coi như đang `ok` (khởi động lại mà vẫn ok thì không báo gì). */
export function decideNotify(
  prev: QuotaNotifyRecord | undefined,
  level: QuotaLevel,
  now: number,
  repeatMs: number,
): QuotaNotifyKind | null {
  const prevLevel: QuotaLevel = prev?.level ?? 'ok';
  if (level !== prevLevel) return RANK[level] > RANK[prevLevel] ? 'up' : 'down';
  if (level !== 'ok' && prev && now - prev.notifiedAt >= repeatMs) return 'repeat';
  return null;
}
const RANK: Record<QuotaLevel, number> = { ok: 0, warning: 1, critical: 2 };

// ---------------------------------------------------------------- Upstash: đếm lệnh từ INFO
/** Trạng thái cộng dồn lệnh trong kỳ (tháng UTC). Sống trong key Redis TTL dài cùng trạng thái báo. */
export interface CommandPeriod {
  period: string;
  /** `total_commands_processed` ở lần đo trước (null = chưa có mốc). */
  last: number | null;
  /** epoch ms của lần đo trước (để kẹp delta theo thời gian trôi). */
  at?: number;
  /** Lệnh đã cộng dồn trong kỳ kể từ lần đầu quan sát. */
  acc: number;
  /** Số mẫu INFO bất thường (đếm giảm quá mức kẹp hoặc tăng quá mức kẹp) đã bỏ trong kỳ. */
  anomalies?: number;
}

export function periodOf(now: number): string {
  return new Date(now).toISOString().slice(0, 7);
}

/** Lấy một số nguyên từ văn bản `INFO` ("key:value" mỗi dòng). Không có -> null. */
export function parseInfoNumber(info: string, key: string): number | null {
  const m = new RegExp(`^${key}:(\\d+)\\s*$`, 'm').exec(info);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

/**
 * Cộng dồn có kẹp: cap = giây trôi × `maxPerSec`.
 *  - tăng ≤ cap: cộng delta; tăng > cap: BỎ mẫu (không cộng), đặt lại mốc, đếm bất thường;
 *  - giảm và `cur` ≤ cap: coi là server reset, cộng `cur`; giảm mà `cur` > cap: BỎ mẫu (hai lần INFO rơi vào hai bộ đếm lệch
 *    nhau — đa node/tenant), đặt lại mốc, đếm bất thường. Dao động 11M↔9M vì thế không làm `acc` phồng.
 *  - sang tháng mới / lần đầu: chỉ đặt mốc (lệnh dùng trước đó trong kỳ không biết).
 */
export function advanceCommandPeriod(prev: CommandPeriod | undefined, cur: number, now: number, maxPerSec = DEFAULT_UPSTASH_MAX_CMD_PER_SEC): CommandPeriod {
  const period = periodOf(now);
  if (!prev || prev.period !== period) return { period, last: cur, at: now, acc: 0, anomalies: 0 };
  const anomalies = prev.anomalies ?? 0;
  if (prev.last === null) return { period, last: cur, at: now, acc: prev.acc, anomalies };
  const elapsedSec = Math.max(1, (now - (prev.at ?? now)) / 1000);
  const cap = elapsedSec * maxPerSec;
  let delta = 0;
  let bad = false;
  if (cur >= prev.last) {
    delta = cur - prev.last;
    if (delta > cap) {
      bad = true;
      delta = 0;
    }
  } else if (cur <= cap) delta = cur;
  else bad = true;
  return { period, last: cur, at: now, acc: prev.acc + delta, anomalies: anomalies + (bad ? 1 : 0) };
}

// ---------------------------------------------------------------- Thông điệp
export interface QuotaReading {
  id: QuotaResourceId;
  used: number;
  cap: number;
  pct: number;
  level: QuotaLevel;
}

const LABEL: Record<QuotaResourceId, string> = {
  neon_storage: 'Neon - dung lượng Postgres',
  upstash_commands: 'Upstash - số lệnh Redis trong tháng',
  upstash_memory: 'Upstash - dung lượng Redis',
};

const HINT: Record<QuotaResourceId, string> = {
  neon_storage: 'Mở console, trang Dung lượng: dọn dữ liệu cũ (hạ TRAFFIC_RETENTION_DAYS, bật dọn tự động) hoặc nâng gói Neon.',
  upstash_commands: 'Giảm tải: tắt bớt đích/đích chết, kiểm tra vòng retry, giãn các tick nền; hoặc nâng gói Upstash. Hết hạn mức Upstash dừng cả ingest.',
  upstash_memory: 'Xoá key không cần thiết (DBSIZE/SCAN), kiểm tra TTL các key idempotency; hoặc nâng gói Upstash.',
};

function fmtValue(id: QuotaResourceId, v: number): string {
  if (id === 'upstash_commands') return `${Math.round(v).toLocaleString('en-US')} lệnh`;
  return `${(v / 1024 / 1024).toFixed(1)} MB`;
}

const ICON: Record<QuotaLevel, string> = { ok: 'ĐÃ HẠ', warning: 'CẢNH BÁO', critical: 'NGHIÊM TRỌNG' };

/** Văn bản thuần (không parse_mode — ADR-042). Không chứa bí mật. */
export function formatQuotaMessage(r: QuotaReading, kind: QuotaNotifyKind, extra?: { note?: string }): string {
  const head =
    r.level === 'ok'
      ? `[Webhook Hub] ${ICON.ok} - ${LABEL[r.id]} đã xuống mức bình thường`
      : `[Webhook Hub] ${ICON[r.level]} - ${LABEL[r.id]}${kind === 'repeat' ? ' (nhắc lại)' : ''}`;
  const lines = [head, `Đã dùng: ${r.pct.toFixed(1)}% (${fmtValue(r.id, r.used)} / ${fmtValue(r.id, r.cap)})`];
  if (r.level !== 'ok') lines.push(`Mức: ${r.level === 'critical' ? 'critical' : 'warning'}`, `Gợi ý: ${HINT[r.id]}`);
  if (extra?.note) lines.push(`Lưu ý: ${extra.note}`);
  return lines.join('\n');
}

export const UPSTASH_COUNTER_NOTE = 'Số lệnh là ước lượng cộng dồn từ INFO total_commands_processed kể từ lần đo đầu của tháng, có thể thấp hơn thật.';

/** Xoá token bot khỏi một chuỗi lỗi bất kỳ (URL `/bot<id>:<secret>/`, hoặc chính giá trị token). */
export function scrubTelegramToken(s: string, token?: string): string {
  let out = s.replace(/bot\d+:[A-Za-z0-9_-]+/g, 'bot***');
  if (token && token.length >= 8) out = out.split(token).join('***');
  return out;
}
