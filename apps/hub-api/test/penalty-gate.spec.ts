import { INestApplication, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import { request as httpRequest } from 'http';
import { PrismaService } from '@hub/database';
import { configureBodyParsers, HOOKS_NOT_FOUND_FIX, installHooksPathGuard } from '../src/body-parsers';
import { readFileSync } from 'fs';
import { join } from 'path';
import { corsOptions } from '../src/cors';
import { installErrorHandling } from '../src/modules/errors/install';
import { IngestController } from '../src/modules/ingest/ingest.controller';
import { IngestService } from '../src/modules/ingest/ingest.service';
import { PenaltyBox } from '../src/modules/ingest/penalty-box';
import { createPenaltyGate, installPenaltyGate, parseHookPath } from '../src/modules/ingest/penalty-gate';
import { PENALTY_BOX_PROVIDER } from '../src/modules/ingest/penalty-provider';
import { apiRegistry } from '../src/modules/metrics/metrics';
import { RedisService } from '../src/modules/redis/redis.service';

/**
 * D3 (SPEC-chong-qua-tai ĐÍNH CHÍNH D3/D4, ADR-177): gate hộp phạt TRƯỚC body parser. App Nest THẬT, cùng thứ tự với
 * main.ts (trust proxy -> helmet -> installErrorHandling -> CORS -> gate -> body parser); IngestController + IngestService
 * THẬT, Prisma/Redis giả (source không tồn tại). 0 Redis, 0 DB.
 */
const fakePrisma: any = {
  findSourceBySourceKeyForIngest: jest.fn(async () => null),
  forTenant: () => ({ addIngestDuplicates: async () => undefined, addSourceTraffic: async () => undefined }),
};
const fakeRedis: any = { checkRateLimit: jest.fn(async () => true), getIdempotencyKey: jest.fn(async () => null), setIdempotencyKey: jest.fn() };

@Module({
  controllers: [IngestController],
  providers: [IngestService, PENALTY_BOX_PROVIDER, { provide: PrismaService, useValue: fakePrisma }, { provide: RedisService, useValue: fakeRedis }],
})
class GateTestModule {}

async function start(): Promise<{ app: INestApplication; port: number }> {
  const app = await NestFactory.create<NestExpressApplication>(GateTestModule, { logger: false, rawBody: true });
  app.set('trust proxy', 1); // như TRUST_PROXY=1: X-Forwarded-For -> req.ip công khai (127.0.0.1 là private, không bị phạt)
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  installErrorHandling(app);
  app.enableCors(corsOptions({ CORS_ORIGINS: 'http://console.allowed.test' }));
  installHooksPathGuard(app); // như main.ts: TRƯỚC gate (EG1 + D3 gộp)
  installPenaltyGate(app);
  configureBodyParsers(app);
  await app.listen(0, '127.0.0.1');
  const port = Number(new URL(await app.getUrl()).port);
  return { app, port };
}

type RawResult = { status: number; headers: Record<string, string | string[] | undefined>; body: any; bytesSent: number };

/**
 * POST khai báo `Content-Length: declared` nhưng CHỈ gửi `send` byte rồi chờ phản hồi. Có phản hồi khi body còn thiếu
 * = server không đọc body (body parser sẽ treo chờ đủ byte).
 */
function rawPost(port: number, path: string, ip: string, declared: number, send: number, method = 'POST'): Promise<RawResult> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: '127.0.0.1',
      port,
      method,
      path,
      headers: { 'content-type': 'application/json', 'content-length': String(declared), 'x-forwarded-for': ip, 'x-github-event': 'push' },
    });
    let done = false;
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        req.destroy();
        reject(new Error('không có phản hồi — server đang chờ body'));
      }
    }, 5_000);
    req.on('response', (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        const text = Buffer.concat(chunks).toString('utf8');
        let body: any = text;
        try {
          body = JSON.parse(text);
        } catch {
          /* giữ chuỗi */
        }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body, bytesSent: send });
        req.destroy();
      });
    });
    req.on('error', (err) => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        reject(err);
      }
    });
    const buf = Buffer.alloc(send, 0x20);
    if (send >= declared) {
      buf[0] = 0x7b; // body đủ -> JSON hợp lệ `{ ... }`
      buf[send - 1] = 0x7d;
    }
    req.write(buf);
    if (send >= declared) req.end();
  });
}

