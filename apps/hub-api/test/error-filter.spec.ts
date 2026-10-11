import { BadRequestException, Body, ConflictException, Controller, Get, Module, Param, Post, Query, UseGuards } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { INestApplication } from '@nestjs/common';
import { ERROR_CATALOG, HubErrorCode, hashApiKey, logger } from '@hub/common';
import { PrismaService } from '@hub/database';
import { installErrorHandling } from '../src/modules/errors/install';
import { hubError } from '../src/modules/errors/hub-error';
import { ApiKeyGuard } from '../src/modules/service-api/api-key.guard';
import { RequireScope } from '../src/modules/service-api/require-scope.decorator';
import { unprocessable } from '../src/modules/service-api/service-api.controller';

/**
 * DX1 (SPEC-dev-experience §2, UX1–UX3, UX5): app Nest THẬT (cùng `installErrorHandling` với main.ts) — filter +
 * middleware x-request-id + ApiKeyGuard thật trên prisma giả.
 */
const KEY_A = 'hk_test_KEYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const KEY_RO = 'hk_test_KEYROOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOO';
const keys: Record<string, any> = {
  [hashApiKey(KEY_A)]: { id: 'ka', tenantId: 'ta', scopes: ['publish:events', 'read:events'], serviceName: 'a', project: { slug: 'cafe' } },
  [hashApiKey(KEY_RO)]: { id: 'kr', tenantId: 'ta', scopes: ['read:events'], serviceName: 'r', project: { slug: 'cafe' } },
};
const fakePrisma = {
  findApiKeyByHash: async (h: string) => keys[h] ?? null,
  forTenant: () => ({ touchApiKeyLastUsed: async () => undefined }),
};

@Controller('v1/p/:project')
@UseGuards(ApiKeyGuard)
class ServiceTestController {
  @Get('throw/:code')
  @RequireScope('read:events')
  throwCode(@Param('code') code: HubErrorCode, @Query() q: Record<string, string>) {
    throw hubError(code, { ...q, limit: q.limit ? Number(q.limit) || q.limit : undefined, retryAfter: q.retryAfter ? Number(q.retryAfter) : undefined });
  }

  @Get('ok')
  @RequireScope('read:events')
  ok() {
    return { ok: true };
  }

  @Post('events')
  @RequireScope('publish:events')
  publish(@Body() body: any) {
    // Lỗi xác thực dữ liệu khi body có secret: body KHÔNG được phản chiếu ra response.
    unprocessable({ error: 'validation_failed', field: 'type', message: 'type khớp ^[a-z0-9_]+(\\.[a-z0-9_]+)+$', echo: body });
  }

  @Get('boom')
  @RequireScope('read:events')
  boom() {
    throw new Error('db down at 10.0.0.5');
  }
}

@Controller('api/v1')
class ConsoleTestController {
  @Get('bad')
  bad() {
    throw new BadRequestException('range phải là \'24h\' hoặc \'7d\'');
  }

  @Get('in-use')
  inUse() {
    throw new ConflictException({ statusCode: 409, error: 'Conflict', code: 'DESTINATION_IN_USE', subscriptionCount: 2, deliveryCount: 7, message: 'Không xoá được đích' });
  }
}

@Controller('hooks')
class HooksTestController {
  @Get('x')
  x() {
    throw new BadRequestException('provider format');
  }
}

@Module({ controllers: [ServiceTestController, ConsoleTestController, HooksTestController], providers: [{ provide: PrismaService, useValue: fakePrisma }, ApiKeyGuard] })
class TestModule {}

