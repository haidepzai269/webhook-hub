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
 *
 * Đính chính sau review (ADR-177 bổ sung):
 * - "Cặp tốt": (ip, sourceKey) đã verify ĐÚNG (và qua rate limit) trong `goodTtlMs` gần nhất. Luật (a) KHÔNG chặn cặp tốt
 *   (flood 404 vào IP chung của GitHub không cắt được source đang chạy của tenant khác); luật (b) với cặp tốt dùng ngưỡng
 *   × `good401Multiplier` (mặc định ×10) — không miễn vô hạn.
 * - Cache tốt CHIA THEO sourceKey: mỗi key một LRU nhỏ (`goodIpsPerKey`, mặc định 16) -> một key không đẩy được cặp của key
 *   khác. Mỗi tenant tối đa `goodKeysPerTenant` key (LRU theo tenant -> một tenant chỉ đẩy được key của chính nó). Bảng
 *   ngoài có trần `maxGoodKeys` (10k) và trần TỔNG số mục `goodMaxEntries` (100k ≈ 11MB); vượt thì loại key hoạt động cũ nhất.
 * - Ban hết hạn được quét ở đầu Map `banned` (banMs cố định -> thứ tự chèn = thứ tự hết hạn); `banned` có trần riêng
 *   (≤ 50% `maxEntries`) — đầy thì không tạo ban mới (fail-open, có log + metric); khoá vừa chèn không bao giờ bị loại.
 * - IP loopback/private/dùng chung (127/8, 10/8, 172.16/12, 192.168/16, 169.254/16, 100.64/10, ::1, fc00::/7, fe80::/10,
 *   IPv4-mapped của chúng) không chấm điểm, không
 *   chặn — sau NAT/proxy chưa cấu hình, mọi người trông như một IP. `EDGE_PENALTY_ENABLED=0` tắt hẳn hộp phạt.
 */
export type PenaltyReason = 'unknown_source' | 'bad_signature';

export interface PenaltyConfig {
  threshold404: number;
  threshold401: number;
  banMs: number;
  maxEntries: number;
  windowMs: number;
  /** Mặc định true. `EDGE_PENALTY_ENABLED=0` -> không chấm điểm, không chặn. */
  enabled?: boolean;
  /** Thời gian nhớ một cặp (ip, sourceKey) đã verify đúng. Mặc định 24h. */
  goodTtlMs?: number;
  /** Trần số ban đồng thời. Mặc định 50% `maxEntries`. */
  maxBanned?: number;
  /** Trần số sourceKey trong cache tốt (LRU theo hoạt động). Mặc định 10.000. */
  maxGoodKeys?: number;
  /** Trần số IP tốt mỗi sourceKey (LRU riêng). Mặc định 16. */
  goodIpsPerKey?: number;
  /** Trần TỔNG số cặp tốt (mọi key). Mặc định 100.000 (≈ 11MB). */
  goodMaxEntries?: number;
  /** Trần số key tốt của MỘT tenant (LRU theo tenant). Mặc định 64. */
  goodKeysPerTenant?: number;
  /** Ngưỡng luật (b) với cặp tốt = threshold401 × hệ số này. Mặc định 10. */
  good401Multiplier?: number;
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
  /** Đủ ngưỡng nhưng `banned` đã đầy -> KHÔNG phạt (fail-open có tiếng). */
  onBanSkipped?(reason: PenaltyReason, cause: 'capacity'): void;
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
    enabled: env.EDGE_PENALTY_ENABLED !== '0',
    goodTtlMs: clampEnvInt(env.EDGE_PENALTY_GOOD_TTL, 86_400, 300, 7 * 86_400) * 1000,
    goodIpsPerKey: clampEnvInt(env.EDGE_PENALTY_GOOD_IPS_PER_KEY, 16, 4, 1_024),
    maxGoodKeys: clampEnvInt(env.EDGE_PENALTY_GOOD_MAX_KEYS, 10_000, 100, 1_000_000),
    goodMaxEntries: clampEnvInt(env.EDGE_PENALTY_GOOD_MAX_ENTRIES, 100_000, 2_000, 2_000_000),
    goodKeysPerTenant: clampEnvInt(env.EDGE_PENALTY_GOOD_KEYS_PER_TENANT, 64, 1, 10_000),
    good401Multiplier: clampEnvInt(env.EDGE_PENALTY_401_GOOD_MULTIPLIER, 10, 2, 100),
  };
}

/**
 * Khoá IP: IPv4 (kể cả dạng `::ffff:a.b.c.d`) giữ nguyên địa chỉ; IPv6 gộp theo prefix /64 (một máy có cả dải /64).
 * Chuỗi không phải IP -> null (không chấm điểm, không chặn).
 */
