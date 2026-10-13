import { DeliveryMessage } from './types';

/** Các khoá DUY NHẤT được phép nằm trong message delivery (S1-1, ADR-042). */
export const DELIVERY_MESSAGE_KEYS = [
  'deliveryId',
  'tenantId',
  'attemptGeneration',
  'attemptCount',
  'correlationId',
  // BP2 (ADR-196): gợi ý tuỳ chọn cho gate trước khi nạp DB — không bí mật, luôn kiểm lại với DB.
  'destinationId',
  'rateLimitRps',
] as const;

/** Gợi ý BP2 hợp lệ? (`rateLimitRps` là số nguyên ≥ 0). */
function hintRps(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : NaN;
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

/** Dựng message gọn — nơi duy nhất quyết định hình dạng message (normalize, replay, retry, DLQ). */
export function buildDeliveryMessage(input: DeliveryMessage): DeliveryMessage {
  const out: DeliveryMessage = {
    deliveryId: input.deliveryId,
    tenantId: input.tenantId,
    attemptGeneration: input.attemptGeneration,
    attemptCount: input.attemptCount,
    correlationId: input.correlationId,
  };
  if (typeof input.destinationId === 'string' && input.destinationId) out.destinationId = input.destinationId;
  const rps = hintRps(input.rateLimitRps);
  if (rps !== undefined) out.rateLimitRps = rps;
  return out;
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
    destinationId: typeof raw.destinationId === 'string' ? raw.destinationId : undefined,
    rateLimitRps: hintRps(raw.rateLimitRps),
  });
}
