import { verificationFix } from '@hub/common';

type DestinationRow = {
  id: string;
  name: string;
  type: string;
  rateLimitRps: number;
  circuitState: string;
  signingSecretEncrypted?: string | null;
  verification: string;
  verificationError?: string | null;
  verifiedAt?: Date | null;
  createdByKeyId?: string | null;
  createdAt: Date;
};

/**
 * P2 (ADR-140): bản công khai của đích cho console. KHÔNG bao giờ có `configEncrypted`/`signingSecretEncrypted`;
 * có trạng thái xác minh challenge (PENDING/VERIFIED/FAILED + mã lỗi + gợi ý sửa) để đích FAILED hiện trên console.
 */
export function consoleDestination(d: DestinationRow) {
  return {
    id: d.id,
    name: d.name,
    type: d.type,
    rateLimitRps: d.rateLimitRps,
    circuitState: d.circuitState,
    hasSigningSecret: !!d.signingSecretEncrypted,
    verification: d.verification,
    verificationError: d.verificationError ?? null,
    verificationFix: verificationFix(d.verificationError),
    verifiedAt: d.verifiedAt ?? null,
    /** Endpoint do một service tạo qua `/v1/p` (API key) — console chỉ xem, service tự quản. */
    managedByService: !!d.createdByKeyId,
    createdAt: d.createdAt,
  };
}
