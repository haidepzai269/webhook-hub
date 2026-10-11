import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable, map } from 'rxjs';

/**
 * Cột ciphertext của model Prisma → cờ thay thế. CHỈ các khoá này: duyệt theo danh sách trắng
 * để không đụng vào payload người dùng (`event.data`, `rawEvent.body`…) vốn có thể tình cờ
 * chứa một trường tên `…Encrypted` — trang chi tiết phải hiện đúng những gì provider đã gửi.
 */
const SECRET_KEYS: Record<string, string> = {
  secretEncrypted: 'hasSecret',
  configEncrypted: 'hasConfig',
  signingSecretEncrypted: 'hasSigningSecret',
  // KN2 (SPEC-ket-noi §4.3 điều 2): credentials provider — chỉ ghi, không bao giờ đọc qua API.
  credentialsEncrypted: 'hasCredentials',
};

/**
 * Chuẩn hoá response `/api/v1/*` trước khi serialize:
 * - Bỏ ciphertext AES-GCM (ADR-032): lộ master key một lần là giải mã được mọi thứ từng hiện
 *   trên DevTools. Thay bằng cờ `has*` để UI vẫn biết "đã cấu hình".
 * - `BigInt` → string: `DeliveryAttempt.id` là BIGSERIAL, `JSON.stringify` ném lỗi với BigInt
 *   → mọi endpoint kèm `attempts` (deliveries, dlq) trả 500 nếu không đổi.
 */
export function redactSecrets(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (!isPlainObject(value)) return value;

  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    const flag = SECRET_KEYS[key];
    if (flag) {
      out[flag] = v != null && v !== '';
      continue;
    }
    out[key] = redactSecrets(v);
  }
  return out;
}

// Date, Buffer (raw body)… giữ nguyên — chỉ đệ quy vào object literal (bản ghi Prisma, Json).
function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object') return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

@Injectable()
export class RedactSecretsInterceptor implements NestInterceptor {
  intercept(_ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(map(redactSecrets));
  }
}
