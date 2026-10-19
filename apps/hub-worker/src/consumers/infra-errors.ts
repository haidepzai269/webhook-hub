/**
 * Giai đoạn 2A log (ADR-250): `classifyInfraError` dời về `@hub/database` để hub-api dùng chung (ingest phân biệt
 * `fail.hub_db` — hạ tầng tạm thời — với `fail.hub_unknown`). Re-export để chỗ import cũ trong hub-worker không đổi.
 */
export { classifyInfraError } from '@hub/database';
export type { InfraErrorKind } from '@hub/database';
