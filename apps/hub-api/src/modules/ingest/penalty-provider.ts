import { Provider } from '@nestjs/common';
import { logger } from '@hub/common';
import { penaltyBans, penaltyBansSkipped, penaltyBlocked } from '../metrics/metrics';
import { PenaltyBox, logBan, resolvePenaltyConfig } from './penalty-box';

/**
 * D3 (SPEC-chong-qua-tai ĐÍNH CHÍNH D4-1): hộp phạt là MỘT instance dùng chung cho gate trước body parser và
 * `IngestService` — hai instance thì trạng thái bị tách đôi (ingest chấm điểm vào hộp A, gate kiểm hộp B: không bao giờ chặn).
 * Hook metric/log nằm ở đây, không còn trong IngestService.
 */
export function createPenaltyBox(): PenaltyBox {
  let lastCapacityLog = 0;
  return new PenaltyBox(resolvePenaltyConfig(), {
    onBan: (reason, ip, sourceKey, banSeconds) => {
      penaltyBans.inc({ reason });
      logBan(reason, ip, sourceKey, banSeconds);
    },
    onBlocked: (reason) => penaltyBlocked.inc({ reason }),
    onBanSkipped: (reason, cause) => {
      penaltyBansSkipped.inc({ reason, cause });
      // `capacity` = hộp đầy ban -> không phạt (fail-open có tiếng). Log tối đa một lần mỗi phút.
      if (cause === 'capacity' && Date.now() - lastCapacityLog > 60_000) {
        lastCapacityLog = Date.now();
        logger.warn({ reason }, 'Hộp phạt: số ban đã chạm trần -> KHÔNG phạt thêm (cho đi qua)');
      }
    },
  });
}

/** Provider Nest (singleton) — `app.module.ts` đăng ký; gate lấy bằng `app.get(PenaltyBox)`, ingest inject cùng instance. */
export const PENALTY_BOX_PROVIDER: Provider = { provide: PenaltyBox, useFactory: createPenaltyBox };
