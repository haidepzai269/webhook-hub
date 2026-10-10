import { RawWebhookRequest, NormalizedEvent, IngestResult, ProviderType } from '@hub/common';

export interface ProviderAdapter {
  readonly provider: ProviderType;

  /**
   * Xác thực request webhook.
   * Nhận MẢNG secret để hỗ trợ xoay secret (secret rotation).
   * Tính trên raw bytes (rawBody).
   */
  verify(req: RawWebhookRequest, secrets: string[]): Promise<boolean>;

  /**
   * Khóa chống trùng (idempotency key), ổn định giữa các lần provider gửi lại (redelivery).
   */
  extractIdempotencyKey(req: RawWebhookRequest): string;

  /**
   * Chữ ký (hoặc bằng chứng xác thực) để lưu vào `raw_events.signature_header` (S3-1).
   * Mỗi adapter tự biết chữ ký của mình nằm ở đâu — lõi ingest không đoán header.
   * Nếu bằng chứng là một bí mật dùng chung (API key) thì PHẢI che, không trả key thật.
   * Không có -> null.
   */
  extractSignature(req: RawWebhookRequest): string | null;

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
    },
  ): NormalizedEvent[];

  /**
   * Phản hồi HTTP status và body đúng định dạng provider mong đợi.
   */
  buildAck(result: IngestResult): { status: number; body: unknown };
}
