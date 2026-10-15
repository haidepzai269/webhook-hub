/**
 * LH2 — cấu hình Worker `hub-hooks` (SPEC-hub-sap §13). Mọi giá trị số đều kẹp; sai khuôn -> mặc định.
 * Secret (`CATCHNET_FORWARD_SECRET`, `CATCHNET_ADMIN_TOKEN`) đặt bằng `wrangler secret put` (deployed) hoặc `.dev.vars`
 * (local) — KHÔNG bao giờ ở `wrangler.toml`.
 */
import type { D1Database } from './d1';

export interface Env {
  DB: D1Database;
  /** URL gốc hub thật (Render) để chuyển tiếp/phát lại. Chỉ lấy origin. */
  HUB_ORIGIN_URL?: string;
  /** HMAC header lưới (ADR-217). 1–2 giá trị phân tách `,`; Worker ký bằng giá trị ĐẦU (hub nhận cả hai khi xoay khoá). */
  CATCHNET_FORWARD_SECRET?: string;
  /** Bearer token cho `/_admin/*` (hub-api đồng bộ `sources_sync`, §4.5). */
  CATCHNET_ADMIN_TOKEN?: string;
  CATCHNET_FORWARD_TIMEOUT_MS?: string;
  CATCHNET_REPLAY_BATCH?: string;
  CATCHNET_RETENTION_DAYS?: string;
  CATCHNET_MAX_PER_KEY?: string;
  CATCHNET_MAX_ROWS?: string;
}

export interface Config {
  hubOrigin: string | null;
  /** null = Worker KHÔNG ký được -> vẫn chuyển tiếp (ghi xuyên) nhưng không hứng (hub vắng -> 503). */
  forwardSecret: string | null;
  adminToken: string | null;
  forwardTimeoutMs: number;
  replayBatch: number;
  retentionMs: number;
  maxPerKey: number;
  maxRows: number;
}

/** Giống hub-api (`MIN_CATCHNET_SECRET_CHARS`, REVIEW-LH3 T-6): secret ngắn bị dò offline từ một header lộ ra. */
export const MIN_SECRET_CHARS = 32;
export const DAY_MS = 86_400_000;
/** Trần ingest của hub (H10). Lớn hơn -> 413, không hứng. */
export const MAX_BODY_BYTES = 1024 * 1024;

function intIn(raw: string | undefined, def: number, min: number, max: number): number {
  if (raw === undefined || raw.trim() === '') return def;
  const n = Number(raw);
  if (!Number.isInteger(n)) return def;
  return Math.min(max, Math.max(min, n));
}

/** `CATCHNET_RETENTION_DAYS`: CÙNG luật với hub (`catchnetRetentionMs`): nguyên 1..30, sai khuôn -> 7 (không kẹp). */
export function retentionDays(raw: string | undefined): number {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 30 ? n : 7;
}

export function firstSecret(raw: string | undefined): string | null {
  const first = (raw ?? '').split(',').map((s) => s.trim()).filter(Boolean)[0];
  return first && first.length >= MIN_SECRET_CHARS ? first : null;
}

export function hubOriginOf(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return u.origin;
  } catch {
    return null;
  }
}

export function loadConfig(env: Env): Config {
  const admin = (env.CATCHNET_ADMIN_TOKEN ?? '').trim();
  return {
    hubOrigin: hubOriginOf(env.HUB_ORIGIN_URL),
    forwardSecret: firstSecret(env.CATCHNET_FORWARD_SECRET),
    adminToken: admin.length >= MIN_SECRET_CHARS ? admin : null,
    forwardTimeoutMs: intIn(env.CATCHNET_FORWARD_TIMEOUT_MS, 4000, 1000, 8000),
    replayBatch: intIn(env.CATCHNET_REPLAY_BATCH, 25, 1, 40),
    retentionMs: retentionDays(env.CATCHNET_RETENTION_DAYS) * DAY_MS,
    maxPerKey: intIn(env.CATCHNET_MAX_PER_KEY, 2000, 1, 1_000_000),
    maxRows: intIn(env.CATCHNET_MAX_ROWS, 50_000, 1, 10_000_000),
  };
}
