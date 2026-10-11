import { PrismaService, TenantScopedRepository, getMasterKey } from '@hub/database';
import { aesGcmDecrypt, aesGcmEncrypt, generateWhsecSecret } from '@hub/crypto';
import { verificationFix } from '@hub/common';
import { unprocessable } from './service-api.controller';
import { EndpointVerifier, VerificationOutcome } from './endpoint-verifier';

/** C-1 (ADR-131): đường nào gây ra challenge — để audit nói rõ lần thất bại đến từ đâu (vòng ensure của service = rotate). */
export type VerifyAttempt = 'create' | 'verify' | 'rotate' | 'adopt';
const VERIFY_AUDIT_ACTIONS = ['endpoint.verified', 'endpoint.verification_failed', 'endpoint.adopted'];
/** Cửa sổ chống spam audit verify thất bại: lỗi y hệt lặp lại trong 1 giờ chỉ ghi một lần. */
export const VERIFY_FAILURE_AUDIT_DEDUPE_MS = 60 * 60_000;

export function parseEndpointUrl(v: unknown): string {
  let u: URL | null = null;
  try {
    u = typeof v === 'string' && v.length <= 2048 ? new URL(v) : null;
  } catch {
    u = null;
  }
  if (!u || (u.protocol !== 'http:' && u.protocol !== 'https:')) {
    unprocessable({ error: 'validation_failed', field: 'url', message: 'url là địa chỉ http(s) tuyệt đối, ≤ 2048 ký tự' });
  }
  return u!.toString();
}

/** `signingSecret` do service/dev tự đưa: chuỗi 16–256 ký tự; không đưa = hub sinh `whsec_…`. */
export function parseGivenSecret(given: unknown): string | undefined {
  if (given !== undefined && (typeof given !== 'string' || given.length < 16 || given.length > 256)) {
    unprocessable({ error: 'validation_failed', field: 'signingSecret', message: 'signingSecret là chuỗi 16–256 ký tự' });
  }
  return given as string | undefined;
}

/** DX1 §2.3: kết quả challenge kèm `verificationFix`. */
export function withFix<T extends { verificationError: string | null }>(o: T): T & { verificationFix: string | null } {
  return { ...o, verificationFix: verificationFix(o.verificationError) };
}

/** Bản công khai của endpoint: KHÔNG bao giờ có config/secret mã hoá. */
export function publicEndpoint(d: any, url: string | null) {
  return {
    id: d.id,
    name: d.name,
    url,
    verification: d.verification,
    verificationError: d.verificationError ?? null,
    // DX1 §2.3: gợi ý sửa ngay cạnh lý do (null khi VERIFIED).
    verificationFix: verificationFix(d.verificationError),
    verifiedAt: d.verifiedAt ?? null,
    createdAt: d.createdAt,
  };
}

export function endpointUrl(configEncrypted: string): string | null {
  try {
    const url = JSON.parse(aesGcmDecrypt(configEncrypted, getMasterKey()))?.url;
    return typeof url === 'string' ? url : null;
  } catch {
    return null;
  }
}

export function storedSecret(d: { signingSecretEncrypted?: string | null }): string | null {
  try {
    return d.signingSecretEncrypted ? aesGcmDecrypt(d.signingSecretEncrypted, getMasterKey()) : null;
  } catch {
    return null;
  }
}

/**
 * C-1 (ADR-131): MỌI lần verify thất bại phải để lại dấu vết (trước đây xoay secret / adopt FAILED trả về im lặng ->
 * Shop retry `ensure` vào URL bị chặn mà console trống trơn). Chống spam từ vòng retry: nếu audit verify MỚI NHẤT của
 * endpoint trong 1 giờ là `verification_failed` cùng mã lỗi + cùng attempt -> bỏ qua. Bền (đọc Postgres, đúng với
 * nhiều instance, 0 lệnh Redis). Metadata CHỈ có mã lỗi + attempt — không url, không secret.
 */
export async function auditVerificationFailure(
  repo: TenantScopedRepository,
  id: string,
  code: string | null,
  attempt: VerifyAttempt,
  actor: string,
  extra: Record<string, unknown> = {},
): Promise<boolean> {
  const last: any = await repo.findLatestAuditForEntity('destination', id, VERIFY_AUDIT_ACTIONS, new Date(Date.now() - VERIFY_FAILURE_AUDIT_DEDUPE_MS));
  if (last?.action === 'endpoint.verification_failed' && last.metadata?.verificationError === code && last.metadata?.attempt === attempt) return false;
  await repo.createAuditLog({ action: 'endpoint.verification_failed', entityType: 'destination', entityId: id, actor, metadata: { verificationError: code, attempt, ...extra } });
  return true;
}

