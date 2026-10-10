export * from './prisma.service';
export * from './tenant-scoped.repository';
export * from './constants';
export * from './identity.repository';

import { getMasterKey } from './constants';
import { TenantScopedRepository } from './tenant-scoped.repository';

/**
 * Kiểm export lúc khởi động (S1-6, ADR-047). BB09 P0-1: worker từng nạp `libs/database/dist` CŨ
 * (thiếu `getMasterKey`) — lỗi chỉ lộ ra khi message đầu tiên tới, message trôi vào DLQ và
 * `db push --accept-data-loss` xoá dữ liệu. Gọi hàm này ĐẦU `bootstrap()` của hub-api và hub-worker
 * để bản build lệch chết ngay lúc khởi động. (Nếu dist cũ tới mức không có cả hàm này, lời gọi
 * `assertDatabaseLib()` tự ném TypeError — cũng chết ngay, đúng mục đích.)
 */
export function assertDatabaseLib(): void {
  if (typeof getMasterKey !== 'function' || typeof TenantScopedRepository !== 'function') {
    throw new Error(
      'FATAL: @hub/database thiếu export (getMasterKey/TenantScopedRepository) — đang nạp bản build cũ? ' +
        'Xoá libs/*/dist rồi build lại.',
    );
  }
  const proto = TenantScopedRepository.prototype as unknown as Record<string, unknown>;
  for (const method of ['findDeliveryForSend', 'claimForSend', 'findRawEventById', 'updateDestinationCircuitState', 'deferDelivery', 'findDeadDeliveryRefs', 'findAuditLogs']) {
    if (typeof proto[method] !== 'function') {
      throw new Error(`FATAL: TenantScopedRepository thiếu ${method}() — đang nạp bản build cũ của @hub/database.`);
    }
  }
}
