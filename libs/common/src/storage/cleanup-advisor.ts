import { createHash } from 'crypto';
import type { Importance } from './importance';
import type { StorageLevel } from './level';
import type { StoragePolicyDefault } from './policy';
import { CleanAction, StorageBucket, estimateClean, parseOlderThan } from './clean';

/**
 * QT4b (SPEC-han-muc-dung-luong §5.6, ADR-187): bộ gợi ý dọn là một INTERFACE — hôm nay `RuleAdvisor` (`rules@1`), sau này
 * `LlmAdvisor`; lõi (job đo, webhook, `apply`, hàng rào) không đổi. Cùng tư duy với `ProviderAdapter`.
 *
 *  - Advisor chỉ nhận `StorageSnapshot` — SỐ GỘP, không payload, không body (BB-1 + riêng tư).
 *  - Advisor CHỈ GỢI Ý, không bao giờ thực thi. Thực thi chỉ có: user bấm, policy user đặt, API `apply`.
 *  - Hàng rào `assertSuggestionSafe` nằm NGOÀI advisor: mọi gợi ý (kể cả của LLM sau này) qua đây trước khi lưu, phát hay
 *    áp dụng — dựng lại gợi ý từ danh sách trắng các trường, tính lại id và số byte từ `by_bucket` (không tin advisor).
 *  - Advisor lỗi / quá giờ -> fail-open về `RuleAdvisor` (`suggestWithFallback`).
 */
export interface StorageSnapshot {
  usedBytes: number;
  quotaBytes: number;
  level: StorageLevel;
  growthPerDay: number;
  buckets: StorageBucket[];
  policies: StoragePolicyDefault[];
  keepLongerSourceIds: string[];
}

/** Hình dạng gợi ý — cũng là phần tử `data.suggestions` của webhook `hub.project.cleanup_suggested` (EVENT-CATALOG §3a). */
export interface CleanupSuggestion {
  /** Hash XÁC ĐỊNH từ (advisor, importance, action, olderThan, sourceId) — không ngẫu nhiên: cùng dữ liệu -> cùng id. */
  id: string;
  action: CleanAction;
  importance: Importance[];
  /** Khoảng tương đối (`3d`) để id ổn định giữa hai lần chạy. */
  olderThan: string;
  /** null = mọi source (trừ source "Giữ lâu" — không bao giờ bị đụng). */
  sourceId: string | null;
  estimatedBytes: number;
  estimatedEvents: number;
  reasonCode: string;
  reason: string;
  advisor: string;
  expiresAt: string;
}

export interface CleanupAdvisor {
  /** `rules@1`, sau này `llm@1`. */
  readonly id: string;
  suggest(input: StorageSnapshot): Promise<CleanupSuggestion[]>;
}