export function ipKey(ip: string | undefined | null): string | null {
  const p = parseIp(ip);
  if (!p) return null;
  if (p.v4) return p.v4;
  return `${p.groups.slice(0, 4).map((n) => n.toString(16)).join(':')}::/64`;
}

/** IPv4 (kể cả IPv4-mapped `::ffff:a.b.c.d` / `::ffff:7f00:1`) -> `v4`; IPv6 -> 8 nhóm số. */
function parseIp(ip: string | undefined | null): { v4: string; groups?: undefined } | { v4?: undefined; groups: number[] } | null {
  if (!ip) return null;
  const s = ip.trim();
  const kind = isIP(s);
  if (kind === 4) return { v4: s };
  if (kind !== 6) return null;
  const raw = expandIpv6(s.split('%')[0]);
  if (!raw) return null;
  const groups = raw.map((g) => parseInt(g, 16));
  if (groups.some((n) => !Number.isFinite(n))) return null;
  if (groups.slice(0, 5).every((n) => n === 0) && groups[5] === 0xffff) {
    return { v4: [groups[6] >> 8, groups[6] & 255, groups[7] >> 8, groups[7] & 255].join('.') };
  }
  return { groups };
}

/**
 * Loopback / mạng riêng: 127/8, 10/8, 172.16/12, 192.168/16, ::1, fc00::/7 (và IPv4-mapped của chúng). Sau NAT của Docker,
 * cloudflared hay một proxy chưa được tin (`TRUST_PROXY=0`), mọi request mang cùng địa chỉ kiểu này -> phạt nó là chặn tất cả.
 */
export function isLocalOrPrivateIp(ip: string | undefined | null): boolean {
  const p = parseIp(ip);
  if (!p) return false;
  if (p.v4) {
    const [a, b] = p.v4.split('.').map(Number);
    return (
      a === 127 ||
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) || // link-local
      (a === 100 && b >= 64 && b <= 127) // CGNAT 100.64/10 — nhiều thuê bao chung một IP
    );
  }
  const g = p.groups;
  if (g.slice(0, 7).every((n) => n === 0) && g[7] === 1) return true; // ::1
  if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  return (g[0] & 0xfe00) === 0xfc00; // fc00::/7
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

interface GoodKey {
  tenantId: string;
  ips: Map<string, number>;
  /** Hạn của lần markGood gần nhất (TTL cố định -> hạn muộn nhất của key). */
  lastExp: number;
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
  /** Khoá đang bị phạt — thứ tự chèn = thứ tự hết hạn (banMs cố định). */
  private readonly banned = new Map<string, Ban>();
  /** Cặp tốt: sourceKey -> (ipKey -> hết hạn lúc). Cả hai tầng là LRU (Map: chạm = xoá rồi chèn lại). */
  private readonly good = new Map<string, GoodKey>();
  /** tenantId -> các sourceKey tốt của tenant đó (LRU theo hoạt động). */
  private readonly tenantKeys = new Map<string, Set<string>>();
  private goodEntries = 0;
  private readonly goodMaxEntries: number;
  private readonly goodKeysPerTenant: number;
  private readonly maxBanned: number;
  private readonly maxGoodKeys: number;
  private readonly goodIpsPerKey: number;
  private readonly good401Multiplier: number;
  private readonly goodTtlMs: number;
  private readonly enabled: boolean;

  constructor(
    private readonly cfg: PenaltyConfig = resolvePenaltyConfig(),
    private readonly hooks: PenaltyHooks = {},
    private readonly clock: () => number = Date.now,
  ) {
    this.enabled = cfg.enabled !== false;
    this.maxBanned = Math.max(1, cfg.maxBanned ?? Math.floor(cfg.maxEntries / 2));
    this.maxGoodKeys = Math.max(1, cfg.maxGoodKeys ?? 10_000);
    this.goodIpsPerKey = Math.max(1, cfg.goodIpsPerKey ?? 16);
    this.goodMaxEntries = Math.max(this.goodIpsPerKey, cfg.goodMaxEntries ?? 100_000);
    this.goodKeysPerTenant = Math.max(1, cfg.goodKeysPerTenant ?? 64);
    this.good401Multiplier = Math.max(1, cfg.good401Multiplier ?? 10);
    this.goodTtlMs = cfg.goodTtlMs ?? 86_400_000;
  }

  /** Số khoá đang đếm + đang phạt (gauge `hub_ingest_penalty_entries`). */
  size(): number {
    return this.counting.size + this.banned.size;
  }

