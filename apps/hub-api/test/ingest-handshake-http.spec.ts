import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { createHmac } from 'crypto';
import { aesGcmEncrypt } from '@hub/crypto';
import { configureBodyParsers, installHooksPathGuard } from '../src/body-parsers';
import { IngestController } from '../src/modules/ingest/ingest.controller';
import { IngestService } from '../src/modules/ingest/ingest.service';
import { installErrorHandling } from '../src/modules/errors/install';

/**
 * PK4 (§6.2/§6.3, E27, ADR-205) qua HTTP THẬT: app Nest + IngestController + IngestService THẬT (Prisma/Redis giả).
 * Chứng minh route GET tồn tại cạnh POST (hai decorator trên một method thì cái sau ghi đè), HEAD -> 405, echo là
 * `text/plain; charset=utf-8` nguyên văn + nosniff + Content-Length khớp (Twitch đòi), 204 không body.
 */
const MASTER = 'test-master-key-at-least-32-characters!!';
const SECRET = `http-${process.pid}-secret`;
let currentConfig: unknown = null;
const tx = { rawEvent: { create: jest.fn().mockResolvedValue({ id: 'raw-h' }) }, outbox: { create: jest.fn() } };
const prisma: any = {
  findSourceBySourceKeyForIngest: jest.fn(async () => ({
    id: 'src-h',
    tenantId: 'tenant-h',
    provider: 'generic',
    isActive: true,
    archivedAt: null,
    verificationConfig: currentConfig,
    secrets: [{ id: 's', secretEncrypted: aesGcmEncrypt(SECRET, MASTER) }],
  })),
  tenantTx: jest.fn((_t: string, fn: any) => fn(tx)),
  forTenant: jest.fn(() => ({ addIngestDuplicates: async () => undefined, addSourceTraffic: async () => undefined })),
};
const redis: any = { checkRateLimit: jest.fn(async () => true), getIdempotencyKey: jest.fn(async () => null), setIdempotencyKey: jest.fn() };

@Module({ controllers: [IngestController], providers: [{ provide: IngestService, useFactory: () => new IngestService(prisma, redis) }] })
class TestModule {}

const BASE_CFG = { scheme: 'hmac', header: 'x-sig', idempotency: { header: 'x-id' }, eventType: 'acme.event' };

describe('[PK:T11] (phần b) PK4 qua HTTP thật: GET bắt tay, HEAD 405, echo text/plain, 204', () => {
  let app: NestExpressApplication;
  let base = '';
  beforeAll(async () => {
    process.env.MASTER_KEY = MASTER;
    app = await NestFactory.create<NestExpressApplication>(TestModule, { logger: false, rawBody: true });
    installErrorHandling(app);
    installHooksPathGuard(app);
    configureBodyParsers(app);
    await app.listen(0, '127.0.0.1');
    base = (await app.getUrl()).replace('[::1]', '127.0.0.1');
  });
  afterAll(() => app.close());
  beforeEach(() => {
    tx.rawEvent.create.mockClear();
    tx.outbox.create.mockClear();
  });

  it('GET query-echo -> 200 text/plain; charset=utf-8, body = challenge, nosniff, Content-Length khớp', async () => {
    currentConfig = { ...BASE_CFG, handshake: { kind: 'query-echo', param: 'challenge' } };
    const res = await fetch(`${base}/hooks/generic/src_http_k?challenge=xyz_123-ABC`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-length')).toBe(String('xyz_123-ABC'.length));
    expect(await res.text()).toBe('xyz_123-ABC');
    expect(tx.rawEvent.create.mock.calls[0][0].data.headers.__hub_meta.reason).toBe('handshake');
  });

  it('HEAD (kể cả có param đúng) -> 405; GET source không query-echo -> 405 {error:"method_not_allowed"}, không ghi DB', async () => {
    currentConfig = { ...BASE_CFG, handshake: { kind: 'query-echo', param: 'challenge' } };
    const head = await fetch(`${base}/hooks/generic/src_http_k?challenge=1`, { method: 'HEAD' });
    expect(head.status).toBe(405);
    currentConfig = BASE_CFG;
    const get = await fetch(`${base}/hooks/generic/src_http_k?challenge=1`);
    expect(get.status).toBe(405);
    expect(await get.json()).toEqual({ error: 'method_not_allowed' });
    expect(tx.rawEvent.create).not.toHaveBeenCalled();
  });

  it('POST vẫn chạy (route POST không bị route GET ghi đè); successStatus 204 -> 204 không body', async () => {
    currentConfig = { ...BASE_CFG, ack: { successStatus: 204 } };
    const body = '{"a":1}';
    const res = await fetch(`${base}/hooks/generic/src_http_k`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-id': 'e1', 'x-sig': createHmac('sha256', SECRET).update(body).digest('hex') },
      body,
    });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
    expect(tx.outbox.create).toHaveBeenCalledTimes(1);
  });

  it('header-echo -> 200, header trả lại đúng giá trị, body rỗng', async () => {
    currentConfig = { ...BASE_CFG, handshake: { kind: 'header-echo', header: 'x-hook-secret' } };
    const v = `hk-${process.pid}`;
    const res = await fetch(`${base}/hooks/generic/src_http_k`, { method: 'POST', headers: { 'x-hook-secret': v } });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-hook-secret')).toBe(v);
    expect(await res.text()).toBe('');
  });
  it('ADR-205 bổ sung: HEAD + head-ok -> 200 không body, không ghi DB; body-echo respond json -> application/json {challenge}', async () => {
    currentConfig = { ...BASE_CFG, handshake: { kind: 'head-ok' } };
    const head = await fetch(`${base}/hooks/generic/src_http_k`, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
    expect(tx.rawEvent.create).not.toHaveBeenCalled();
    currentConfig = { ...BASE_CFG, handshake: { kind: 'body-echo', when: { field: 'type', equals: 'challenge' }, echo: { field: 'challenge' }, respond: 'json' } };
    const res = await fetch(`${base}/hooks/generic/src_http_k`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"type":"challenge","challenge":"abc_1"}' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^application\/json/);
    expect(await res.json()).toEqual({ challenge: 'abc_1' });
  });
});
