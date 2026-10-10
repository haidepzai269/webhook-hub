import { CurrentTenant } from '../auth/current-tenant.decorator';

/**
 * CHỖ DUY NHẤT route `flow` lấy phạm vi dữ liệu (SPEC §6A). Hiện là tenant từ JWT (`@CurrentTenant()`).
 * F7 (sau khi rebase lên đa service): đổi dòng dưới thành helper/guard đọc `projectId` của console (X2)
 * — controller/service không phải sửa.
 */
export const FlowScope = CurrentTenant;
