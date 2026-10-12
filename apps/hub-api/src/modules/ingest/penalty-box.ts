import { isIP } from 'net';
import { logger } from '@hub/common';

/**
 * EG2 (SPEC-chong-qua-tai §4, ADR-177): hộp phạt IP của `/hooks/*`, TRONG BỘ NHỚ của instance hub-api.
 *
 * - 0 lệnh Redis, 0 truy vấn DB (R1 không đổi). Mỗi instance có trạng thái riêng -> ngưỡng thực tế nhân theo số instance.
 * - Luật (a): 404 do KHÔNG tìm thấy source (`source == null`) — khoá `ip`, ≥ ngưỡng trong 60s -> chặn MỌI `/hooks/*` từ IP đó.
 *   404 do source tắt/đã lưu trữ KHÔNG tính điểm (provider thật vẫn gửi vào source đã "Xoá", ADR-161).
 * - Luật (b): 401 sai chữ ký — khoá `(ip, sourceKey)`, ≥ ngưỡng trong 60s -> chặn CHỈ cặp đó (tenant khác dùng chung IP
 *   GitHub/PayOS không bị vạ lây). Khoá phạt nhớ `tenantId`/`sourceId` để lưu lượng (EG4) ghi `BLOCKED` và EG5 hiển thị.
 * - Không có `if (provider === …)`: luật chỉ nhìn IP, `sourceKey` và kết quả (404/401) của lõi.
 * - Bộ nhớ có trần: tối đa `maxEntries` khoá, loại theo LRU, khoá ĐANG bị phạt được giữ lâu hơn khoá chỉ đang đếm
 *   (hai Map tách riêng, loại ở Map "đang đếm" trước) -> nhiều IP chỉ làm hộp đầy, không làm cạn RAM.
 * - Ai gọi hộp phạt phải nuốt lỗi (fail-open) — xem `IngestService`.
 */
export type PenaltyReason = 'unknown_source' | 'bad_signature';

export interface PenaltyConfig {
  threshold404: number;
  threshold401: number;
  banMs: number;
  maxEntries: number;
  windowMs: number;
}

export interface BanOwner {
  tenantId: string;
  sourceId: string;
}

export type PenaltyVerdict =
  | { blocked: false }
  | { blocked: true; reason: PenaltyReason; retryAfterSec: number; owner?: BanOwner };

export interface PenaltyHooks {
  /** Bắt đầu một lần phạt (log `warn` MỘT lần + metric). */
  onBan?(reason: PenaltyReason, ip: string, sourceKey: string | undefined, banSeconds: number): void;
  /** Request bị chặn vì đang bị phạt. */
  onBlocked?(reason: PenaltyReason): void;
}

const WINDOW_MS = 60_000;

/** Kẹp giá trị env vào khoảng hợp lý — giống `resolveSendTimeoutMs`: rỗng/không phải số -> mặc định. */
export function clampEnvInt(v: string | undefined, def: number, min: number, max: number): number {
  const n = v === undefined || v === '' ? NaN : Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.round(n)));
}

export function resolvePenaltyConfig(env: Record<string, string | undefined> = process.env): PenaltyConfig {
  return {
    threshold404: clampEnvInt(env.EDGE_PENALTY_404_THRESHOLD, 20, 5, 1_000),
    threshold401: clampEnvInt(env.EDGE_PENALTY_401_THRESHOLD, 30, 5, 1_000),
    banMs: clampEnvInt(env.EDGE_PENALTY_BAN_SECONDS, 600, 30, 86_400) * 1000,
    maxEntries: clampEnvInt(env.EDGE_PENALTY_MAX_ENTRIES, 50_000, 1_000, 1_000_000),
    windowMs: WINDOW_MS,
  };
}

/**
 * Khoá IP: IPv4 (kể cả dạng `::ffff:a.b.c.d`) giữ nguyên địa chỉ; IPv6 gộp theo prefix /64 (một máy có cả dải /64).
 * Chuỗi không phải IP -> null (không chấm điểm, không chặn).
 */
export function ipKey(ip: string | undefined | null): string | null {
  if (!ip) return null;
  const s = ip.trim();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(s);
  if (mapped) return mapped[1];
  const kind = isIP(s);
  if (kind === 4) return s;
  if (kind !== 6) return null;
  const groups = expandIpv6(s.split('%')[0]);
  if (!groups) return null;
  return `${groups.slice(0, 4).map((g) => parseInt(g, 16).toString(16)).join(':')}::/64`;
}

function expandIpv6(s: string): string[] | null {
  let addr = s;
  // đuôi IPv4 nhúng (vd ::1.2.3.4) -> hai nhóm hex
  const v4 = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(addr);
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number);
    addr = addr.slice(0, v4.index) + ((a << 8) | b).toString(16) + ':' + ((c << 8) | d).toString(16);
  }
  const halves = addr.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0) return null;
  const out = [...head, ...Array(fill).fill('0'), ...tail];
  return out.length === 8 ? out : null;
}

