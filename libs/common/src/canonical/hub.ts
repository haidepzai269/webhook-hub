/**
 * Catalog kiểu chuẩn v1 — miền HUB: sự kiện do CHÍNH hub phát (SPEC-han-muc-dung-luong §5.6, ADR-187). Đi qua outbox bình
 * thường như mọi event (định tuyến theo subscription, push ký Standard Webhooks, polling) — không có đường gửi riêng.
 * `hub.*` là không gian DÀNH RIÊNG: service tự phát (`/v1/p/:project/events`) hay adapter phát `hub.*` sai khuôn / không có
 * trong catalog -> từ chối (không giả mạo được sự kiện của hub).
 */
import { CanonicalResult, FAIL, OK, checkExactKeys, isPlainObject } from './result';

export const HUB_CLEANUP_SUGGESTED = 'hub.project.cleanup_suggested';

/** `hub.project.cleanup_suggested` — `data`. Số liệu là ƯỚC TÍNH (§2). */
export const HUB_CLEANUP_SUGGESTED_KEYS = ['level', 'usedBytes', 'quotaBytes', 'forecastHours', 'suggestions'] as const;
/** Một phần tử `suggestions[]` (= `CleanupSuggestion`, libs/common/src/storage/cleanup-advisor.ts). */
export const HUB_SUGGESTION_KEYS = [
  'id',
  'action',
  'importance',
  'olderThan',
  'sourceId',
  'estimatedBytes',
  'estimatedEvents',
  'reasonCode',
  'reason',
  'advisor',
  'expiresAt',
] as const;

const LEVELS = ['OK', 'WARN_70', 'WARN_85', 'CRITICAL_95', 'LOCKED', 'HARD_LOCKED'];
const SAFE_IMPORTANCE = ['junk', 'low', 'medium'];

/** Tập khoá đầy đủ của `data` cho một kiểu hub; null nếu không thuộc catalog. */
export function hubKeys(type: string): string[] | null {
  if (type === HUB_CLEANUP_SUGGESTED) return [...HUB_CLEANUP_SUGGESTED_KEYS];
  return null;
}

const isCount = (v: unknown) => typeof v === 'number' && Number.isInteger(v) && v >= 0;

export function validateHub(type: string, data: unknown): CanonicalResult {
  if (type !== HUB_CLEANUP_SUGGESTED) return FAIL('type');
  if (!isPlainObject(data)) return FAIL('data');
  const bad = checkExactKeys(data, HUB_CLEANUP_SUGGESTED_KEYS);
  if (bad) return bad;
  if (!LEVELS.includes(data.level as string)) return FAIL('level');
  if (!isCount(data.usedBytes)) return FAIL('usedBytes');
  if (!isCount(data.quotaBytes)) return FAIL('quotaBytes');
  if (data.forecastHours !== null && !(typeof data.forecastHours === 'number' && data.forecastHours >= 0)) return FAIL('forecastHours');
  if (!Array.isArray(data.suggestions)) return FAIL('suggestions');
  for (const s of data.suggestions) {
    if (!isPlainObject(s)) return FAIL('suggestions');
    const b = checkExactKeys(s, HUB_SUGGESTION_KEYS, 'suggestions.');
    if (b) return b;
    if (typeof s.id !== 'string' || !s.id.startsWith('sug_')) return FAIL('suggestions.id');
    if (s.action !== 'trim' && s.action !== 'delete') return FAIL('suggestions.action');
    if (!Array.isArray(s.importance) || s.importance.length === 0 || !s.importance.every((i) => SAFE_IMPORTANCE.includes(i as string))) {
      return FAIL('suggestions.importance');
    }
    if (typeof s.olderThan !== 'string') return FAIL('suggestions.olderThan');
    if (s.sourceId !== null && typeof s.sourceId !== 'string') return FAIL('suggestions.sourceId');
    if (!isCount(s.estimatedBytes)) return FAIL('suggestions.estimatedBytes');
    if (!isCount(s.estimatedEvents)) return FAIL('suggestions.estimatedEvents');
    if (typeof s.reasonCode !== 'string' || typeof s.reason !== 'string' || typeof s.advisor !== 'string') return FAIL('suggestions.reason');
    if (typeof s.expiresAt !== 'string' || !Number.isFinite(Date.parse(s.expiresAt))) return FAIL('suggestions.expiresAt');
  }
  return OK;
}
