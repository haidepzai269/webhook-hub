import { randomUUID } from 'crypto';
import { Writable } from 'stream';
import pino from 'pino';
import { HttpException } from '@nestjs/common';
import { PrismaService, getMasterKey } from '@hub/database';
import { aesGcmDecrypt } from '@hub/crypto';
import { LOG_REDACT_OPTIONS, logger } from '@hub/common';
import { ConnectorError, ProviderConnector, ProviderRegistry } from '@hub/providers';
import { SourceConnectionService } from '../src/modules/console/source-connection.service';
import { redactSecrets } from '../src/modules/api/redact-secrets.interceptor';
import { ApiController } from '../src/modules/api/api.controller';
import { describeDb, newTestPrisma } from '../../../libs/database/test/support/test-db';

/**
 * KN2 (SPEC-ket-noi §4.2–4.4, §8.1) trên Postgres THẬT, code chạy bằng DATABASE_URL (hub_app, RLS). Connector là bản
 * giả gắn tạm vào adapter `github` (KN5 chưa làm nên github không có connector thật) — thứ cần chứng minh ở đây là
 * khung chung: thứ tự commit, lưu/redact credentials, retry, xoá credentials, cô lập project.
 */
describeDb('[KN2] khung connector (Postgres)', () => {
  const raw = newTestPrisma('owner');
  const svc = new PrismaService();
  const tenant = randomUUID();
  const other = randomUUID();
  const env = { HUB_PUBLIC_URL: 'https://hub.example.com' };
  const conn = new SourceConnectionService(svc, env);
  const SECRET = { token: `ghp_TOKENVALUE_${randomUUID()}`, signingSecret: `SIGNINGVALUE_${randomUUID()}`, owner: 'acme' };
  const during: any[] = [];
  let behaviour: 'ok' | 'fail' = 'ok';
  const calls: any[] = [];
  const stub: ProviderConnector = {
    spec: {
      fields: [
        { name: 'token', label: 'Token', secret: true, help: '' },
        { name: 'signingSecret', label: 'Signing secret', secret: true, help: '' },
        { name: 'owner', label: 'Owner', secret: false, help: '' },
      ],
      sourceSecretField: 'signingSecret',
      keyHint: 'test',
      defaultBaseUrl: 'https://api.example.test',
      fakeBaseUrlEnv: 'KNTEST_FAKE_BASE_URL',
    },
    connect: async (input) => {
      calls.push(input);
      // Như provider thật: gọi vào ingest NGAY lúc đăng ký. Ingest tra source bằng đúng lối thoát của nó (kết nối khác).
      const key = input.ingestUrl.split('/').pop()!;
      const s = await svc.findSourceBySourceKeyForIngest(key);
      during.push({ found: !!s, secrets: (s?.secrets ?? []).map((x: any) => aesGcmDecrypt(x.secretEncrypted, getMasterKey())) });
      if (behaviour === 'fail') throw new ConnectorError('invalid_credentials', 'Kiểm lại token ở dashboard provider.');
      return { remoteRef: 'hook_42', display: 'acme/demo · hook 42' };
    },
  };
  const gh = ProviderRegistry.get('github') as any;
  const errOf = async (p: Promise<unknown>) => {
    const e = await p.then(() => null, (x) => x);
    expect(e).toBeInstanceOf(HttpException);
    return { status: (e as HttpException).getStatus(), body: JSON.stringify((e as HttpException).getResponse()) };
  };

  beforeAll(() => {
    gh.connector = stub;
  });
  afterAll(async () => {
    delete gh.connector;
    for (const t of [tenant, other]) {
      await raw.auditLog.deleteMany({ where: { tenantId: t } });
      await raw.source.deleteMany({ where: { tenantId: t } });
    }
    await raw.$disconnect();
    await svc.$disconnect();
  });

  let sourceId = '';

  it('[KN:U8] (phần a) Source + SourceSecret COMMIT trước lời gọi provider: lúc provider gọi ingest, ingest đã thấy source và secret ký', async () => {
    behaviour = 'ok';
    during.length = 0;
    const r: any = await conn.connect(tenant, 'user:u1', { provider: 'github', name: 'repo hooks', credentials: SECRET });
    sourceId = r.source.id;
    // MỌI lần provider gọi vào (kể cả lần sớm nhất) đều thấy source + secret đã COMMIT.
    expect(during.length).toBeGreaterThan(0);
    for (const d of during) expect(d).toEqual({ found: true, secrets: [SECRET.signingSecret] });
    expect(r.connection).toMatchObject({ status: 'CONNECTED', display: 'acme/demo · hook 42', ingestUrl: `https://hub.example.com/hooks/github/${r.source.sourceKey}` });
    expect(calls.at(-1)).toMatchObject({ ingestUrl: r.connection.ingestUrl, secretForSource: SECRET.signingSecret, baseUrl: 'https://api.example.test', credentials: SECRET });
  });

  it('[KN:U9] provider lỗi -> FAILED + fix, source GIỮ LẠI; retry thành công mà không phải nhập lại', async () => {
    behaviour = 'fail';
    const r: any = await conn.connect(tenant, 'user:u1', { provider: 'github', name: 'retry me', credentials: SECRET });
    expect(r.connection).toMatchObject({ status: 'FAILED', lastError: 'invalid_credentials', fix: 'Kiểm lại token ở dashboard provider.' });
    expect(await raw.source.count({ where: { id: r.source.id } })).toBe(1);
    behaviour = 'ok';
    const n = calls.length;
    const again: any = await conn.retry(tenant, 'user:u1', r.source.id, {});
    expect(again.connection).toMatchObject({ status: 'CONNECTED', lastError: null, fix: null });
    expect(calls.length).toBe(n + 1);
    expect(calls.at(-1).credentials).toEqual(SECRET); // credentials đã lưu, không nhập lại
  });

  it('[KN:U10] credentials_encrypted không chứa plaintext; không response nào (GET source/connection, connect, retry) trả credentials', async () => {
    const rows: any[] = await raw.$queryRawUnsafe(`SELECT * FROM hub.source_connections WHERE tenant_id = '${tenant}'::uuid`);
    expect(rows.length).toBeGreaterThan(0);
    const dump = JSON.stringify(rows);
    for (const v of [SECRET.token, SECRET.signingSecret]) expect(dump).not.toContain(v);
    const responses = [
      await conn.status(tenant, sourceId),
      await conn.retry(tenant, 'user:u1', sourceId, {}),
      await new ApiController(svc).listSources(tenant),
      conn.listConnectors(),
    ].map((x) => JSON.stringify(redactSecrets(x)));
    for (const body of responses) {
      for (const v of [SECRET.token, SECRET.signingSecret]) expect(body).not.toContain(v);
      expect(body).not.toContain('credentialsEncrypted');
    }
    const st: any = await conn.status(tenant, sourceId);
    expect(st.hasCredentials).toBe(true);
    expect(st.credentialHints).toEqual({ token: `****${SECRET.token.slice(-4)}`, signingSecret: `****${SECRET.signingSecret.slice(-4)}` });
    // Lưới thứ hai (L-6): bản ghi THẬT mà hub_app đọc (đúng hình dạng một route lỡ trả thẳng row Prisma) qua interceptor
    // -> ciphertext thành cờ, không còn khoá/giá trị mã hoá.
    const row: any = await svc.forTenant(tenant).findSourceConnection(sourceId);
    expect(row.credentialsEncrypted).toBeTruthy();
    const netted = redactSecrets(row) as any;
    expect(netted).toMatchObject({ hasCredentials: true });
    expect(JSON.stringify(netted)).not.toContain(row.credentialsEncrypted);
    expect(redactSecrets({ credentialsEncrypted: 'v1:abc' })).toEqual({ hasCredentials: true });
  });

  it('[KN:U11] log (pino) và audit_logs.metadata không chứa giá trị credentials', async () => {
    const seen: string[] = [];
    const spies = (['info', 'warn', 'error', 'debug'] as const).map((m) => jest.spyOn(logger, m).mockImplementation(((...a: unknown[]) => void seen.push(JSON.stringify(a))) as any));
    try {
      behaviour = 'fail';
      await conn.connect(tenant, 'user:u1', { provider: 'github', name: 'log check', credentials: SECRET });
      behaviour = 'ok';
      await conn.retry(tenant, 'user:u1', sourceId, { credentials: SECRET });
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
    expect(seen.length).toBeGreaterThan(0);
    for (const v of [SECRET.token, SECRET.signingSecret]) expect(seen.join('\n')).not.toContain(v);
    const audits = await raw.auditLog.findMany({ where: { tenantId: tenant } });
    const meta = JSON.stringify(audits.map((a) => [a.action, a.metadata]));
    for (const v of [SECRET.token, SECRET.signingSecret]) expect(meta).not.toContain(v);
    expect(audits.map((a) => a.action)).toEqual(expect.arrayContaining(['source.create', 'source.connect', 'source.reconnect']));
    expect(meta).toContain('"fields":["token","signingSecret","owner"]');
    // Lưới pino: lỡ ai log nguyên credentials thì khoá bị che.
    const lines: string[] = [];
    const log = pino({ redact: LOG_REDACT_OPTIONS }, new Writable({ write: (c, _e, cb) => (lines.push(String(c)), cb()) }));
    log.warn({ credentials: { apiKey: 'AK_SECRET_1', checksumKey: 'CK_SECRET_2' }, body: { apiKey: 'AK_SECRET_3', secretKey: 'SK_SECRET_4', clientId: 'CID_5' } }, 'x');
    for (const v of ['AK_SECRET_1', 'CK_SECRET_2', 'AK_SECRET_3', 'SK_SECRET_4', 'CID_5']) expect(lines.join()).not.toContain(v);
  });

  it('[KN:U17] xoá credentials -> cột null, status giữ nguyên, source còn; retry không gửi credentials -> 422 credentials_required', async () => {
    const before = await raw.sourceConnection.findUniqueOrThrow({ where: { sourceId } });
    const r: any = await conn.deleteCredentials(tenant, 'user:u1', sourceId);
    expect(r.connection).toMatchObject({ hasCredentials: false, credentialHints: {}, status: before.status });
    const after = await raw.sourceConnection.findUniqueOrThrow({ where: { sourceId } });
    expect(after.credentialsEncrypted).toBeNull();
    expect(after.status).toBe(before.status);
    const e = await errOf(conn.retry(tenant, 'user:u1', sourceId, {}));
    expect(e.status).toBe(422);
    expect(e.body).toContain('credentials_required');
    const a = await raw.auditLog.findFirstOrThrow({ where: { tenantId: tenant, action: 'source.credentials_delete', entityId: sourceId } });
    expect(a.metadata).toMatchObject({ fields: ['token', 'signingSecret', 'owner'] });
  });

  it('[KN2] project khác: mọi thao tác trên kết nối -> 404 GIỐNG HỆT id lạ (A2); RLS: hub_app không thấy kết nối của project khác', async () => {
    const ops = (id: string) => [
      conn.status(other, id),
      conn.retry(other, 'user:x', id, {}),
      conn.disconnect(other, 'user:x', id),
      conn.deleteCredentials(other, 'user:x', id),
    ];
    const cross = await Promise.all(ops(sourceId).map(errOf));
    const missing = await Promise.all(ops(randomUUID()).map(errOf));
    expect(cross).toEqual(missing);
    cross.forEach((c) => expect(c.status).toBe(404));
    expect(await svc.forTenant(other).findSourceConnection(sourceId)).toBeNull();
  });

  it('[KN2] ngắt kết nối: connector không có disconnect -> DISCONNECTED + hướng dẫn ngắt tay; audit source.disconnect', async () => {
    const r: any = await conn.disconnect(tenant, 'user:u1', sourceId);
    expect(r).toMatchObject({ remoteDeleted: false, connection: { status: 'DISCONNECTED' } });
    expect(await raw.auditLog.count({ where: { tenantId: tenant, action: 'source.disconnect', entityId: sourceId } })).toBe(1);
  });
});