  /** Số ban đang giữ (kể cả đã hết hạn nhưng chưa quét). */
  bannedSize(): number {
    return this.banned.size;
  }

  /** Tổng số cặp tốt đang nhớ. */
  goodSize(): number {
    return this.goodEntries;
  }

  goodKeyCount(): number {
    return this.good.size;
  }

  /**
   * Luật (a): IP đang bị chặn mọi `/hooks/*`? Kiểm TRƯỚC khi nạp source. Cặp (ip, sourceKey) đã verify đúng gần đây thì
   * vẫn được đi tiếp — chỉ key lạ / chưa từng verify từ IP đó mới bị 429.
   */
  checkIp(ip: string | undefined, sourceKey?: string): PenaltyVerdict {
    const k = this.keyOf(ip);
    if (!k) return { blocked: false };
    const v = this.verdict(`ip|${k}`, false);
    if (!v.blocked) return v;
    if (sourceKey !== undefined && this.isGood(k, sourceKey)) return { blocked: false };
    this.safeHook(() => this.hooks.onBlocked?.(v.reason));
    return v;
  }

  /** Luật (b): cặp (ip, sourceKey) đang bị chặn? */
  checkPair(ip: string | undefined, sourceKey: string): PenaltyVerdict {
    const k = this.keyOf(ip);
    if (!k) return { blocked: false };
    const v = this.verdict(pairKey(k, sourceKey), false);
    if (v.blocked) this.safeHook(() => this.hooks.onBlocked?.(v.reason));
    return v;
  }

  /**
   * Chữ ký ĐÚNG và đã qua rate limit -> nhớ cặp tốt `goodTtlMs`. Ba lớp trần: ≤ `goodIpsPerKey` IP mỗi key (key này không đẩy
   * được key khác), ≤ `goodKeysPerTenant` key mỗi tenant (tenant này không đẩy được tenant khác), và trần tổng
   * `maxGoodKeys` / `goodMaxEntries` (loại key hoạt động cũ nhất).
   */
  markGood(ip: string | undefined, sourceKey: string, tenantId: string): void {
    const k = this.keyOf(ip);
    if (!k) return;
    const now = this.clock();
    this.sweepExpiredGood(now);
    let e = this.good.get(sourceKey);
    if (e) this.good.delete(sourceKey); // chạm key -> cuối (hoạt động mới nhất)
    else e = { tenantId, ips: new Map(), lastExp: 0 };
    this.good.set(sourceKey, e);
    let tk = this.tenantKeys.get(e.tenantId);
    if (!tk) {
      tk = new Set();
      this.tenantKeys.set(e.tenantId, tk);
    }
    tk.delete(sourceKey);
    tk.add(sourceKey);
    if (e.ips.delete(k)) this.goodEntries--;
    const exp = now + this.goodTtlMs;
    e.ips.set(k, exp);
    e.lastExp = exp;
    this.goodEntries++;
    while (e.ips.size > this.goodIpsPerKey) {
      e.ips.delete(e.ips.keys().next().value as string);
      this.goodEntries--;
    }
    while (tk.size > this.goodKeysPerTenant) this.removeGoodKey(tk.values().next().value as string);
    while (this.good.size > this.maxGoodKeys || this.goodEntries > this.goodMaxEntries) {
      const oldest = this.good.keys().next().value as string;
      if (oldest === sourceKey) break; // không bao giờ loại key vừa chạm (goodMaxEntries ≥ goodIpsPerKey)
      this.removeGoodKey(oldest);
    }
  }

  /** 404 do không tìm thấy source. */
  recordUnknownSource(ip: string | undefined): void {
    const k = this.keyOf(ip);
    if (k) this.hit(`ip|${k}`, k, 'unknown_source', this.cfg.threshold404);
  }

