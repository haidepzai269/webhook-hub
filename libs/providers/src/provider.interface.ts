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
   * Chuyển đổi payload gốc thành mảng sự kiện chuẩn hóa (NormalizedEvent).
   */
  normalize(
    req: RawWebhookRequest,
    context: {
      tenantId: string;
      sourceId: string;
      correlationId: string;
      rawEventId: string;
    },
  ): NormalizedEvent[];

  /**
   * Phản hồi HTTP status và body đúng định dạng provider mong đợi.
   */
  buildAck(result: IngestResult): { status: number; body: unknown };
}
