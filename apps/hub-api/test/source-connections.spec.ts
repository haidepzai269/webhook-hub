import * as fs from 'fs';
import * as path from 'path';
import { HttpException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { METHOD_METADATA } from '@nestjs/common/constants';
import { testOnlyConfigProblems } from '@hub/common';
import { connectorBaseUrl } from '@hub/providers';
import { ProjectScopeGuard } from '../src/modules/console/project-scope.guard';
import { REQUIRE_SCOPE_KEY } from '../src/modules/service-api/require-scope.decorator';
import { SourceConnectionsController } from '../src/modules/console/source-connections.controller';
import { SourceConnectionService, publicIngestBase } from '../src/modules/console/source-connection.service';

/** KN2 (SPEC-ket-noi §4) — phần không cần DB: lỗi trả TRƯỚC khi chạm DB hay gọi provider. */
const noDb: any = new Proxy({}, { get: () => { throw new Error('không được chạm DB'); } });
const errOf = async (p: Promise<unknown>) => {
  const e = await p.then(() => null, (x) => x);
  expect(e).toBeInstanceOf(HttpException);
  return { status: (e as HttpException).getStatus(), body: (e as HttpException).getResponse() as any };
};

describe('[KN2] kết nối provider — L0', () => {
  it('[KN:U6] provider không có connector (sepay, generic) -> 422 connector_unsupported; không chạm DB', async () => {
    const svc = new SourceConnectionService(noDb, { HUB_PUBLIC_URL: 'https://hub.example.com' });
    for (const provider of ['sepay', 'generic']) {
      const e = await errOf(svc.connect('t', 'user:u', { provider, name: 'x', credentials: {} }));
      expect(e).toEqual({ status: 422, body: expect.objectContaining({ error: 'connector_unsupported', provider }) });
    }
    expect((await errOf(svc.connect('t', 'user:u', { provider: 'nope', name: 'x', credentials: {} }))).body).toMatchObject({ error: 'validation_failed', field: 'provider' });
  });

  it('[KN:U7] HUB_PUBLIC_URL localhost / IP nội bộ / tên một nhãn -> null (422 public_url_required, không gọi provider); URL công khai -> giữ', () => {
    for (const bad of ['http://localhost:4000', 'http://127.0.0.1:4000', 'http://10.0.0.5', 'http://192.168.1.2:4000', 'http://[::1]:4000', 'http://hub-api:4000', 'http://x.localhost', 'http://169.254.169.254', '', 'not a url']) {
      expect([bad, publicIngestBase({ HUB_PUBLIC_URL: bad })]).toEqual([bad, null]);
    }
    expect(publicIngestBase({ HUB_PUBLIC_URL: 'https://hub.example.com/' })).toBe('https://hub.example.com');
    expect(publicIngestBase({ HUB_PUBLIC_URL: 'http://8.8.8.8:4000' })).toBe('http://8.8.8.8:4000');
    // Stack kiểm chứng: CONNECTOR_INGEST_BASE_URL chỉ ngoài production.
    expect(publicIngestBase({ HUB_PUBLIC_URL: 'http://localhost:4000', CONNECTOR_INGEST_BASE_URL: 'http://hub-api:4000' })).toBe('http://hub-api:4000');
    expect(publicIngestBase({ NODE_ENV: 'production', HUB_PUBLIC_URL: 'http://localhost:4000', CONNECTOR_INGEST_BASE_URL: 'http://hub-api:4000' })).toBeNull();
  });

  it('[KN:U12] (phần a) production + *_FAKE_BASE_URL -> app không khởi động; production bỏ qua fake; PAYOS_BASE_URL không đổi được host connector', () => {
    for (const k of ['PAYOS_FAKE_BASE_URL', 'STRIPE_FAKE_BASE_URL', 'GITHUB_FAKE_BASE_URL', 'CONNECTOR_INGEST_BASE_URL']) {
      expect(testOnlyConfigProblems({ NODE_ENV: 'production', [k]: 'http://sink:4100/_fake/x' }).join()).toContain(k);
      expect(testOnlyConfigProblems({ NODE_ENV: 'development', [k]: 'http://sink:4100/_fake/x' })).toEqual([]);
    }
    const spec = { defaultBaseUrl: 'https://api-merchant.payos.vn', fakeBaseUrlEnv: 'PAYOS_FAKE_BASE_URL' };
    expect(connectorBaseUrl(spec, { PAYOS_FAKE_BASE_URL: 'http://sink:4100/_fake/payos/' })).toBe('http://sink:4100/_fake/payos');
    expect(connectorBaseUrl(spec, { NODE_ENV: 'production', PAYOS_FAKE_BASE_URL: 'http://sink:4100/_fake/payos' })).toBe('https://api-merchant.payos.vn');
    expect(connectorBaseUrl(spec, { PAYOS_BASE_URL: 'http://evil.example' })).toBe('https://api-merchant.payos.vn');
  });

  it('[KN:U18] mọi route kết nối khai manage:sources; thành viên viewer -> 403 missing_scope', async () => {
    const routes = Object.getOwnPropertyNames(SourceConnectionsController.prototype).filter(
      (n) => n !== 'constructor' && Reflect.getMetadata(METHOD_METADATA, (SourceConnectionsController.prototype as any)[n]) !== undefined,
    );
    expect(routes.sort()).toEqual(['connect', 'connectExisting', 'connectors', 'deleteCredentials', 'disconnect', 'retry', 'status']);
    for (const r of routes) expect([r, Reflect.getMetadata(REQUIRE_SCOPE_KEY, (SourceConnectionsController.prototype as any)[r])]).toEqual([r, 'manage:sources']);
    const P = '391110c1-3a81-480a-93ab-e11de0be107a';
    const prisma: any = {
      findProjectById: async (id: string) => (id === P ? { id } : null),
      identity: () => ({ findMembershipRole: async () => 'viewer', listMemberships: async () => [] }),
      forTenant: () => ({ createAuditLog: async () => undefined }),
    };
    const guard = new ProjectScopeGuard(prisma, new Reflector());
    for (const r of routes) {
      const handler = (SourceConnectionsController.prototype as any)[r];
      const ctx: any = {
        switchToHttp: () => ({ getRequest: () => ({ query: { projectId: P }, params: {}, principal: { kind: 'user', id: 'u1', sessionId: 's', email: 'a@b.vn', isOperator: false, emailVerified: true } }) }),
        getHandler: () => handler,
        getClass: () => SourceConnectionsController,
      };
      const e = await errOf(guard.canActivate(ctx) as Promise<boolean>);
      expect([r, e.status, e.body.error, e.body.required]).toEqual([r, 403, 'missing_scope', 'manage:sources']);
    }
  });

  it('[KN2] gate P-KN1: lõi kết nối không rẽ nhánh theo provider (`provider === …`, `switch (provider)`, tên provider dạng chuỗi)', () => {
    const dir = path.join(__dirname, '..', 'src', 'modules', 'console');
    const core = ['source-connection.service.ts', 'source-connections.controller.ts', 'endpoints.controller.ts'];
    const bad: string[] = [];
    for (const f of core) {
      fs.readFileSync(path.join(dir, f), 'utf8').split(/\r?\n/).forEach((line, i) => {
        if (/provider\s*[!=]==?\s*['"`]|switch\s*\(\s*[\w.]*provider|['"`](payos|stripe|github|sepay)['"`]/.test(line)) bad.push(`${f}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(bad).toEqual([]);
  });
});
