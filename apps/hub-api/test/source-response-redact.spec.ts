import { ApiController } from '../src/modules/api/api.controller';
import { ServiceResourcesController } from '../src/modules/service-api/service-resources.controller';

/**
 * Review PK4 TB-1 (E13, ADR-205): MỌI response trả source — console list / create / PATCH, service API list / create — không
 * bao giờ chứa `verifyTokenEnc` (ciphertext AES-GCM của token bắt tay) hay `secrets`; thay bằng `verifyTokenSet: true`.
 * Đột biến: bỏ `consoleSource` / `publicVerificationConfig` ở bất kỳ route nào -> đỏ.
 *
 * Chuỗi bí mật sinh lúc chạy (không literal secret).
 */
process.env.MASTER_KEY = process.env.MASTER_KEY || 'test-master-key-at-least-32-characters!!';

const TENANT = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const VERIFY_TOKEN = `vt-${process.pid}-${Date.now()}`;
const SECRET = `app-${process.pid}-${Date.now()}`;
const META_CFG = {
  scheme: 'hmac',
  header: 'x-hub-signature-256',
  prefix: 'sha256=',
  idempotency: { header: 'x-request-id' },
  eventType: 'meta.event',
  handshake: { kind: 'query-echo', param: 'hub.challenge', verifyTokenParam: 'hub.verify_token', verifyToken: VERIFY_TOKEN },
};

function fakeRepo() {
  const rows: any[] = [];
  const repo: any = {
    rows,
    lockAndCountActiveSources: jest.fn(async () => 0),
    createSource: jest.fn(async (data: any) => {
      const { secrets, ...rest } = data;
      const row = { id: `11111111-1111-1111-1111-11111111111${rows.length}`, tenantId: TENANT, createdAt: new Date(0), archivedAt: null, ...rest, secrets: [{ id: 's1', version: 1, ...secrets.create }] };
      rows.push(row);
      return row;
    }),
    findSources: jest.fn(async () => rows),
    updateSource: jest.fn(async (id: string, data: any) => {
      const row = rows.find((r) => r.id === id);
      if (!row) return null;
      Object.assign(row, data);
      return row;
    }),
    createAuditLog: jest.fn(async () => undefined),
  };
  return repo;
}

function build() {
  const repo = fakeRepo();
  const prisma: any = { forTenant: jest.fn(() => repo), tenantTx: jest.fn(async (_t: string, fn: any) => fn({})) };
  const consoleCtrl = new ApiController(prisma);
  (consoleCtrl as any).withAudit = async (_t: string, fn: any) => fn(repo);
  const serviceCtrl = new ServiceResourcesController(prisma, {} as any);
  const userReq: any = { principal: { kind: 'user', id: 'u', scopes: ['manage:sources'] } };
  const keyReq: any = { tenantId: TENANT, apiKey: { id: 'k1', tenantId: TENANT } };
  return { repo, consoleCtrl, serviceCtrl, userReq, keyReq };
}

/** Response không lộ ciphertext token / secret: không có khoá `verifyTokenEnc`, không có giá trị ciphertext nào đã lưu. */
function expectRedacted(label: string, body: unknown, stored: any[]) {
  const json = JSON.stringify(body);
  expect([label, json.includes('verifyTokenEnc')]).toEqual([label, false]);
  expect([label, json.includes('secretEncrypted')]).toEqual([label, false]);
  for (const r of stored) {
    const enc = r.verificationConfig?.handshake?.verifyTokenEnc;
    if (enc) expect([label, json.includes(enc)]).toEqual([label, false]);
    for (const s of r.secrets ?? []) expect([label, json.includes(s.secretEncrypted)]).toEqual([label, false]);
  }
  expect([label, json.includes(VERIFY_TOKEN)]).toEqual([label, false]);
}

describe('[PK:T10] (phần f) review PK4 TB-1: response nguồn không bao giờ trả verifyTokenEnc (console list/create/PATCH + service API list/create)', () => {
  it('console: create -> list -> PATCH (đổi tên, tắt) — cả ba có verifyTokenSet:true, không verifyTokenEnc', async () => {
    const t = build();
    const created: any = await t.consoleCtrl.createSource(TENANT, 'owner', { provider: 'generic', name: 'Meta', secret: SECRET, verificationConfig: META_CFG }, t.userReq);
    // Đã lưu đúng ciphertext (để test có thứ phải giấu).
    expect(typeof t.repo.rows[0].verificationConfig.handshake.verifyTokenEnc).toBe('string');
    expect(created.verificationConfig.handshake).toMatchObject({ kind: 'query-echo', verifyTokenSet: true });
    expect(created.secretVersions).toBe(1);
    expectRedacted('console create', created, t.repo.rows);

    const list: any[] = await t.consoleCtrl.listSources(TENANT);
    expect(list[0].verificationConfig.handshake.verifyTokenSet).toBe(true);
    expectRedacted('console list', list, t.repo.rows);

    for (const patch of [{ name: 'Meta (đổi tên)' }, { isActive: false }]) {
      const updated: any = await t.consoleCtrl.updateSource(TENANT, 'owner', created.id, patch, t.userReq);
      expect(updated.verificationConfig.handshake.verifyTokenSet).toBe(true);
      expect(updated.secretVersions).toBe(1);
      expectRedacted(`console patch ${Object.keys(patch)[0]}`, updated, t.repo.rows);
    }
  });

  it('service API (/v1/p/:project/sources): create + list — verifyTokenSet:true, không verifyTokenEnc', async () => {
    const t = build();
    const created: any = await t.serviceCtrl.createSource(t.keyReq, { provider: 'generic', name: 'Meta', secret: SECRET, verificationConfig: META_CFG });
    expect(created.verificationConfig.handshake.verifyTokenSet).toBe(true);
    expectRedacted('service create', created, t.repo.rows);
    const list: any[] = await t.serviceCtrl.listSources(t.keyReq);
    expect(list[0].verificationConfig.handshake.verifyTokenSet).toBe(true);
    expectRedacted('service list', list, t.repo.rows);
  });

  it('source không có token bắt tay: verificationConfig giữ nguyên, không thêm verifyTokenSet', async () => {
    const t = build();
    const { verifyTokenParam: _p, verifyToken: _v, ...hs } = META_CFG.handshake;
    const created: any = await t.consoleCtrl.createSource(TENANT, 'owner', { provider: 'generic', name: 'Dropbox', secret: SECRET, verificationConfig: { ...META_CFG, handshake: hs } }, t.userReq);
    expect(created.verificationConfig.handshake).toEqual({ kind: 'query-echo', param: 'hub.challenge' });
  });
});
