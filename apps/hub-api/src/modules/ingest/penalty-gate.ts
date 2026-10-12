import type { INestApplication } from '@nestjs/common';
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'http';
import { generateCorrelationId, logger } from '@hub/common';
import { ingestDuration, ingestRequests } from '../metrics/metrics';
import { blockedAck, providerMetricLabel } from './blocked-ack';
import { PenaltyBox, PenaltyVerdict } from './penalty-box';
import { IngestService } from './ingest.service';

/**
 * D3 (SPEC-chong-qua-tai ĐÍNH CHÍNH D3/D4, ADR-177 bổ sung): gate hộp phạt TRƯỚC body parser. IP/cặp đang bị phạt nhận 429
 * ngay ở phase header — Node không đọc, không parse body (tới 1MB) của kẻ đang bị chặn.
 *
 * - Chỉ KIỂM (`checkIp`, `checkPair`). Chấm điểm (`recordUnknownSource`, `recordBadSignature`, `markGood`) vẫn ở ingest.
 * - Path không khớp khuôn -> `next()` (fail-open): ingest trả lỗi như cũ và vẫn tự kiểm hộp phạt sau body parser.
 * - Chặn: `Connection: close` (`shouldKeepAlive=false`) để không phải nhận nốt body rác; 429 dựng bằng `blockedAck` dùng
 *   chung với ingest; metric `BLOCKED` ghi đúng MỘT lần ở đây (ingest không chạy); cặp có chủ -> lưu lượng `BLOCKED`
 *   như ingest. Gate ném lỗi -> log + `next()`.
 * - 0 Redis, 0 DB (R1 không đổi).
 */

/** Route mặc định của gate. `/v1/p/*` KHÔNG có (D6: 401 API key ở ApiKeyGuard, luật (b) chưa áp cho /v1/p). */
export const DEFAULT_PENALTY_GATE_ROUTES: readonly string[] = ['/hooks'];

/** Khuôn của nginx (§3.4) trên phần path SAU route: `/:provider/:sourceKey`. */
const HOOK_PATH_RE = /^\/([a-z0-9-]+)\/([A-Za-z0-9_-]{1,64})$/;

export interface PenaltyGateDeps {
  penalty: PenaltyBox;
  /** EG4: cặp đang bị phạt có chủ -> `BLOCKED` vào lưu lượng của source (giống ingest). */
  traffic?: { record(tenantId: string, sourceId: string, outcome: 'BLOCKED', ip?: string): void };
  /** Danh sách route (tiền tố) — mặc định `['/hooks']`. */
  routes?: readonly string[];
}

type GateReq = IncomingMessage & { ip?: string; originalUrl?: string; path?: string };

/**
 * Tách `{provider, sourceKey}` từ path GIỐNG Express/Nest: so tiền tố không phân biệt hoa thường, bỏ query, chấp nhận MỘT
 * `/` cuối (routing không strict), mỗi đoạn `decodeURIComponent` một lần như `@Param()` — `/hooks/github/src%5Fx` là
 * `src_x` ở cả gate lẫn ingest (không né gate bằng percent-encoding). Không khớp -> null.
 */
export function parseHookPath(url: string | undefined, routes: readonly string[] = DEFAULT_PENALTY_GATE_ROUTES): { provider: string; sourceKey: string } | null {
  if (!url) return null;
  let path = url.split('?')[0];
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  const lower = path.toLowerCase();
  for (const route of routes) {
    const r = route.toLowerCase();
    if (!lower.startsWith(r + '/')) continue;
    const segs = path.slice(r.length + 1).split('/');
    if (segs.length !== 2) return null;
    let provider: string;
    let sourceKey: string;
    try {
      provider = decodeURIComponent(segs[0]);
      sourceKey = decodeURIComponent(segs[1]);
    } catch {
      return null; // %xx hỏng: Express trả 400 — không phải việc của gate
    }
    const m = HOOK_PATH_RE.exec(`/${provider}/${sourceKey}`);
    return m ? { provider: m[1], sourceKey: m[2] } : null;
  }
  return null;
}

export function createPenaltyGate(deps: PenaltyGateDeps): (req: GateReq, res: ServerResponse, next: (err?: unknown) => void) => void {
  const routes = deps.routes ?? DEFAULT_PENALTY_GATE_ROUTES;
  return function penaltyGate(req, res, next) {
    const startedAt = Date.now();
    let hit: { provider: string; sourceKey: string } | null;
    let verdict: PenaltyVerdict;
    try {
      if (req.method !== 'POST') return next();
      hit = parseHookPath(req.originalUrl ?? req.url, routes);
      if (!hit) return next();
      verdict = deps.penalty.checkIp(req.ip, hit.sourceKey);
      if (!verdict.blocked) verdict = deps.penalty.checkPair(req.ip, hit.sourceKey);
      if (!verdict.blocked) return next();
    } catch (err: any) {
      logger.warn({ err: err?.message }, 'Gate hộp phạt lỗi -> cho request đi qua (fail-open)');
      return next();
    }

    try {
      sendBlocked(res, verdict.retryAfterSec, req.headers);
    } catch (err: any) {
      logger.warn({ err: err?.message }, 'Gate hộp phạt không trả được 429 -> cho request đi qua (fail-open)');
      if (!res.headersSent) return next();
      return;
    }
    // Quan sát: lỗi metric/lưu lượng không lật kết luận (đã trả 429).
    try {
      const label = providerMetricLabel(hit.provider);
      ingestRequests.inc({ provider: label, outcome: 'BLOCKED' });
      ingestDuration.observe({ provider: label }, (Date.now() - startedAt) / 1000);
    } catch {
      /* bỏ qua */
    }
    if (verdict.owner && deps.traffic) {
      try {
        deps.traffic.record(verdict.owner.tenantId, verdict.owner.sourceId, 'BLOCKED', req.ip);
      } catch (err: any) {
        logger.warn({ err: err?.message }, 'Không ghi được lưu lượng vào bộ nhớ (bỏ qua)');
      }
    }
  };
}

function sendBlocked(res: ServerResponse, retryAfterSec: number, headers: IncomingHttpHeaders): void {
  const ack = blockedAck(retryAfterSec, headers, generateCorrelationId());
  // Body chưa đọc: đóng kết nối sau 429 thay vì nhận nốt (tới 1MB) để giữ keep-alive.
  res.shouldKeepAlive = false;
  res.statusCode = ack.status;
  for (const [k, v] of Object.entries(ack.headers ?? {})) res.setHeader(k, v);
  res.setHeader('Connection', 'close');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(ack.body));
}

/**
 * Cài gate cho app (main.ts + test dùng chung): lấy ĐÚNG instance hộp phạt của DI và bộ ghi lưu lượng của ingest.
 * Gọi NGAY TRƯỚC `configureBodyParsers` (sau trust proxy, helmet, installErrorHandling, CORS).
 */
export function installPenaltyGate(app: INestApplication, routes: readonly string[] = DEFAULT_PENALTY_GATE_ROUTES): void {
  app.use(createPenaltyGate({ penalty: app.get(PenaltyBox), traffic: app.get(IngestService).traffic, routes }));
}
