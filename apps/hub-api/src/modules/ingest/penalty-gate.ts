import type { INestApplication } from '@nestjs/common';
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'http';
import { generateCorrelationId, logger } from '@hub/common';
import { ingestDuration, ingestRequests } from '../metrics/metrics';
import { blockedAck, providerMetricLabel } from './blocked-ack';
import { PenaltyBox, PenaltyVerdict } from './penalty-box';
import { IngestService } from './ingest.service';
import { HookRouteMatch, hooksPathOf, matchHookRoute, pathnameOfUrl } from './hooks-path';

/**
 * D3 (SPEC-chong-qua-tai ĐÍNH CHÍNH D3/D4, ADR-177 bổ sung): gate hộp phạt TRƯỚC body parser. IP/cặp đang bị phạt nhận 429
 * ngay ở phase header — Node không đọc, không parse body (tới 1MB) của kẻ đang bị chặn.
 *
 * - Chỉ KIỂM (`checkIp`, `checkPair`). Chấm điểm (`recordUnknownSource`, `recordBadSignature`, `markGood`) vẫn ở ingest.
 * - Path tách bằng `hooksPathOf` (parseurl, đúng như router) — không né được gate bằng `#`, absolute-form, provider viết
 *   hoa. Không khớp `<route>/:a/:b` -> `next()`: router cũng không giao cho ingest.
 * - Chặn: `Connection: close` (`shouldKeepAlive=false`) để không phải nhận nốt body rác; 429 dựng bằng `blockedAck` dùng
 *   chung với ingest; metric `BLOCKED` ghi đúng MỘT lần ở đây (ingest không chạy); cặp có chủ -> lưu lượng `BLOCKED`
 *   như ingest. Gate ném lỗi -> log + `next()`.
 * - 0 Redis, 0 DB (R1 không đổi).
 */

/** Route mặc định của gate. `/v1/p/*` KHÔNG có (D6: 401 API key ở ApiKeyGuard, luật (b) chưa áp cho /v1/p). */
export const DEFAULT_PENALTY_GATE_ROUTES: readonly string[] = ['/hooks'];

export interface PenaltyGateDeps {
  penalty: PenaltyBox;
  /** EG4: cặp đang bị phạt có chủ -> `BLOCKED` vào lưu lượng của source (giống ingest). */
  traffic?: { record(tenantId: string, sourceId: string, outcome: 'BLOCKED', ip?: string): void };
  /** Danh sách route (tiền tố) — mặc định `['/hooks']`. */
  routes?: readonly string[];
}

type GateReq = IncomingMessage & { ip?: string; originalUrl?: string; path?: string };

/**
 * Tách `{provider, sourceKey}` từ request-target GIỐNG router của Nest: pathname qua `parseurl` (bỏ query, `#frag`, chấp
 * nhận absolute-form), rồi `matchHookRoute` (tiền tố không phân biệt hoa thường, một `/` cuối, decode từng đoạn như
 * `@Param()`). KHÔNG lọc provider/khuôn sourceKey (review EG lượt 6, TB-1): mọi path router giao cho ingest thì gate cũng
 * kiểm — `checkIp`/`checkPair` chỉ cần sourceKey; key lạ không thể là cặp tốt hay cặp bị ban nên chỉ luật (a) áp, đúng
 * như ingest bước 0. Không khớp -> null.
 */
export function parseHookPath(url: string | undefined, routes: readonly string[] = DEFAULT_PENALTY_GATE_ROUTES): HookRouteMatch | null {
  return matchHookRoute(pathnameOfUrl(url), routes);
}

export function createPenaltyGate(deps: PenaltyGateDeps): (req: GateReq, res: ServerResponse, next: (err?: unknown) => void) => void {
  const routes = deps.routes ?? DEFAULT_PENALTY_GATE_ROUTES;
  return function penaltyGate(req, res, next) {
    const startedAt = Date.now();
    let hit: HookRouteMatch | null;
    let verdict: PenaltyVerdict;
    try {
      if (req.method !== 'POST') return next();
      hit = matchHookRoute(hooksPathOf(req), routes); // app.use ở gốc: req.url = originalUrl
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
