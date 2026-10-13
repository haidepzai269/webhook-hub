import { Body, Controller, Module, INestApplication, Post } from '@nestjs/common';
import helmet from 'helmet';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { createHmac } from 'crypto';
import { MAX_API_BODY_BYTES, MAX_INGEST_PAYLOAD_BYTES, RawWebhookRequest } from '@hub/common';
import { GithubAdapter } from '@hub/providers';
import { configureBodyParsers, HOOKS_NOT_FOUND_FIX, installHooksPathGuard } from '../src/body-parsers';
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
  if (withParsers) {
    installHooksPathGuard(app); // như main.ts: guard /hooks ở gốc, trước gate + body parser
    configureBodyParsers(app);
  }
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

  it('[EG:T10] (phần f) review EG1 lượt 3 (TB-2), lớp hub-api: `/HOOKS/…`, `/Hooks/…` (express khớp không phân biệt hoa thường) -> 404 not_found khuôn ERRORS.md, KHÔNG vào ingest; `/hooks/…` chữ thường vẫn vào', async () => {
    for (const p of ['/HOOKS/github/src_x', '/Hooks/github/src_x', '/hOoKs/github/src_x?x=1']) {
      const res = await fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-github-event': 'push', 'x-request-id': 'rid-case-test-1' }, body: '{}' });
      const body = await res.json();
      expect([p, res.status, body.error, body.requestId, body.fix, body.docsUrl]).toEqual([p, 404, 'not_found', 'rid-case-test-1', HOOKS_NOT_FOUND_FIX, 'docs/ERRORS.md#not_found']);
    }
    expect(seen).toHaveLength(0);
    const ok = await post(Buffer.from('{}'), 'application/json');
    expect(ok.status).toBe(200);
    expect(seen).toHaveLength(1);
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

/**
 * PK0 / E1 (SPEC-provider-khac ĐÍNH CHÍNH, ADR-201): `/hooks/*` giữ bytes gốc với MỌI content-type. Trước PK0 chỉ có parser
 * json/urlencoded, controller dựng lại body bằng `JSON.stringify(req.body || {})` -> SNS (text/plain), WebSub (XML),
 * Wix (JWT), Auth0 (JSON lines), Google Drive (body rỗng) đều thành `"{}"`. E6: controller điền `method` + `query` thô.
 */
describe('[PK:T33] /hooks giữ rawBody đúng từng byte với mọi content-type', () => {
  let app: INestApplication;
  let base = '';
  beforeAll(async () => ({ app, base } = await start(true)));
  afterAll(() => app.close());
  beforeEach(() => (seen.length = 0));

  const send = (path: string, raw: Buffer | null, contentType?: string) =>
    fetch(`${base}${path}`, { method: 'POST', headers: contentType ? { 'content-type': contentType } : {}, body: raw === null ? undefined : new Uint8Array(raw) });

  const SNS = Buffer.from(JSON.stringify({ Type: 'Notification', MessageId: 'm-1', Message: 'xin chào', Signature: 'abc==' }));
  const XML = Buffer.from('<?xml version="1.0" encoding="utf-8"?><feed xmlns="http://www.w3.org/2005/Atom"><entry><id>yt:video:1</id></entry></feed>');
  // JWT giả dựng lúc chạy (không để literal dạng JWT trong source — gitleaks rule `jwt`).
  const b64url = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
  const JWT = Buffer.from([b64url({ alg: 'RS256' }), b64url({ data: '{"id":1}' }), 'c2lnbmF0dXJl'].join('.'));
  const JSONL = Buffer.from('{"log_id":"1","type":"s"}\n{"log_id":"2","type":"f"}\n');
  const BIN = Buffer.from([0x00, 0xff, 0xfe, 0x80, 0x0a, 0x7b, 0xc3, 0x28]); // UTF-8 hỏng: phải giữ nguyên, không decode

  const cases: [string, Buffer, string][] = [
    ['SNS text/plain', SNS, 'text/plain; charset=UTF-8'],
    ['WebSub XML', XML, 'application/atom+xml'],
    ['Wix JWT', JWT, 'text/plain'],
    ['JWT application/jwt', JWT, 'application/jwt'],
    ['bytes nhị phân octet-stream', BIN, 'application/octet-stream'],
    ['content-type lạ', SNS, 'application/x-hoan-toan-la'],
  ];
  it.each(cases)('%s -> vào ingest, rawBody đúng từng byte, body không phải Buffer', async (_n, raw, ct) => {
    const res = await send('/hooks/generic/src_raw', raw, ct);
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(Buffer.isBuffer(seen[0].rawBody)).toBe(true);
    expect(seen[0].rawBody.equals(raw)).toBe(true);
    expect(Buffer.isBuffer(seen[0].body)).toBe(false);
    expect(seen[0].contentType).toBe(ct);
  });

  it('không có content-type -> vẫn giữ bytes gốc', async () => {
    const res = await fetch(`${base}/hooks/generic/src_raw`, { method: 'POST', body: new Uint8Array(XML) }); // Uint8Array: fetch không tự gắn content-type
    expect(res.status).toBe(200);
    expect(seen[0].rawBody.equals(XML)).toBe(true);
  });

  it('JSON lines gắn application/json ở /hooks/generic/* -> KHÔNG 400 ở parser: vào ingest, body = null, bytes giữ nguyên', async () => {
    const res = await send('/hooks/generic/src_raw', JSONL, 'application/json');
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0].rawBody.equals(JSONL)).toBe(true);
    expect(seen[0].body).toBeNull();
  });

  it('JSON hỏng ở provider native (/hooks/github/*) giữ hợp đồng cũ: 400 ở parser, ingest không chạy', async () => {
    const res = await send('/hooks/github/src_raw', JSONL, 'application/json');
    expect(res.status).toBe(400);
    expect(seen).toHaveLength(0);
  });

  it('body rỗng (Google Drive) -> rawBody là Buffer rỗng (không còn "{}")', async () => {
    for (const ct of [undefined, 'application/json', 'text/plain']) {
      seen.length = 0;
      const res = await send('/hooks/generic/src_raw', null, ct);
      expect(res.status).toBe(200);
      expect(Buffer.isBuffer(seen[0].rawBody)).toBe(true);
      expect(seen[0].rawBody.length).toBe(0);
    }
  });

  it('JSON và form vẫn parse như cũ (đối chứng) và giữ bytes', async () => {
    const json = Buffer.from('{"a":{"b":1}}');
    await send('/hooks/generic/src_raw', json, 'application/json');
    expect(seen[0].body).toEqual({ a: { b: 1 } });
    expect(seen[0].rawBody.equals(json)).toBe(true);
    const form = Buffer.from('a%5Bb%5D=1&c=%20x');
    await send('/hooks/generic/src_raw', form, 'application/x-www-form-urlencoded');
    expect(seen[1].body).toEqual({ a: { b: '1' }, c: ' x' });
    expect(seen[1].rawBody.equals(form)).toBe(true);
  });

  it('content-type lạ quá MAX_INGEST_PAYLOAD_BYTES -> 413 trước ingest (parser raw cùng trần)', async () => {
    const res = await send('/hooks/generic/src_raw', Buffer.alloc(MAX_INGEST_PAYLOAD_BYTES + 1, 0x61), 'text/plain');
    expect(res.status).toBe(413);
    expect(seen).toHaveLength(0);
  });

  it('E6: RawWebhookRequest mang method và query thô (chuỗi sau `?`, chưa decode; không có thì rỗng)', async () => {
    await send('/hooks/generic/src_raw?hub.mode=subscribe&hub.challenge=a%20b&x', Buffer.from('{}'), 'application/json');
    await send('/hooks/generic/src_raw', Buffer.from('{}'), 'application/json');
    expect([seen[0].method, seen[0].query]).toEqual(['POST', 'hub.mode=subscribe&hub.challenge=a%20b&x']);
    expect([seen[1].method, seen[1].query]).toEqual(['POST', '']);
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