export interface CreateEndpointInput {
  name: string;
  url: string;
  /** Không có -> hub sinh `whsec_…` và trả ĐÚNG MỘT LẦN (`generatedSecret`). */
  signingSecret?: string;
  /** R-1 (ADR-094): key tạo endpoint qua /v1/p. Console: null (đích của operator). */
  createdByKeyId?: string | null;
}

export interface CreateEndpointResult<S> {
  destination: any;
  url: string;
  outcome: VerificationOutcome;
  extra: S;
  /** Chỉ có khi hub sinh secret. */
  generatedSecret?: string;
}

/**
 * KN1 (SPEC-ket-noi §3.1, ADR-138): lõi tạo endpoint DÙNG CHUNG cho API service (`/v1/p/:project/endpoints`) và console
 * (`/api/v1/endpoints`). Thứ tự cố định:
 *   1. TX: tạo destination `webhook` PENDING (secret mã hoá) + audit `endpoint.create` (+ `within(repo, d)` của bên gọi,
 *      vd subscription của console — lỗi ở đây rollback cả endpoint, không còn endpoint mồ côi)  -> COMMIT
 *   2. challenge NGOÀI transaction (không giữ kết nối Postgres khi gọi mạng — tối đa 10s)
 *   3. TX: ghi kết quả challenge + audit (`recordVerification`).
 * Adopt (ADR-098/101) KHÔNG ở đây — chỉ đường service dùng.
 */
export class EndpointService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly verifier: EndpointVerifier,
  ) {}

  async create<S = undefined>(
    tenantId: string,
    input: CreateEndpointInput,
    actor: string,
    within?: (repo: TenantScopedRepository, destination: any) => Promise<S>,
  ): Promise<CreateEndpointResult<S>> {
    const signingSecret = input.signingSecret ?? generateWhsecSecret();
    const masterKey = getMasterKey();
    const { destination, extra } = await this.withAudit(tenantId, async (repo) => {
      const d = await repo.createDestination({
        name: input.name,
        type: 'webhook',
        configEncrypted: aesGcmEncrypt(JSON.stringify({ url: input.url }), masterKey),
        signingSecretEncrypted: aesGcmEncrypt(signingSecret, masterKey),
        rateLimitRps: 0,
        verification: 'PENDING',
        createdByKeyId: input.createdByKeyId ?? null,
      });
      await repo.createAuditLog({ action: 'endpoint.create', entityType: 'destination', entityId: d.id, actor, metadata: { name: d.name } });
      const x = within ? await within(repo, d) : (undefined as S);
      return { destination: d, extra: x };
    });
    const outcome = await this.verifier.challenge(input.url, signingSecret);
    const updated = await this.recordVerification(tenantId, destination.id, outcome, actor, 'create');
    return {
      destination: updated ?? destination,
      url: input.url,
      outcome,
      extra,
      ...(input.signingSecret === undefined ? { generatedSecret: signingSecret } : {}),
    };
  }

  /** Chạy lại challenge bằng secret đang lưu rồi ghi kết quả (route `/verify` của cả hai phía). */
  async reverify(tenantId: string, d: any, actor: string): Promise<VerificationOutcome> {
    const url = endpointUrl(d.configEncrypted);
    const secret = storedSecret(d);
    const outcome: VerificationOutcome =
      url && secret ? await this.verifier.challenge(url, secret) : { verification: 'FAILED', verificationError: url ? 'no_signing_secret' : 'invalid_url' };
    await this.recordVerification(tenantId, d.id, outcome, actor, 'verify');
    return outcome;
  }

  /**
   * Ghi kết quả challenge + audit cùng transaction. Trạng thái endpoint cập nhật MỌI lần; audit thất bại đi qua
   * `auditVerificationFailure` (C-1, ADR-131: không spam khi retry).
   */
  recordVerification(tenantId: string, id: string, o: VerificationOutcome, actor: string, attempt: VerifyAttempt, newSecretEncrypted?: string) {
    return this.withAudit(tenantId, async (repo) => {
      const u = await repo.updateDestination(id, {
        ...(newSecretEncrypted ? { signingSecretEncrypted: newSecretEncrypted } : {}),
        verification: o.verification,
        verificationError: o.verificationError,
        verifiedAt: o.verification === 'VERIFIED' ? new Date() : null,
      });
      if (o.verification === 'VERIFIED') {
        await repo.createAuditLog({
          action: 'endpoint.verified',
          entityType: 'destination',
          entityId: id,
          actor,
          metadata: { verificationError: null, attempt, ...(newSecretEncrypted ? { secretRotated: true } : {}) },
        });
      } else {
        await auditVerificationFailure(repo, id, o.verificationError, attempt, actor);
      }
      return u;
    });
  }

  withAudit<T>(tenantId: string, fn: (repo: TenantScopedRepository) => Promise<T>): Promise<T> {
    return this.prisma.tenantTx(tenantId, (tx) => fn(this.prisma.forTenant(tenantId, tx)));
  }
}
