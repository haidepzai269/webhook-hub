import { consoleDestination } from '../src/modules/api/destination-view';

/**
 * P2 (ADR-140): `/api/v1/destinations` của console trả BẢN CÔNG KHAI của đích — không bao giờ có config/secret mã hoá
 * (trước đây trả nguyên hàng Prisma), có `hasSigningSecret` (cột "Ký HMAC" từng luôn ghi "không") và trạng thái
 * xác minh challenge để console thấy đích FAILED (vd `ssrf_blocked`).
 */
describe('consoleDestination — bản công khai của đích cho console (P2)', () => {
  const row = {
    id: 'd1',
    tenantId: 't1',
    name: 'shop',
    type: 'webhook',
    configEncrypted: 'enc:config',
    signingSecretEncrypted: 'enc:secret',
    rateLimitRps: 0,
    circuitState: 'CLOSED',
    alertOnOpen: false,
    verification: 'FAILED',
    verifiedAt: null,
    verificationError: 'ssrf_blocked',
    createdByKeyId: 'k1',
    createdAt: new Date('2026-10-11T00:00:00Z'),
  };

  it('không lộ configEncrypted / signingSecretEncrypted, có hasSigningSecret', () => {
    const v = consoleDestination(row) as Record<string, unknown>;
    expect(v).not.toHaveProperty('configEncrypted');
    expect(v).not.toHaveProperty('signingSecretEncrypted');
    expect(JSON.stringify(v)).not.toContain('enc:');
    expect(v.hasSigningSecret).toBe(true);
    expect(consoleDestination({ ...row, signingSecretEncrypted: null }).hasSigningSecret).toBe(false);
  });

  it('trả verification + verificationError + gợi ý sửa; VERIFIED thì không có lỗi', () => {
    const v = consoleDestination(row);
    expect(v.verification).toBe('FAILED');
    expect(v.verificationError).toBe('ssrf_blocked');
    expect(v.verificationFix).toMatch(/private\/internal/);
    expect(v.managedByService).toBe(true);
    const ok = consoleDestination({ ...row, verification: 'VERIFIED', verificationError: null, verifiedAt: new Date(), createdByKeyId: null });
    expect(ok.verificationError).toBeNull();
    expect(ok.verificationFix).toBeNull();
    expect(ok.managedByService).toBe(false);
  });

  it('[CB:T14] không còn `alertOnOpen` trong response (cờ chết — thay bằng luật destination.circuit_open)', () => {
    const v = consoleDestination({ ...row, alertOnOpen: true } as Parameters<typeof consoleDestination>[0]);
    expect(v).not.toHaveProperty('alertOnOpen');
    expect(JSON.stringify(v)).not.toContain('alertOnOpen');
  });

  it('PENDING giữ nguyên (đang chờ challenge)', () => {
    expect(consoleDestination({ ...row, verification: 'PENDING', verificationError: null }).verification).toBe('PENDING');
  });
});
