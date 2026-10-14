import { hubError } from '../errors/hub-error';

/**
 * PK5 khoá 4 (§7.1, ADR-206): `acceptUnverified` của subscription — vắng -> undefined (không đổi), boolean -> giá trị,
 * khác -> 422. Dùng chung console subscription + endpoint.
 */
export function parseAcceptUnverified(v: unknown): boolean | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'boolean') throw hubError('validation_failed', { field: 'acceptUnverified' }, 'acceptUnverified là boolean');
  return v;
}