  /** 401 do sai chữ ký trên một source có thật. Cặp tốt: chỉ đếm, không ban. */
  recordBadSignature(ip: string | undefined, sourceKey: string, owner: BanOwner): void {
    const k = this.keyOf(ip);
    if (!k) return;
    // Cặp tốt: ngưỡng × hệ số (GitHub dùng chung IP, đúng/sai xen kẽ không bị ban oan) — nhưng không miễn vô hạn.
    const threshold = this.isGood(k, sourceKey) ? this.cfg.threshold401 * this.good401Multiplier : this.cfg.threshold401;
    this.hit(pairKey(k, sourceKey), k, 'bad_signature', threshold, owner, sourceKey);
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

  /** Tắt / IP không hợp lệ / loopback-private -> null (không chấm điểm, không chặn). */
  private keyOf(ip: string | undefined): string | null {
    if (!this.enabled) return null;
    if (isLocalOrPrivateIp(ip)) return null; // metric `skipped_private` đếm MỘT lần mỗi request ở ingest
    return ipKey(ip);
  }

  private isGood(ip: string, sourceKey: string): boolean {
    const e = this.good.get(sourceKey);
    const until = e?.ips.get(ip);
    if (until === undefined) return false;
    if (until <= this.clock()) {
      e!.ips.delete(ip);
      this.goodEntries--;
      if (e!.ips.size === 0) this.removeGoodKey(sourceKey);
      return false;
    }
    return true;
  }

  private removeGoodKey(sourceKey: string): void {
    const e = this.good.get(sourceKey);
    if (!e) return;
    this.goodEntries -= e.ips.size;
    this.good.delete(sourceKey);
    const tk = this.tenantKeys.get(e.tenantId);
    if (tk) {
      tk.delete(sourceKey);
      if (tk.size === 0) this.tenantKeys.delete(e.tenantId);
    }
  }

  /** Key ở đầu bảng là key hoạt động cũ nhất; `lastExp` = hạn muộn nhất của nó -> hết hạn thì cả key hết hạn. O(1) khấu hao. */
  private sweepExpiredGood(now: number): void {
    for (const [key, e] of this.good) {
      if (e.lastExp > now) break;
      this.removeGoodKey(key);
    }
  }

  private verdict(key: string, notify = true): PenaltyVerdict {
    const ban = this.banned.get(key);
    if (!ban) return { blocked: false };
    const now = this.clock();
    if (ban.until <= now) {
      this.banned.delete(key);
      return { blocked: false };
    }
    if (notify) this.safeHook(() => this.hooks.onBlocked?.(ban.reason));
    return { blocked: true, reason: ban.reason, retryAfterSec: Math.max(1, Math.ceil((ban.until - now) / 1000)), owner: ban.owner };
  }

  private hit(key: string, ip: string, reason: PenaltyReason, threshold: number, owner?: BanOwner, sourceKey?: string): void {
    const now = this.clock();
    this.sweepExpiredBans(now);
    const ban = this.banned.get(key);
    if (ban && ban.until > now) return; // đang phạt: không đếm thêm
    if (ban) this.banned.delete(key);
    let c = this.counting.get(key);
    if (c) this.counting.delete(key); // chạm -> đưa về cuối (LRU)
    if (!c || now - c.windowStart >= this.cfg.windowMs) c = { count: 0, windowStart: now };
    c.count++;
    let banned = false;
    if (c.count >= threshold) {
      if (this.banned.size >= this.maxBanned) {
        this.safeHook(() => this.hooks.onBanSkipped?.(reason, 'capacity'));
        c = { count: 0, windowStart: now };
      } else {
        this.banned.set(key, { reason, until: now + this.cfg.banMs, ip, owner });
        banned = true;
        this.safeHook(() => this.hooks.onBan?.(reason, ip, sourceKey, Math.round(this.cfg.banMs / 1000)));
      }
    }
    if (!banned) this.counting.set(key, c);
    this.evict(key);
  }

  /** Ban hết hạn nằm ở đầu Map (banMs cố định) — dừng ở ban đầu tiên còn hiệu lực: O(1) khấu hao. */
  private sweepExpiredBans(now: number): void {
    for (const [k, b] of this.banned) {
      if (b.until > now) break;
      this.banned.delete(k);
    }
  }

  /** Loại theo LRU, Map "đang đếm" trước; KHÔNG BAO GIỜ loại khoá vừa chèn (`keep`). */
  private evict(keep: string): void {
    while (this.size() > this.cfg.maxEntries) {
      const victim = firstKeyExcept(this.counting, keep) ?? firstKeyExcept(this.banned, keep);
      if (victim === undefined) return;
      if (!this.counting.delete(victim)) this.banned.delete(victim);
    }
  }

  private safeHook(fn: () => void): void {
    try {
      fn();
    } catch {
      /* metric/log không bao giờ lật kết luận của hộp phạt */
    }
  }
}

function firstKeyExcept(m: Map<string, unknown>, keep: string): string | undefined {
  for (const k of m.keys()) if (k !== keep) return k;
  return undefined;
}

function pairKey(ip: string, sourceKey: string): string {
  return `pair|${ip}|${sourceKey}`;
}

/** Hook mặc định: log `warn` một lần khi bắt đầu phạt (không log mỗi request bị chặn). */
export function logBan(reason: PenaltyReason, ip: string, sourceKey: string | undefined, banSeconds: number): void {
  logger.warn({ reason, ip, sourceKey, banSeconds }, 'Hộp phạt: bắt đầu tạm chặn');
}
