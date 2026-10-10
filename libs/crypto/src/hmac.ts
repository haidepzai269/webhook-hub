import { createHash, createHmac, timingSafeEqual } from 'crypto';

export function hmacSha256(secret: string, data: Buffer | string): string {
  const hmac = createHmac('sha256', secret);
  hmac.update(data);
  return hmac.digest('hex');
}

/**
 * So sánh an toàn hai chuỗi chống timing attacks
 */
export function timingSafeCompare(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') {
    return false;
  }
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/**
 * Khoá chống trùng dự phòng (S3-1): sha256 của body gốc, 32 ký tự hex đầu (128 bit).
 * Provider gửi lại thì body y hệt -> khoá y hệt (BB-2). KHÔNG bao giờ dùng giá trị ngẫu nhiên.
 */
export function bodyHashKey(rawBody: Buffer | string): string {
  return createHash('sha256').update(rawBody).digest('hex').slice(0, 32);
}
