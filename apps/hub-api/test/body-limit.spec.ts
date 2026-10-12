import { Body, Controller, Module, INestApplication, Post } from '@nestjs/common';
import helmet from 'helmet';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { createHmac } from 'crypto';
import { MAX_API_BODY_BYTES, MAX_INGEST_PAYLOAD_BYTES, RawWebhookRequest } from '@hub/common';
import { GithubAdapter } from '@hub/providers';
import { configureBodyParsers } from '../src/body-parsers';
import { IngestController } from '../src/modules/ingest/ingest.controller';
import { IngestService } from '../src/modules/ingest/ingest.service';
import { installErrorHandling } from '../src/modules/errors/install';
import { corsOptions } from '../src/cors';
import { ingestRequests } from '../src/modules/metrics/metrics';

const ALLOWED_ORIGIN = 'http://console.allowed.test';

/**
 * ADR-162: app Nest THẬT (rawBody:true + configureBodyParsers như main.ts) + IngestController THẬT, IngestService giả
 * ghi lại RawWebhookRequest. Chứng minh body > 100KB (mặc định Express) nhưng ≤ 1MB đi tới ingest với rawBody nguyên
 * byte (HMAC vẫn khớp), cả JSON lẫn form-urlencoded; > 1MB vẫn 413.
 */
const seen: RawWebhookRequest[] = [];
const fakeIngest = {
  ingestWebhook: async (r: RawWebhookRequest) => {
    seen.push(r);
    return { status: 200, body: { ok: true } };
  },
};

/** Route KHÔNG phải /hooks — phải giữ trần 100KB. */
@Controller('other')
class OtherController {
  @Post('echo')
  echo(@Body() b: unknown) {
    return { size: JSON.stringify(b).length };
  }
}

@Module({ controllers: [IngestController, OtherController], providers: [{ provide: IngestService, useValue: fakeIngest }] })
class TestModule {}

async function start(withParsers: boolean): Promise<{ app: INestApplication; base: string }> {
  const app = await NestFactory.create<NestExpressApplication>(TestModule, { logger: false, rawBody: true });
  // Cùng thứ tự với main.ts: helmet -> requestId/filter -> CORS -> body parser (ngay trước listen).
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  installErrorHandling(app);
  app.enableCors(corsOptions({ CORS_ORIGINS: ALLOWED_ORIGIN }));
  if (withParsers) configureBodyParsers(app);
  await app.listen(0, '127.0.0.1');
  return { app, base: (await app.getUrl()).replace('[::1]', '127.0.0.1') };
}

/** Push GitHub cỡ ~`bytes` (nhiều commit dài) — JSON thật, không phải chuỗi đệm. */
function bigPush(bytes: number): string {
  const commits: unknown[] = [];
  const body: any = { ref: 'refs/heads/main', repository: { full_name: 'kien/webhook-hub', html_url: 'https://github.com/kien/webhook-hub' }, sender: { login: 'kien' }, commits };
  let i = 0;
  while (JSON.stringify(body).length < bytes) {
    commits.push({ id: `c${i}`, message: `commit ${i} ` + 'x'.repeat(900), timestamp: '2026-10-10T14:02:37+07:00', url: `https://github.com/kien/webhook-hub/commit/c${i}`, author: { username: 'kien' } });
    i++;
  }
  return JSON.stringify(body);
}

const SECRET = 'gh-secret-body-limit';
const sign = (raw: Buffer) => 'sha256=' + createHmac('sha256', SECRET).update(raw).digest('hex');

