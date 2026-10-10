import { DeliveryMessage } from './types';

/** Các khoá DUY NHẤT được phép nằm trong message delivery (S1-1, ADR-042). */
export const DELIVERY_MESSAGE_KEYS = ['deliveryId', 'tenantId', 'attemptGeneration', 'attemptCount', 'correlationId'] as const;

/** Dựng message gọn — nơi duy nhất quyết định hình dạng message (normalize, replay, retry, DLQ). */
export function buildDeliveryMessage(input: DeliveryMessage): DeliveryMessage {
  return {
    deliveryId: input.deliveryId,
    tenantId: input.tenantId,
    attemptGeneration: input.attemptGeneration,
    attemptCount: input.attemptCount,
    correlationId: input.correlationId,
  };
}

/**
 * Đọc message từ broker. Tương thích ngược: message kiểu cũ (còn `config`, `signingSecret`,
 * `event`… trong hàng đợi retry) vẫn đọc được — chỉ lấy các trường tham chiếu và BỎ QUA phần
 * còn lại, để cấu hình luôn đọc từ DB chứ không tin bản sao cũ trong message.
 * Ném lỗi nếu JSON hỏng hoặc thiếu trường bắt buộc (→ DLQ).
 */
export function parseDeliveryMessage(content: Buffer | string, fallbackCorrelationId = 'unknown'): DeliveryMessage {
  const raw = JSON.parse(typeof content === 'string' ? content : content.toString());
  if (!raw || typeof raw.deliveryId !== 'string' || typeof raw.tenantId !== 'string') {
    throw new Error('DeliveryMessage thiếu deliveryId/tenantId');
  }
  return buildDeliveryMessage({
    deliveryId: raw.deliveryId,
    tenantId: raw.tenantId,
    attemptGeneration: Number(raw.attemptGeneration ?? 1),
    attemptCount: Number(raw.attemptCount ?? 0),
    correlationId: typeof raw.correlationId === 'string' ? raw.correlationId : fallbackCorrelationId,
  });
}
