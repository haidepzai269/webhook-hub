import { ERROR_CATALOG, ProviderType, docsUrlFor } from '@hub/common';
import { ProviderRegistry } from '@hub/providers';
import type { HubOutcome } from './hub-outcome';

/** Phản hồi của lõi ingest. `headers` chỉ dùng cho 429 của hộp phạt (`Retry-After`). */
/**
 * PK4: `contentType` (echo bắt tay `text/plain`), `headers` (Retry-After của hộp phạt; header-echo).
 * LH3 (H1, ADR-221): `outcome` -> header `x-hub-outcome` (controller đặt); `ingestWebhook` luôn điền.
 */
export type IngestResponse = { status: number; body: unknown; headers?: Record<string, string>; contentType?: string; outcome?: HubOutcome };

const REQUEST_ID_RE = /^[A-Za-z0-9._-]{8,128}$/;

/**
 * EG2 (ADR-177): 429 `ip_temporarily_blocked` theo khuôn ERRORS.md + `Retry-After` (giây phạt còn lại). `requestId` =
 * `x-request-id` hợp lệ (nginx gắn, EG1) hoặc `fallbackRequestId` (correlationId) — nối được log hai bên.
 * DÙNG CHUNG cho ingest (bước 0 / 2a) và gate trước body parser (D3) — hai đường trả đúng một khuôn.
 */
export function blockedAck(
  retryAfter: number,
  headers: Record<string, string | string[] | undefined> | undefined,
  fallbackRequestId: string,
): IngestResponse {
  const code = 'ip_temporarily_blocked';
  const def = ERROR_CATALOG[code];
  const given = headers?.['x-request-id'];
  const rid = Array.isArray(given) ? given[0] : given;
  return {
    status: 429,
    headers: { 'Retry-After': String(retryAfter) },
    body: {
      error: code,
      message: def.message,
      fix: def.fix({ retryAfter }),
      docsUrl: docsUrlFor(code),
      requestId: typeof rid === 'string' && REQUEST_ID_RE.test(rid) ? rid : fallbackRequestId,
      retryAfter,
    },
  };
}

/**
 * QT3 (ADR-182): 507 `project_storage_full` theo khuôn ERRORS.md cho `/hooks/*` (publish đi qua exception filter). Hằng của
 * lõi — không chứa level, quota hay gì của project ngoài mã lỗi. `requestId` như `blockedAck`.
 */
export function storageFullAck(headers: Record<string, string | string[] | undefined> | undefined, fallbackRequestId: string): IngestResponse {
  const code = 'project_storage_full';
  const def = ERROR_CATALOG[code];
  const given = headers?.['x-request-id'];
  const rid = Array.isArray(given) ? given[0] : given;
  return {
    status: def.status,
    body: {
      error: code,
      message: def.message,
      fix: def.fix(),
      docsUrl: docsUrlFor(code),
      requestId: typeof rid === 'string' && REQUEST_ID_RE.test(rid) ? rid : fallbackRequestId,
    },
  };
}

/**
 * S3-4: nhãn `provider` của metric chỉ nhận provider ĐÃ ĐĂNG KÝ — path `/hooks/:provider` do client gửi, để nguyên thì
 * kẻ xấu làm nổ số chuỗi thời gian (cardinality). Dùng chung ingest + gate.
 */
export function providerMetricLabel(provider: string): string {
  try {
    return ProviderRegistry.get(provider as ProviderType).provider;
  } catch {
    return 'unknown';
  }
}