const metric = async (re: RegExp) => Number(re.exec(await apiRegistry.metrics())?.[1] ?? 0);
const blockedGithub = () => metric(/hub_ingest_requests_total\{provider="github",outcome="BLOCKED"(?:,cause="[a-z_.]*")?\} (\d+)/);
const penaltyBlockedIp = () => metric(/hub_ingest_penalty_blocked_total\{reason="unknown_source"\} (\d+)/);

describe('[EG:T19] (phần a) D3 gate hộp phạt trước body parser', () => {
  let app: INestApplication;
  let port = 0;
  let box: PenaltyBox;
  let svc: IngestService;
  let ingestSpy: jest.SpyInstance;
  const BANNED = '203.0.113.50';

  beforeAll(async () => {
    ({ app, port } = await start());
    box = app.get(PenaltyBox);
    svc = app.get(IngestService);
    for (let i = 0; i < 20; i++) box.recordUnknownSource(BANNED); // luật (a), ngưỡng mặc định 20
  });
  afterAll(() => app.close());
  beforeEach(() => {
    ingestSpy = jest.spyOn(svc, 'ingestWebhook');
  });
  afterEach(() => jest.restoreAllMocks());

  it('PenaltyBox là MỘT instance dùng chung: app.get(PenaltyBox) === IngestService.penalty', () => {
    expect(box).toBeInstanceOf(PenaltyBox);
    expect(svc.penalty).toBe(box);
  });

  it('body 1MB từ IP bị ban -> 429 ip_temporarily_blocked + Retry-After + Connection: close, KHÔNG đọc body, ingest không chạy, BLOCKED đếm đúng 1', async () => {
    const before = await blockedGithub();
    const beforeHook = await penaltyBlockedIp();
    const r = await rawPost(port, '/hooks/github/src_gate', BANNED, 1024 * 1024, 16 * 1024); // gửi 16KB / 1MB rồi chờ
    expect(r.bytesSent).toBeLessThan(1024 * 1024);
    expect(r.status).toBe(429);
    expect(r.headers.connection).toBe('close');
    expect(Number(r.headers['retry-after'])).toBeGreaterThan(0);
    expect(r.body).toMatchObject({ error: 'ip_temporarily_blocked', docsUrl: expect.any(String), fix: expect.any(String), retryAfter: expect.any(Number) });
    expect(typeof r.body.requestId).toBe('string');
    expect(ingestSpy).not.toHaveBeenCalled();
    expect(fakePrisma.findSourceBySourceKeyForIngest).not.toHaveBeenCalled();
    expect(await blockedGithub()).toBe(before + 1);
    expect(await penaltyBlockedIp()).toBe(beforeHook + 1);
  });

  it('[PK:T2] (phần a) IP trong hộp phạt gửi GET (và HEAD/PUT/DELETE/PATCH) /hooks/generic/<key> -> 429 ở gate TRƯỚC body parser, giống hệt POST; OPTIONS đi qua', async () => {
    const blockedGeneric = () => metric(/hub_ingest_requests_total\{provider="generic",outcome="BLOCKED"(?:,cause="[a-z_.]*")?\} (\d+)/);
    const before = await blockedGeneric();
    for (const method of ['GET', 'PUT', 'DELETE', 'PATCH']) {
      const r = await rawPost(port, '/hooks/generic/src_gate_get', BANNED, 1024 * 1024, 16 * 1024, method); // body chưa gửi đủ
      expect([method, r.status, r.headers.connection, r.body.error]).toEqual([method, 429, 'close', 'ip_temporarily_blocked']);
      expect(Number(r.headers['retry-after'])).toBeGreaterThan(0);
    }
    const head = await rawPost(port, '/hooks/generic/src_gate_get', BANNED, 0, 0, 'HEAD');
    expect([head.status, head.headers.connection]).toEqual([429, 'close']);
    expect(ingestSpy).not.toHaveBeenCalled();
    expect(fakePrisma.findSourceBySourceKeyForIngest).not.toHaveBeenCalled();
    expect(await blockedGeneric()).toBe(before + 5);
    // OPTIONS (preflight CORS) không qua gate — không bị 429
    const opt = await rawPost(port, '/hooks/generic/src_gate_get', BANNED, 0, 0, 'OPTIONS');
    expect(opt.status).not.toBe(429);
  });

  it('cặp đang bị phạt (luật b) chặn ở gate; lưu lượng BLOCKED ghi cho đúng source như ingest', async () => {
    const ip = '198.51.100.40';
    for (let i = 0; i < 30; i++) box.recordBadSignature(ip, 'src_pair', { tenantId: 'tenant-p', sourceId: 'source-p' });
    const rec = jest.spyOn(svc.traffic, 'record');
    const r = await rawPost(port, '/hooks/github/src_pair', ip, 512 * 1024, 1024);
    expect(r.status).toBe(429);
    expect(ingestSpy).not.toHaveBeenCalled();
    expect(rec).toHaveBeenCalledTimes(1);
    expect(rec).toHaveBeenCalledWith('tenant-p', 'source-p', 'BLOCKED', ip);
    // cùng IP, source khác -> không bị chặn ở gate (luật b theo cặp) -> tới ingest
    const other = await rawPost(port, '/hooks/github/src_other', ip, 2, 2);
    expect(other.status).toBe(404);
    expect(ingestSpy).toHaveBeenCalledTimes(1);
  });

  it('fail-open: hộp phạt ném lỗi ở gate -> request đi tiếp tới ingest như chưa có gate', async () => {
    jest.spyOn(box, 'checkIp').mockImplementation(() => {
      throw new Error('hộp phạt hỏng');
    });
    const r = await rawPost(port, '/hooks/github/src_failopen', '198.51.100.41', 2, 2);
    expect(r.status).toBe(404); // ingest chạy (penaltySafe cũng fail-open), source không tồn tại
    expect(ingestSpy).toHaveBeenCalledTimes(1);
  });

  it('path router không giao cho ingest thì gate cho qua; sourceKey lạ vẫn bị gate chặn (luật a); percent-encoding decode như @Param', async () => {
    const odd = await rawPost(port, '/hooks/github/bad.key', BANNED, 1024 * 1024, 1024); // R6: không lọc khuôn sourceKey
    expect(odd.status).toBe(429);
    expect(ingestSpy).not.toHaveBeenCalled();
    const r = await rawPost(port, '/hooks/github/a/b', BANNED, 2, 2); // 3 đoạn: router không khớp route -> 404 của Nest
    expect(r.status).toBe(404);
    expect(ingestSpy).not.toHaveBeenCalled();
    const enc = await rawPost(port, '/hooks/github/src%5Fgate', BANNED, 1024 * 1024, 1024); // = src_gate
    expect(enc.status).toBe(429);
    expect(enc.headers.connection).toBe('close');
    expect(ingestSpy).not.toHaveBeenCalled();
  });

  // Review lượt 6, TB-1: gate phải thấy path GIỐNG router (parseurl().pathname) — không né được bằng #fragment,
  // absolute-form hay provider viết hoa (router Express 5 không phân biệt hoa thường).
  for (const [name, path] of [
    ['#fragment', '/hooks/github/src_gate#x'],
    ['absolute-form', 'http://hub.test/hooks/github/src_gate'],
    ['provider viết hoa', '/hooks/GitHub/src_gate'],
  ] as const) {
    it(`TB-1 (R6): ${name} — IP bị ban vẫn 429 ở gate khi mới gửi 16KB / 1MB, ingest không chạy`, async () => {
      const r = await rawPost(port, path, BANNED, 1024 * 1024, 16 * 1024);
      expect(r.status).toBe(429);
      expect(r.headers.connection).toBe('close');
      expect(r.body).toMatchObject({ error: 'ip_temporarily_blocked' });
      expect(ingestSpy).not.toHaveBeenCalled();
    });
  }

  it('parseHookPath khớp như Express/Nest; route cấu hình được', () => {
    expect(parseHookPath('/hooks/github/src_x')).toEqual({ provider: 'github', sourceKey: 'src_x' });
    expect(parseHookPath('/hooks/github/src_x?a=1')).toEqual({ provider: 'github', sourceKey: 'src_x' });
    expect(parseHookPath('/HOOKS/payos/k-1/')).toEqual({ provider: 'payos', sourceKey: 'k-1' });
    expect(parseHookPath('/hooks/github/src%5Fx')).toEqual({ provider: 'github', sourceKey: 'src_x' });
    // R6 TB-1: cùng pathname với router (parseurl) — #frag, absolute-form; không lọc provider / khuôn sourceKey
    expect(parseHookPath('/hooks/github/src_x#frag')).toEqual({ provider: 'github', sourceKey: 'src_x' });
    expect(parseHookPath('http://h/hooks/github/src_x?a=1')).toEqual({ provider: 'github', sourceKey: 'src_x' });
    expect(parseHookPath('/hooks/GitHub/k')).toEqual({ provider: 'GitHub', sourceKey: 'k' });
    expect(parseHookPath('/hooks/github/a%2Fb')).toEqual({ provider: 'github', sourceKey: 'a/b' });
    expect(parseHookPath('/hooks/github/' + 'a'.repeat(65))).toEqual({ provider: 'github', sourceKey: 'a'.repeat(65) });
    for (const p of ['/hooksx/github/k', '/hooks/github', '/hooks/github/a/b', '/hooks/github/%E0%A4%A', '/v1/p/x/events', '//hooks/github/k', '/hooks//github/k', '/hooks/github//k', '/hooks%2Fgithub/k']) {
      expect([p, parseHookPath(p)]).toEqual([p, null]);
    }
    expect(parseHookPath('/in/github/k', ['/in'])).toEqual({ provider: 'github', sourceKey: 'k' });
    expect(parseHookPath('/hooks/github/k', ['/in'])).toBeNull();
    // route lồng nhau: route đầu sai số đoạn -> thử route sau (THẤP-3)
    expect(parseHookPath('/in/x/github/k', ['/in', '/in/x'])).toEqual({ provider: 'github', sourceKey: 'k' });
  });

  // Gộp EG1 + D3 (review EG lượt 6 S1/S4, EG1 lượt 4 Thấp-A/B): `/HOOKS/...` (sai hoa thường) bị 404 TRƯỚC gate — IP sạch
  // và IP bị ban nhận CÙNG phản hồi (không lộ trạng thái phạt), body không bị đọc, ingest không chạy.
  it('[EG:T19] (phần b) /HOOKS sai hoa thường: IP bị ban và IP sạch nhận cùng 404 not_found (fix nói về URL webhook), không đọc body', async () => {
    const bodies: any[] = [];
    for (const ip of [BANNED, '198.51.100.77']) {
      for (const path of ['/HOOKS/github/src_gate', '/Hooks/github/src_gate?x=1', 'HTTP://HUB.TEST/HOOKS/github/src_gate']) {
        const r = await rawPost(port, path, ip, 1024 * 1024, 16 * 1024);
        expect([ip, path, r.status, r.body.error, r.body.fix]).toEqual([ip, path, 404, 'not_found', HOOKS_NOT_FOUND_FIX]);
        bodies.push({ ...r.body, requestId: undefined });
      }
    }
    expect(new Set(bodies.map((b) => JSON.stringify(b))).size).toBe(1);
    expect(ingestSpy).not.toHaveBeenCalled();
  });

  it('[EG:T19] (phần c) absolute-form chữ thường không bị 404 oan ở lớp hub-api (Thấp-A EG1 R4): IP sạch tới ingest, IP bị ban 429 ở gate', async () => {
    const clean = await rawPost(port, 'http://hub.test/hooks/github/src_abs', '198.51.100.78', 2, 2);
    expect(clean.status).toBe(404); // source không tồn tại (Prisma giả) -> 404 của INGEST, không phải của guard
    expect(ingestSpy).toHaveBeenCalledTimes(1);
    const banned = await rawPost(port, 'http://hub.test/hooks/github/src_abs', BANNED, 1024 * 1024, 16 * 1024);
    expect(banned.status).toBe(429);
  });

  it('[EG:T1] (phần b) qua proxy tin cậy (như edge): 20 lần 404 từ IP A chặn A, KHÔNG chặn IP B — hộp phạt khoá theo req.ip, không theo IP proxy', async () => {
    const A = '192.0.2.10';
    const B = '192.0.2.11';
    for (let i = 0; i < 20; i++) expect((await rawPost(port, `/hooks/github/khong_co_${i}`, A, 2, 2)).status).toBe(404);
    expect((await rawPost(port, '/hooks/github/khong_co_x', A, 1024 * 1024, 1024)).status).toBe(429);
    const b = await rawPost(port, '/hooks/github/khong_co_x', B, 2, 2);
    expect([b.status, b.body.error]).not.toEqual([429, 'ip_temporarily_blocked']);
    expect(b.status).toBe(404);
    // L2 (qua container edge thật, req.ip do nginx real_ip đặt) — CHƯA CHẠY (không Docker trên máy này).
  });

  it('main.ts: thứ tự guard /hooks -> gate hộp phạt -> body parser (khoá thứ tự, S4)', () => {
    const src = readFileSync(join(__dirname, '../src/main.ts'), 'utf8');
    const at = (s: string) => src.indexOf(s);
    expect(at('installHooksPathGuard(app)')).toBeGreaterThan(at('app.enableCors('));
    expect(at('installHooksPathGuard(app)')).toBeLessThan(at('installPenaltyGate(app)'));
    expect(at('installPenaltyGate(app)')).toBeLessThan(at('configureBodyParsers(app)'));
  });

  it('gate không gọi tới Redis/DB; OPTIONS / route khác đi thẳng qua; [PK:T2] (phần b) GET /hooks/* bị kiểm như POST', () => {
    const penalty = { checkIp: jest.fn(() => ({ blocked: false })), checkPair: jest.fn(() => ({ blocked: false })) } as any;
    const gate = createPenaltyGate({ penalty });
    const next = jest.fn();
    gate({ method: 'OPTIONS', url: '/hooks/github/k', headers: {} } as any, {} as any, next);
    gate({ method: 'POST', url: '/api/v1/sources', headers: {} } as any, {} as any, next);
    gate({ method: 'GET', url: '/api/v1/sources', headers: {} } as any, {} as any, next);
    gate({ method: 'GET', url: '/hooks/generic/k?hub.challenge=1', headers: {}, ip: '203.0.113.8' } as any, {} as any, next);
    gate({ method: 'POST', url: '/hooks/github/k', headers: {}, ip: '203.0.113.9' } as any, {} as any, next);
    expect(next).toHaveBeenCalledTimes(5);
    expect(penalty.checkIp).toHaveBeenCalledTimes(2);
    expect(penalty.checkPair).toHaveBeenCalledWith('203.0.113.8', 'k');
    expect(penalty.checkPair).toHaveBeenCalledWith('203.0.113.9', 'k');
    expect(fakeRedis.checkRateLimit).not.toHaveBeenCalled();
  });
});
