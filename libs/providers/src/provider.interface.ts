import { RawWebhookRequest, NormalizedEvent, IngestResult, ProviderType } from '@hub/common';

/**
 * S8 (SPEC §4.8): cấu hình RIÊNG của source (`sources.verification_config`) mà lõi chuyển cho adapter, không đọc.
 * 4 adapter cố định bỏ qua; GenericAdapter dựa vào nó. Lõi KHÔNG `if (provider === 'generic')`.
 */
export interface AdapterContext {
  verificationConfig?: unknown;
}

export interface ProviderAdapter {
  readonly provider: ProviderType;

  /**
   * Xác thực request webhook.
   * Nhận MẢNG secret để hỗ trợ xoay secret (secret rotation).
   * Tính trên raw bytes (rawBody).
   */
  verify(req: RawWebhookRequest, secrets: string[], ctx?: AdapterContext): Promise<boolean>;

  /**
   * Khóa chống trùng (idempotency key), ổn định giữa các lần provider gửi lại (redelivery).
   * Không lấy được -> ném `IdempotencyKeyMissingError` (lõi trả 422, KHÔNG fallback ulid).
   */
  extractIdempotencyKey(req: RawWebhookRequest, ctx?: AdapterContext): string;

  /**
   * Chữ ký (hoặc bằng chứng xác thực) để lưu vào `raw_events.signature_header` (S3-1).
   * Mỗi adapter tự biết chữ ký của mình nằm ở đâu — lõi ingest không đoán header.
   * Nếu bằng chứng là một bí mật dùng chung (API key) thì PHẢI che, không trả key thật.
   * Không có -> null.
   */
  extractSignature(req: RawWebhookRequest, ctx?: AdapterContext): string | null;

  /**
   * S8: header (viết thường) mang BÍ MẬT theo cấu hình của source — lõi che chúng trước khi lưu raw_events,
   * ngoài danh sách cố định của redactHeaders. Không có -> không cài.
   */
  sensitiveHeaders?(ctx?: AdapterContext): string[];

  /**
   * Chuyển đổi payload gốc thành mảng sự kiện chuẩn hóa (NormalizedEvent).
   */
  normalize(
    req: RawWebhookRequest,
    context: {
      tenantId: string;
      sourceId: string;
      correlationId: string;
      rawEventId: string;
      /** `raw_events.received_at` (ISO) — thời gian dự phòng ổn định khi renormalize (review SPEC-3 #4). */
      receivedAt?: string;
      /** S8: `sources.verification_config` (GenericAdapter). */
      verificationConfig?: unknown;
    },
  ): NormalizedEvent[];

  /**
   * Phản hồi HTTP status và body đúng định dạng provider mong đợi.
   */
  buildAck(result: IngestResult): { status: number; body: unknown };
}