interface Counting {
  count: number;
  windowStart: number;
}

interface Ban {
  reason: PenaltyReason;
  until: number;
  ip: string;
  owner?: BanOwner;
}

export class PenaltyBox {
  /** Khoá chỉ đang đếm — Map giữ thứ tự chèn = LRU (chạm thì xoá rồi chèn lại). */
  private readonly counting = new Map<string, Counting>();
  /** Khoá đang bị phạt — chỉ bị loại khi `counting` đã rỗng. */
  private readonly banned = new Map<string, Ban>();

  constructor(
    private readonly cfg: PenaltyConfig = resolvePenaltyConfig(),
    private readonly hooks: PenaltyHooks = {},
    private readonly clock: () => number = Date.now,
  ) {}

  /** Số khoá đang giữ (gauge `hub_ingest_penalty_entries`). */
  size(): number {
    return this.counting.size + this.banned.size;
  }

  /** Luật (a): IP đang bị chặn mọi `/hooks/*`? Kiểm TRƯỚC khi nạp source. */
  checkIp(ip: string | undefined): PenaltyVerdict {
    const k = ipKey(ip);
    return k ? this.verdict(`ip|${k}`) : { blocked: false };
  }

  /** Luật (b): cặp (ip, sourceKey) đang bị chặn? */
  checkPair(ip: string | undefined, sourceKey: string): PenaltyVerdict {
    const k = ipKey(ip);
    return k ? this.verdict(pairKey(k, sourceKey)) : { blocked: false };
  }

  /** 404 do không tìm thấy source. */
  recordUnknownSource(ip: string | undefined): void {
    const k = ipKey(ip);
    if (k) this.hit(`ip|${k}`, k, 'unknown_source', this.cfg.threshold404);
  }

  /** 401 do sai chữ ký trên một source có thật. */
  recordBadSignature(ip: string | undefined, sourceKey: string, owner: BanOwner): void {
    const k = ipKey(ip);
    if (k) this.hit(pairKey(k, sourceKey), k, 'bad_signature', this.cfg.threshold401, owner, sourceKey);
  }

  /** EG5: các IP đang bị chặn theo cặp trên một source (ước lượng — chỉ của instance này). */
  activeBansFor(sourceId: string): { ip: string; remainingSec: number }[] {
    const now = this.clock();
    const out: { ip: string; remainingSec: number }[] = [];
    for (const b of this.banned.values()) {
      if (b.owner?.sourceId === sourceId && b.until > now) out.push({ ip: b.ip, remainingSec: Math.ceil((b.until - now) / 1000) });
    }
    return out.sort((a, b) => b.remainingSec - a.remainingSec);
  }

  private verdict(key: string): PenaltyVerdict {
    const ban = this.banned.get(key);
    if (!ban) return { blocked: false };
    const now = this.clock();
    if (ban.until <= now) {
      this.banned.delete(key);
      return { blocked: false };
    }
    this.hooks.onBlocked?.(ban.reason);
    return { blocked: true, reason: ban.reason, retryAfterSec: Math.max(1, Math.ceil((ban.until - now) / 1000)), owner: ban.owner };
  }

  private hit(key: string, ip: string, reason: PenaltyReason, threshold: number, owner?: BanOwner, sourceKey?: string): void {
    const now = this.clock();
    const ban = this.banned.get(key);
    if (ban && ban.until > now) return; // đang phạt: không đếm thêm
    if (ban) this.banned.delete(key);
    let c = this.counting.get(key);
    if (c) this.counting.delete(key); // chạm -> đưa về cuối (LRU)
    if (!c || now - c.windowStart >= this.cfg.windowMs) c = { count: 0, windowStart: now };
    c.count++;
    if (c.count >= threshold) {
      this.banned.set(key, { reason, until: now + this.cfg.banMs, ip, owner });
      this.hooks.onBan?.(reason, ip, sourceKey, Math.round(this.cfg.banMs / 1000));
    } else {
      this.counting.set(key, c);
    }
    this.evict();
  }

  private evict(): void {
    while (this.size() > this.cfg.maxEntries) {
      const victims = this.counting.size > 0 ? this.counting : this.banned;
      const oldest = victims.keys().next().value as string;
      victims.delete(oldest);
    }
  }
}

function pairKey(ip: string, sourceKey: string): string {
  return `pair|${ip}|${sourceKey}`;
}

/** Hook mặc định: log `warn` một lần khi bắt đầu phạt (không log mỗi request bị chặn). */
export function logBan(reason: PenaltyReason, ip: string, sourceKey: string | undefined, banSeconds: number): void {
  logger.warn({ reason, ip, sourceKey, banSeconds }, 'Hộp phạt: bắt đầu tạm chặn');
}
