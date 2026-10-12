import { TenantScopedRepository } from '@hub/database';
import { resolveSourceLimitPerProject } from '@hub/common';
import { hubError } from '../errors/hub-error';
import { RequestWithPrincipal } from '../service-api/principal';

/** QT9: chỉ người vận hành đăng nhập console (không phải API key) được miễn trần source. */
export function isOperatorRequest(req: RequestWithPrincipal | undefined): boolean {
  const p = req?.principal;
  return p?.kind === 'user' && p.isOperator === true;
}

/**
 * QT9 (SPEC-han-muc-dung-luong §10, Q11): trần số source chưa lưu trữ mỗi project — kiểm TRONG transaction tạo source,
 * sau khoá theo project (`lockAndCountActiveSources`), cùng khuôn với trần project (R-14, ADR-118). Vượt -> 409
 * `source_limit`. Operator không bị giới hạn (`exempt`). Dùng chung cho mọi đường tạo source: console, `/v1/p` service,
 * "Kết nối provider", tạo key có `publish:events` (kèm source `api`).
 */
export async function assertSourceLimit(repo: TenantScopedRepository, exempt: boolean, limit: number = resolveSourceLimitPerProject()): Promise<void> {
  if (exempt) return;
  if ((await repo.lockAndCountActiveSources()) >= limit) {
    throw hubError('source_limit', { limit }, `Project đã có tối đa ${limit} source đang dùng — lưu trữ source không dùng nữa rồi thử lại`);
  }
}