describe('[DX] ServiceExceptionFilter + x-request-id (DX1)', () => {
  let app: INestApplication;
  let base = '';
  const get = async (path: string, key?: string, init: RequestInit = {}) => {
    const res = await fetch(`${base}${path}`, { ...init, headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...(init.headers as any) } });
    const text = await res.text();
    return { status: res.status, rid: res.headers.get('x-request-id'), text, body: text ? JSON.parse(text) : undefined };
  };

  let logged: any[] = [];
  beforeAll(async () => {
    // Log của filter: im lặng trong test nhưng vẫn ghi lại để kiểm requestId tra được (TX1).
    jest.spyOn(logger, 'info').mockImplementation(((o: any) => void logged.push(o)) as any);
    jest.spyOn(logger, 'error').mockImplementation(((o: any) => void logged.push(o)) as any);
    app = await NestFactory.create(TestModule, { logger: false, rawBody: true });
    installErrorHandling(app);
    await app.listen(0, '127.0.0.1');
    base = (await app.getUrl()).replace('[::1]', '127.0.0.1');
  });
  afterAll(() => app.close());

  it('[DX:UX1] mỗi mã trong catalog: body đủ error/message/fix/docsUrl/requestId, status khớp catalog, header x-request-id = requestId', async () => {
    for (const code of Object.keys(ERROR_CATALOG) as HubErrorCode[]) {
      const r = await get(`/v1/p/cafe/throw/${code}?required=publish:events&field=type&limit=1MB&retryAfter=30`, KEY_A);
      const def = ERROR_CATALOG[code];
      const expectedStatus = def.status;
      expect([code, r.status]).toEqual([code, expectedStatus]);
      expect(r.body).toMatchObject({ error: code, message: def.message, docsUrl: `docs/ERRORS.md#${code}`, requestId: r.rid });
      expect(typeof r.body.fix).toBe('string');
      expect(r.body.fix.length).toBeGreaterThan(10);
      expect(r.rid).toMatch(/^[0-9a-f-]{36}$/);
      // chỉ tham số khai ở catalog mới ra body
      const allowed = new Set(['error', 'message', 'fix', 'docsUrl', 'requestId', 'detail', ...((def as any).params ?? [])]);
      expect([code, Object.keys(r.body).filter((k) => !allowed.has(k))]).toEqual([code, []]);
    }
  });

  it('[DX:UX1] missing_scope thật từ ApiKeyGuard: 403, required, fix nhắc scope; 2xx cũng có x-request-id; id client gửi đúng khuôn được giữ', async () => {
    const r = await get('/v1/p/cafe/events', KEY_RO, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ error: 'missing_scope', required: 'publish:events' });
    expect(r.body.fix).toContain('publish:events');
    const ok = await get('/v1/p/cafe/ok', KEY_A);
    expect(ok.status).toBe(200);
    expect(ok.rid).toBeTruthy();
    const mine = await get('/v1/p/cafe/ok', KEY_A, { headers: { 'x-request-id': 'my-trace-12345' } });
    expect(mine.rid).toBe('my-trace-12345');
    const evil = await get('/v1/p/cafe/ok', KEY_A, { headers: { 'x-request-id': 'bad id\twith tab' } });
    expect(evil.rid).not.toContain('bad');
  });

  it('[DX:UX2] key project A gọi project B có tồn tại / project không tồn tại -> hai body giống hệt trừ requestId', async () => {
    const a = await get('/v1/p/bookstore/ok', KEY_A);
    const b = await get('/v1/p/khong-ton-tai/ok', KEY_A);
    expect(a.status).toBe(404);
    expect(b.status).toBe(404);
    const strip = (x: any) => ({ ...x, requestId: undefined });
    expect(strip(a.body)).toEqual(strip(b.body));
    expect(a.body.requestId).not.toBe(b.body.requestId);
    expect(a.body).not.toHaveProperty('detail');
  });

  it('[DX:UX3] lỗi 401/403/422 khi header chứa key thật và body chứa "secret":"s3cr3t" -> response không chứa key hay s3cr3t', async () => {
    const body = JSON.stringify({ type: 'BAD', secret: 's3cr3t', data: { password: 's3cr3t' } });
    const h = { 'content-type': 'application/json' };
    const r422 = await get('/v1/p/cafe/events', KEY_A, { method: 'POST', headers: h, body });
    const r403 = await get('/v1/p/cafe/events', KEY_RO, { method: 'POST', headers: h, body });
    const r401 = await get('/v1/p/cafe/events', KEY_A.slice(0, -1) + 'Z', { method: 'POST', headers: h, body });
    expect([r422.status, r403.status, r401.status]).toEqual([422, 403, 401]);
    expect(r401.body.error).toBe('invalid_api_key');
    for (const r of [r422, r403, r401]) {
      expect(r.text).not.toContain('s3cr3t');
      expect(r.text).not.toContain(KEY_A);
      expect(r.text).not.toContain(KEY_RO);
      expect(r.text).not.toContain(KEY_A.slice(8, 30));
    }
    expect(r422.body).toMatchObject({ error: 'validation_failed', field: 'type' });
  });

  it('[DX:UX5] lỗi lạ (Error("db down at 10.0.0.5")) -> 500 internal_error, body không chứa 10.0.0.5', async () => {
    const r = await get('/v1/p/cafe/boom', KEY_A);
    expect(r.status).toBe(500);
    expect(r.body).toMatchObject({ error: 'internal_error', requestId: r.rid });
    expect(r.text).not.toContain('10.0.0.5');
    expect(r.text).not.toContain('db down');
    expect(r.body).not.toHaveProperty('detail');
    // ... nhưng log server có đủ, tra được bằng requestId.
    const line = logged.find((o) => o?.requestId === r.rid);
    expect(line?.err?.message).toBe('db down at 10.0.0.5');
  });

  it('console /api/v1: BadRequestException(câu Việt) -> bad_request + detail (web hiển thị); 409 giữ subscriptionCount/deliveryCount/code', async () => {
    const r = await get('/api/v1/bad');
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ error: 'bad_request', detail: "range phải là '24h' hoặc '7d'", requestId: r.rid });
    const c = await get('/api/v1/in-use');
    expect(c.status).toBe(409);
    expect(c.body).toMatchObject({ error: 'conflict', code: 'DESTINATION_IN_USE', subscriptionCount: 2, deliveryCount: 7, detail: 'Không xoá được đích' });
    expect(c.body).not.toHaveProperty('statusCode');
  });

  it('JSON hỏng -> 400 bad_request (không 500); route không có -> 404 not_found cùng khuôn; /hooks giữ định dạng mặc định, không x-request-id', async () => {
    const bad = await get('/v1/p/cafe/events', KEY_A, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{oops' });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('bad_request');
    const missing = await get('/v1/p/cafe/khong-co-route', KEY_A);
    expect(missing.status).toBe(404);
    expect(missing.body).toMatchObject({ error: 'not_found', requestId: missing.rid });
    const hooks = await get('/hooks/x');
    expect(hooks.status).toBe(400);
    expect(hooks.body).toEqual({ statusCode: 400, message: 'provider format', error: 'Bad Request' });
    expect(hooks.rid).toBeNull();
  });
});