export const SUGGESTION_TTL_MS = 86_400_000;
const MB = 1024 * 1024;
const fmtMb = (b: number) => `${(Math.round((b / MB) * 10) / 10).toLocaleString('vi-VN')} MB`;
const SAFE_IMPORTANCE: readonly Importance[] = ['junk', 'low', 'medium'];
const IMPORTANCE_ORDER: readonly Importance[] = ['junk', 'low', 'medium', 'high', 'keep'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ADVISOR_RE = /^[a-z0-9][a-z0-9@._-]{0,31}$/i;

/** id gợi ý = `sug_` + 24 hex đầu của sha256(advisor|importance đã sắp|action|olderThan|sourceId). */
export function suggestionId(advisor: string, importance: readonly string[], action: string, olderThan: string, sourceId: string | null): string {
  const imp = [...importance].sort((a, b) => IMPORTANCE_ORDER.indexOf(a as Importance) - IMPORTANCE_ORDER.indexOf(b as Importance)).join(',');
  return `sug_${createHash('sha256').update(`${advisor}|${imp}|${action}|${olderThan}|${sourceId ?? ''}`).digest('hex').slice(0, 24)}`;
}

/** Luật `rules@1` (bảng §5.3). Mức Cao / Giữ không có luật nào -> không bao giờ được gợi ý. */
export const RULES_V1: readonly { importance: Importance; action: CleanAction; olderThan: string; reasonCode: string; describe: (events: number, bytes: number, olderThan: string) => string }[] = [
  {
    importance: 'junk',
    action: 'delete',
    olderThan: '1d',
    reasonCode: 'rejected_samples',
    describe: (n, b) => `Xoá hẳn ${n} mẫu request bị từ chối (ký sai / không hợp lệ) cũ hơn 1 ngày → ~${fmtMb(b)}. Đây là mẫu tấn công/cấu hình sai, không phải dữ liệu của bạn.`,
  },
  {
    importance: 'low',
    action: 'trim',
    olderThan: '3d',
    reasonCode: 'delivered_old',
    describe: (n, b) =>
      `Dọn ${n} event mức Thấp (đã giao thành công tới mọi đích, hoặc chỉ còn bản gốc sau khi event hết hạn lưu) cũ hơn 3 ngày → ~${fmtMb(b)}. Giữ dòng chống trùng; mất nội dung, không replay được nữa.`,
  },
  {
    importance: 'medium',
    action: 'trim',
    olderThan: '5d',
    reasonCode: 'no_push_old',
    describe: (n, b) =>
      `Dọn ${n} event mức Trung bình (không có đích push — có thể có service đang polling) cũ hơn 5 ngày → ~${fmtMb(b)}. Giữ dòng chống trùng; service polling chậm hơn 5 ngày sẽ thấy data: null.`,
  },
];

/** `rules@1` — hàm THUẦN trên snapshot (bảng §5.3). */
export class RuleAdvisor implements CleanupAdvisor {
  readonly id = 'rules@1';
  constructor(private readonly clock: () => number = Date.now) {}

  async suggest(input: StorageSnapshot): Promise<CleanupSuggestion[]> {
    const now = this.clock();
    const out: CleanupSuggestion[] = [];
    for (const rule of RULES_V1) {
      const minAgeDays = parseOlderThan(rule.olderThan, now)!.minAgeDays;
      const est = estimateClean(input.buckets, { action: rule.action, importance: [rule.importance], minAgeDays });
      if (est.events === 0) continue;
      out.push({
        id: suggestionId(this.id, [rule.importance], rule.action, rule.olderThan, null),
        action: rule.action,
        importance: [rule.importance],
        olderThan: rule.olderThan,
        sourceId: null,
        estimatedBytes: est.bytes,
        estimatedEvents: est.events,
        reasonCode: rule.reasonCode,
        reason: rule.describe(est.events, est.bytes, rule.olderThan),
        advisor: this.id,
        expiresAt: new Date(now + SUGGESTION_TTL_MS).toISOString(),
      });
    }
    return out.sort((a, b) => b.estimatedBytes - a.estimatedBytes);
  }
}

export interface GuardContext {
  buckets: readonly StorageBucket[];
  keepLongerSourceIds: readonly string[];
  /** Cửa sổ retry (`TOTAL_RETRY_WINDOW_MS`, @hub/messaging) — libs/common không phụ thuộc messaging, người gọi truyền. */
  floorMs: number;
  now: number;
}

export type GuardVerdict =
  | { ok: true; suggestion: CleanupSuggestion }
  | { ok: false; reason: string; /** true = vi phạm hàng rào (đếm metric); false = chỉ là rỗng (không còn gì để dọn). */ unsafe: boolean };

/**
 * Hàng rào an toàn (§5.6) — NGOÀI advisor, áp cho mọi gợi ý trước khi lưu, phát hay áp dụng:
 *  - chỉ `trim`/`delete`; chỉ mức Rác/Thấp/Trung bình (Cao, Giữ, hay bất cứ thứ gì khác — kể cả "audit_logs" — bị loại);
 *    Rác chỉ Xoá hẳn;
 *  - `olderThan` hợp lệ và KHÔNG mới hơn sàn cửa sổ retry;
 *  - không nhắm source "Giữ lâu";
 *  - gợi ý được DỰNG LẠI từ danh sách trắng các trường (trường lạ bị bỏ — không thể nêu bảng nào khác), id tính lại,
 *    `estimatedBytes`/`estimatedEvents` tính lại từ `by_bucket` (số advisor đưa bị bỏ qua), hạn = now + 24h.
 */
export function assertSuggestionSafe(raw: unknown, ctx: GuardContext): GuardVerdict {
  const s = raw as Partial<Record<keyof CleanupSuggestion, unknown>> | null;
  if (!s || typeof s !== 'object' || Array.isArray(s)) return { ok: false, reason: 'not_object', unsafe: true };
  if (s.action !== 'trim' && s.action !== 'delete') return { ok: false, reason: 'action', unsafe: true };
  const action = s.action as CleanAction;
  if (!Array.isArray(s.importance) || s.importance.length === 0) return { ok: false, reason: 'importance', unsafe: true };
  if (!s.importance.every((i) => (SAFE_IMPORTANCE as readonly unknown[]).includes(i))) return { ok: false, reason: 'importance_forbidden', unsafe: true };
  const importance = [...new Set(s.importance as Importance[])].sort((a, b) => IMPORTANCE_ORDER.indexOf(a) - IMPORTANCE_ORDER.indexOf(b));
  if (action === 'trim' && importance.includes('junk')) return { ok: false, reason: 'junk_trim', unsafe: true };
  const older = parseOlderThan(s.olderThan, ctx.now);
  if (!older) return { ok: false, reason: 'older_than', unsafe: true };
  if (older.cutoff.getTime() > ctx.now - ctx.floorMs) return { ok: false, reason: 'older_than_too_recent', unsafe: true };
  let sourceId: string | null = null;
  if (s.sourceId !== undefined && s.sourceId !== null) {
    if (typeof s.sourceId !== 'string' || !UUID_RE.test(s.sourceId)) return { ok: false, reason: 'source_id', unsafe: true };
    sourceId = s.sourceId.toLowerCase();
    if (ctx.keepLongerSourceIds.map((x) => x.toLowerCase()).includes(sourceId)) return { ok: false, reason: 'keep_longer_source', unsafe: true };
  }
  const advisor = typeof s.advisor === 'string' && ADVISOR_RE.test(s.advisor) ? s.advisor : 'unknown';
  const est = estimateClean(ctx.buckets, { action, importance, minAgeDays: older.minAgeDays, sourceId });
  if (est.events === 0) return { ok: false, reason: 'empty', unsafe: false };
  return {
    ok: true,
    suggestion: {
      id: suggestionId(advisor, importance, action, older.label, sourceId),
      action,
      importance,
      olderThan: older.label,
      sourceId,
      estimatedBytes: est.bytes,
      estimatedEvents: est.events,
      reasonCode: typeof s.reasonCode === 'string' && /^[a-z0-9_]{1,40}$/.test(s.reasonCode) ? s.reasonCode : 'other',
      reason: typeof s.reason === 'string' ? s.reason.slice(0, 500) : '',
      advisor,
      expiresAt: new Date(ctx.now + SUGGESTION_TTL_MS).toISOString(),
    },
  };
}

/** Lọc cả bộ: gợi ý an toàn (khử trùng theo id) + danh sách bị loại vì vi phạm (người gọi log + tăng metric). */
export function guardSuggestions(list: readonly unknown[], ctx: GuardContext): { accepted: CleanupSuggestion[]; rejected: { advisor: string; reason: string }[] } {
  const accepted: CleanupSuggestion[] = [];
  const rejected: { advisor: string; reason: string }[] = [];
  const seen = new Set<string>();
  for (const raw of Array.isArray(list) ? list : []) {
    const v = assertSuggestionSafe(raw, ctx);
    if (v.ok) {
      if (!seen.has(v.suggestion.id)) {
        seen.add(v.suggestion.id);
        accepted.push(v.suggestion);
      }
    } else {
      const bad = v as Extract<GuardVerdict, { ok: false }>;
      if (!bad.unsafe) continue;
      const a = (raw as { advisor?: unknown } | null)?.advisor;
      rejected.push({ advisor: typeof a === 'string' && ADVISOR_RE.test(a) ? a : 'unknown', reason: bad.reason });
    }
  }
  return { accepted, rejected };
}

/**
 * Chạy advisor với hạn giờ; ném lỗi / quá giờ / trả không phải mảng -> fail-open về `fallback` (`rules@1`). Gợi ý lỗi không
 * được làm hỏng lượt đo. Kết quả CHƯA qua hàng rào — người gọi luôn `guardSuggestions`.
 */
export async function suggestWithFallback(
  advisor: CleanupAdvisor,
  fallback: CleanupAdvisor,
  snapshot: StorageSnapshot,
  timeoutMs = 5_000,
): Promise<{ suggestions: unknown[]; advisor: string; failedOpen: boolean; error?: string }> {
  if (advisor === fallback || advisor.id === fallback.id) {
    return { suggestions: await fallback.suggest(snapshot), advisor: fallback.id, failedOpen: false };
  }
  let timer: NodeJS.Timeout | undefined;
  try {
    const r = await Promise.race([
      advisor.suggest(snapshot),
      new Promise<never>((_, rej) => {
        timer = setTimeout(() => rej(new Error(`advisor ${advisor.id} quá ${timeoutMs}ms`)), timeoutMs);
        timer.unref?.();
      }),
    ]);
    if (!Array.isArray(r)) throw new Error(`advisor ${advisor.id} trả không phải mảng`);
    return { suggestions: r, advisor: advisor.id, failedOpen: false };
  } catch (err) {
    return { suggestions: await fallback.suggest(snapshot), advisor: fallback.id, failedOpen: true, error: (err as Error)?.message ?? String(err) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const LEVEL_RANK: readonly StorageLevel[] = ['OK', 'WARN_70', 'WARN_85', 'CRITICAL_95', 'LOCKED', 'HARD_LOCKED'];
export const levelRose = (from: StorageLevel, to: StorageLevel) => LEVEL_RANK.indexOf(to) > LEVEL_RANK.indexOf(from);

/**
 * Khi nào phát `hub.project.cleanup_suggested` (§5.6):
 *  - nấc đi LÊN -> phát (kể cả khi đã phát trong ngày);
 *  - bộ gợi ý đổi đáng kể: tổng `estimatedBytes` chênh ≥ 10% quota so với lần phát trước, và lần phát trước cũ hơn 24h;
 *  - `OK` + không có gợi ý -> không bao giờ.
 * Vẫn phát khi LOCKED (event của hub, không phải ingest).
 */
export function shouldEmitCleanupSuggested(i: {
  levelRose: boolean;
  level: StorageLevel;
  suggestionsCount: number;
  totalBytes: number;
  quotaBytes: number;
  prevEmittedBytes: number | null;
  prevEmittedAt: Date | null;
  now: number;
}): boolean {
  if (i.level === 'OK' && i.suggestionsCount === 0) return false;
  if (i.levelRose) return true;
  if (i.prevEmittedAt && i.now - i.prevEmittedAt.getTime() < SUGGESTION_TTL_MS) return false;
  return Math.abs(i.totalBytes - (i.prevEmittedBytes ?? 0)) >= 0.1 * i.quotaBytes;
}