describe('[ADR-162] body parser limit = MAX_INGEST_PAYLOAD_BYTES, rawBody giữ nguyên', () => {
  let app: INestApplication;
  let base = '';
  beforeAll(async () => ({ app, base } = await start(true)));
  afterAll(() => app.close());
  beforeEach(() => (seen.length = 0));

  const post = (raw: Buffer, contentType: string, headers: Record<string, string> = {}) =>
    fetch(`${base}/hooks/github/src_x`, { method: 'POST', headers: { 'content-type': contentType, 'x-github-event': 'push', ...headers }, body: new Uint8Array(raw) });

  it('JSON ~300KB (> 100KB mặc định, < 1MB) tới ingest; rawBody đúng từng byte; chữ ký khớp; normalize ra repo.push', async () => {
    const raw = Buffer.from(bigPush(300 * 1024));
    expect(raw.length).toBeGreaterThan(100 * 1024);
    expect(raw.length).toBeLessThan(MAX_INGEST_PAYLOAD_BYTES);
    const res = await post(raw, 'application/json', { 'x-hub-signature-256': sign(raw) });
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(Buffer.isBuffer(seen[0].rawBody)).toBe(true);
    expect(seen[0].rawBody.equals(raw)).toBe(true);
    const a = new GithubAdapter();
    await expect(a.verify(seen[0], [SECRET])).resolves.toBe(true);
    expect(a.normalize(seen[0], { tenantId: 't', sourceId: 's', correlationId: 'c', rawEventId: 'r' })[0].type).toBe('repo.push');
  });

  it('form-urlencoded ~300KB tới ingest; rawBody = bytes gốc; adapter giải payload ra repo.push đủ repo', async () => {
    const raw = Buffer.from(new URLSearchParams({ payload: bigPush(200 * 1024) }).toString());
    expect(raw.length).toBeGreaterThan(100 * 1024);
    const res = await post(raw, 'application/x-www-form-urlencoded', { 'x-hub-signature-256': sign(raw) });
    expect(res.status).toBe(200);
    expect(seen[0].rawBody.equals(raw)).toBe(true);
    expect(typeof (seen[0].body as any).payload).toBe('string');
    const a = new GithubAdapter();
    await expect(a.verify(seen[0], [SECRET])).resolves.toBe(true);
    const e = a.normalize(seen[0], { tenantId: 't', sourceId: 's', correlationId: 'c', rawEventId: 'r' })[0];
    expect(e).toMatchObject({ type: 'repo.push', data: { repo: { fullName: 'kien/webhook-hub' } } });
  });

  const tooLarge = async (provider: string) =>
    ((await ingestRequests.get()).values.find((v) => v.labels.provider === provider && v.labels.outcome === 'TOO_LARGE')?.value ?? 0);

  it('> MAX_INGEST_PAYLOAD_BYTES -> 413, không vào ingest; đếm TOO_LARGE (provider đã đăng ký / lạ -> unknown); vẫn có CORS + helmet', async () => {
    const before = await tooLarge('github');
    const beforeUnknown = await tooLarge('unknown');
    const raw = Buffer.from(bigPush(MAX_INGEST_PAYLOAD_BYTES + 10 * 1024));
    const res = await post(raw, 'application/json', { origin: ALLOWED_ORIGIN });
    expect(res.status).toBe(413);
    expect(res.headers.get('access-control-allow-origin')).toBe(ALLOWED_ORIGIN);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(seen).toHaveLength(0);
    expect(await tooLarge('github')).toBe(before + 1);
    const res2 = await fetch(`${base}/hooks/la-hoac/src_x`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: new Uint8Array(raw) });
    expect(res2.status).toBe(413);
    expect(await tooLarge('unknown')).toBe(beforeUnknown + 1);
  });

  it('JSON hỏng trên /hooks -> 400 vẫn mang header CORS cho origin hợp lệ', async () => {
    const res = await post(Buffer.from('{hong'), 'application/json', { origin: ALLOWED_ORIGIN });
    expect(res.status).toBe(400);
    expect(res.headers.get('access-control-allow-origin')).toBe(ALLOWED_ORIGIN);
    expect(seen).toHaveLength(0);
  });

  it('route KHÔNG phải /hooks giữ trần MAX_API_BODY_BYTES (100KB): ~50KB qua, ~300KB -> 413 (có CORS)', async () => {
    const small = await fetch(`${base}/other/echo`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: bigPush(50 * 1024) });
    expect(small.status).toBe(201);
    const bigBody = bigPush(300 * 1024);
    expect(bigBody.length).toBeGreaterThan(MAX_API_BODY_BYTES);
    const big = await fetch(`${base}/other/echo`, { method: 'POST', headers: { 'content-type': 'application/json', origin: ALLOWED_ORIGIN }, body: bigBody });
    expect(big.status).toBe(413);
    expect(big.headers.get('access-control-allow-origin')).toBe(ALLOWED_ORIGIN);
  });
});

describe('[ADR-162] đối chứng: KHÔNG gọi configureBodyParsers -> mặc định 100KB chặn trước ingest', () => {
  it('JSON ~300KB -> 413, ingest không thấy gì', async () => {
    const { app, base } = await start(false);
    try {
      seen.length = 0;
      const res = await fetch(`${base}/hooks/github/src_x`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: bigPush(300 * 1024) });
      expect(res.status).toBe(413);
      expect(seen).toHaveLength(0);
    } finally {
      await app.close();
    }
  });
});
