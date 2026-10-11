import * as http from 'http';
import { randomUUID } from 'crypto';
import { AddressInfo } from 'net';
import { PrismaService, getMasterKey } from '@hub/database';
import { aesGcmDecrypt, aesGcmEncrypt } from '@hub/crypto';
import { HttpException } from '@nestjs/common';
import { ProviderRegistry } from '@hub/providers';
import { SourceConnectionService } from '../src/modules/console/source-connection.service';
import { describeDb, newTestPrisma } from '../../../libs/database/test/support/test-db';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createSink } = require('../../../tools/verify-sink/sink.js');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { payosSign } = require('../../../tools/verify-sink/fake-providers.js');

/**
 * KN3 (SPEC-ket-noi §5.1, §8.1) trên Postgres THẬT + PayOS GIẢ của sink (chạy trong tiến trình test) + một "ingest" tối
 * thiểu làm đúng hai bước của ingest thật trước khi trả 200: tra source bằng lối thoát `findSourceBySourceKeyForIngest`
 * (kết nối khác, chỉ thấy dữ liệu đã COMMIT) và `PayosAdapter.verify` trên raw body với các SourceSecret còn hiệu lực.
 * Fake PayOS bắn request kiểm tra có chữ ký NGAY trong lúc `confirm-webhook` đang chờ — đúng như PayOS thật.
 */
describeDb('[KN3] Kết nối PayOS với fake PayOS (Postgres)', () => {
  const raw = newTestPrisma('owner');
  const svc = new PrismaService();
  const tenant = randomUUID();
  const other = randomUUID();
  const FAKE = { clientId: 'fake-cid', apiKey: 'fake-api-key-VALUE', checksumKey: 'fake-checksum-VALUE' };
  const ingestHits: { key: string; status: number }[] = [];
  let sink: http.Server;
  let ingest: http.Server;
  let conn: SourceConnectionService;

  const listen = (s: http.Server) => new Promise<string>((r) => s.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${(s.address() as AddressInfo).port}`)));

  beforeAll(async () => {
    sink = createSink({ env: { FAKE_PAYOS_CLIENT_ID: FAKE.clientId, FAKE_PAYOS_API_KEY: FAKE.apiKey, FAKE_PAYOS_CHECKSUM_KEY: FAKE.checksumKey } });
    ingest = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', async () => {
        const key = (req.url ?? '').split('/').pop() ?? '';
        const rawBody = Buffer.concat(chunks);
        const source = await svc.findSourceBySourceKeyForIngest(key);
        const secrets = (source?.secrets ?? []).map((x: any) => aesGcmDecrypt(x.secretEncrypted, getMasterKey()));
        const ok = !!source && (await ProviderRegistry.get('payos').verify({ provider: 'payos', sourceKey: key, headers: req.headers as any, rawBody, body: JSON.parse(rawBody.toString('utf8')) }, secrets));
        ingestHits.push({ key, status: ok ? 200 : source ? 401 : 404 });
        res.writeHead(ok ? 200 : source ? 401 : 404, { 'content-type': 'application/json' }).end('{"code":"00"}');
      });
    });
    const sinkBase = await listen(sink);
    const ingestBase = await listen(ingest);
    conn = new SourceConnectionService(svc, { PAYOS_FAKE_BASE_URL: `${sinkBase}/_fake/payos`, CONNECTOR_INGEST_BASE_URL: ingestBase, HUB_PUBLIC_URL: 'http://localhost:4000' });
  }, 60_000);

  afterAll(async () => {
    await raw.auditLog.deleteMany({ where: { tenantId: { in: [tenant, other] } } });
    await raw.source.deleteMany({ where: { tenantId: { in: [tenant, other] } } });
    await raw.$disconnect();
    await svc.$disconnect();
    await new Promise((r) => sink.close(r));
    await new Promise((r) => ingest.close(r));
  });

  it('[KN:U8] (phần b) "Kết nối PayOS": checksumKey thành SourceSecret v1 và COMMIT trước confirm -> request kiểm tra verify được (ingest 200) -> "CAFE TEST · ****1234"', async () => {
    const r: any = await conn.connect(tenant, 'user:u1', { provider: 'payos', name: 'PayOS cafe', acknowledgeOverwrite: true, credentials: FAKE });
    expect(r.connection).toMatchObject({ status: 'CONNECTED', display: 'CAFE TEST · ****1234' });
    expect(ingestHits.at(-1)).toEqual({ key: r.source.sourceKey, status: 200 });
    const secrets = await raw.sourceSecret.findMany({ where: { sourceId: r.source.id } });
    expect(secrets.map((s) => aesGcmDecrypt(s.secretEncrypted, getMasterKey()))).toEqual([FAKE.checksumKey]);
  });

  it('[KN3] sai Api Key -> FAILED invalid_credentials (PayOS không gọi ingest); sai Checksum Key -> ingest 401 -> FAILED webhook_rejected; source giữ lại, retry bằng key đúng -> CONNECTED + SourceSecret version mới', async () => {
    const before = ingestHits.length;
    const bad: any = await conn.connect(tenant, 'user:u1', { provider: 'payos', name: 'sai key', acknowledgeOverwrite: true, credentials: { ...FAKE, apiKey: 'nope' } });
    expect(bad.connection).toMatchObject({ status: 'FAILED', lastError: 'invalid_credentials' });
    expect(ingestHits.length).toBe(before);
    const wrongCk: any = await conn.connect(tenant, 'user:u1', { provider: 'payos', name: 'sai checksum', acknowledgeOverwrite: true, credentials: { ...FAKE, checksumKey: 'wrong-checksum' } });
    expect(wrongCk.connection).toMatchObject({ status: 'FAILED', lastError: 'webhook_rejected' });
    expect(ingestHits.at(-1)).toEqual({ key: wrongCk.source.sourceKey, status: 401 });
    const fixed: any = await conn.retry(tenant, 'user:u1', wrongCk.source.id, { credentials: FAKE });
    expect(fixed.connection).toMatchObject({ status: 'CONNECTED', display: 'CAFE TEST · ****1234' });
    const versions = await raw.sourceSecret.findMany({ where: { sourceId: wrongCk.source.id }, orderBy: { version: 'asc' } });
    expect(versions.map((v) => v.version)).toEqual([1, 2]);
    expect(aesGcmDecrypt(versions[1].secretEncrypted, getMasterKey())).toBe(FAKE.checksumKey);
    // Không có disconnect -> GET trả hướng dẫn ngắt tay.
    expect((await conn.status(tenant, wrongCk.source.id)).manualDisconnect).toMatch(/dashboard PayOS/);
  });

  // ---- H-1 (REVIEW-KN): gắn connector vào source CÓ SẴN (Shop ghim src_payos_main) ----
  const errOf = async (p: Promise<unknown>) => {
    const e = await p.then(() => null, (x) => x);
    expect(e).toBeInstanceOf(HttpException);
    return { status: (e as HttpException).getStatus(), body: (e as HttpException).getResponse() as any };
  };
  /** Như `POST /api/v1/sources` (dán tay): source + SourceSecret v1 = checksumKey. */
  const manualSource = (tenantId: string, checksum: string) =>
    raw.source.create({
      data: { tenantId, provider: 'payos', name: 'PayOS main', sourceKey: `src_payos_main_${randomUUID().slice(0, 8)}`, isActive: true, secrets: { create: { secretEncrypted: aesGcmEncrypt(checksum, getMasterKey()), version: 1 } } },
    });
  const sourceCount = () => raw.source.count({ where: { tenantId: tenant } });
  /** Một webhook PayOS thật đã được ingest nhận (ACCEPTED), ký bằng `key` — như hàng ingest ghi vào raw_events. */
  const realWebhook = (sourceId: string, key: string) => {
    const data = { orderCode: 123, amount: 3000, description: 'VQRIO123', accountNumber: '12345678', reference: `TF${randomUUID().slice(0, 8)}`, transactionDateTime: '2026-10-11 10:00:00', currency: 'VND', paymentLinkId: 'x', code: '00', desc: 'success' };
    const body = { code: '00', desc: 'success', success: true, data, signature: payosSign(data, key) };
    const json = JSON.stringify(body);
    return raw.rawEvent.create({ data: { sourceId, idempotencyKey: `payos:${randomUUID()}`, headers: {}, body, bodyRaw: Buffer.from(json), contentType: 'application/json', signatureValid: true, status: 'ACCEPTED' } });
  };

  it('[KN:U19] "Kết nối nguồn có sẵn": KHÔNG tạo source mới, URL đăng ký = /hooks/payos/<sourceKey cũ> (Shop vẫn nhận), checksumKey trùng -> không thêm version', async () => {
    const s = await manualSource(tenant, FAKE.checksumKey);
    const before = await sourceCount();
    const r: any = await (conn as any).connectExisting(tenant, 'user:u1', s.id, { acknowledgeOverwrite: true, credentials: FAKE });
    expect(r.connection).toMatchObject({ status: 'CONNECTED', display: 'CAFE TEST · ****1234', ingestUrl: expect.stringMatching(new RegExp(`/hooks/payos/${s.sourceKey}$`)) });
    expect(r.source).toMatchObject({ id: s.id, sourceKey: s.sourceKey });
    expect(r.source.secrets).toBeUndefined();
    expect(await sourceCount()).toBe(before);
    expect(ingestHits.at(-1)).toEqual({ key: s.sourceKey, status: 200 });
    const versions = await raw.sourceSecret.findMany({ where: { sourceId: s.id } });
    expect(versions.map((v) => [v.version, v.validUntil])).toEqual([[1, null]]);
    const audits = await raw.auditLog.findMany({ where: { tenantId: tenant, entityId: s.id }, orderBy: { createdAt: 'asc' } });
    expect(audits.map((a) => a.action)).toEqual(['source.connect']);
    expect(JSON.stringify(audits.map((x) => x.metadata))).not.toContain(FAKE.apiKey);
    // Bấm lại (đã có kết nối) = kết nối lại trên CÙNG source, vẫn không tạo source.
    const again: any = await (conn as any).connectExisting(tenant, 'user:u1', s.id, { acknowledgeOverwrite: true, credentials: FAKE });
    expect(again.connection.status).toBe('CONNECTED');
    expect(await sourceCount()).toBe(before);
  });

  it('[KN:U20] nguồn có sẵn với checksumKey KHÁC -> SourceSecret version mới TRƯỚC khi gọi PayOS; bản cũ KHÔNG bị hẹn hết hạn; chỉ khi webhook thật verify bằng bản MỚI mới retire bản cũ (+24h)', async () => {
    const s = await manualSource(tenant, 'checksum-cu-cua-kenh-khac');
    const r: any = await (conn as any).connectExisting(tenant, 'user:u1', s.id, { acknowledgeOverwrite: true, credentials: FAKE });
    expect(r.connection.status).toBe('CONNECTED');
    expect(r.secretChanged).toBe(true);
    expect(ingestHits.at(-1)).toEqual({ key: s.sourceKey, status: 200 });
    let versions = await raw.sourceSecret.findMany({ where: { sourceId: s.id }, orderBy: { version: 'asc' } });
    expect(versions.map((v) => [v.version, v.validUntil])).toEqual([[1, null], [2, null]]);
    expect(aesGcmDecrypt(versions[1].secretEncrypted, getMasterKey())).toBe(FAKE.checksumKey);
    // Webhook thật ký bằng key MỚI đã vào hub -> lần kiểm tình trạng kế tiếp retire bản cũ (còn 24 giờ cho lượt gửi lại).
    await realWebhook(s.id, FAKE.checksumKey);
    await raw.sourceConnection.update({ where: { sourceId: s.id }, data: { lastCheckedAt: null } });
    const st = await conn.status(tenant, s.id);
    expect(st.lastError).toBeNull();
    versions = await raw.sourceSecret.findMany({ where: { sourceId: s.id }, orderBy: { version: 'asc' } });
    expect(versions[0].validUntil!.getTime()).toBeGreaterThan(Date.now() + 23 * 3600_000);
    expect(versions[1].validUntil).toBeNull();
  });

  it('[KN:U25] (H-R2-1) checksumKey cũ ĐÚNG, dán key MỚI SAI: CONNECTED (PayOS chỉ kiểm clientId/apiKey, ký bằng key thật) nhưng KHÔNG mất key đúng — "tua" quá 24 giờ vẫn verify; webhook thật chỉ khớp key cũ -> báo secret_mismatch, không retire gì', async () => {
    const s = await manualSource(tenant, FAKE.checksumKey);
    const wrong = { ...FAKE, checksumKey: 'checksum-DAN-NHAM-kenh-khac' };
    const r: any = await (conn as any).connectExisting(tenant, 'user:u1', s.id, { acknowledgeOverwrite: true, credentials: wrong });
    expect(r.connection.status).toBe('CONNECTED');
    expect(r.secretChanged).toBe(true);
    // Tua 25 giờ: mọi mốc thời gian của secret lùi 25 giờ (NULL giữ NULL).
    await raw.$executeRawUnsafe(
      `UPDATE hub.source_secrets SET valid_from = valid_from - interval '25 hours', valid_until = valid_until - interval '25 hours' WHERE source_id = $1::uuid`,
      s.id,
    );
    // Request kiểm tra của PayOS (ký bằng key THẬT) vẫn verify qua đường tra secret của ingest.
    const again: any = await conn.retry(tenant, 'user:u1', s.id, {});
    expect(ingestHits.at(-1)).toEqual({ key: s.sourceKey, status: 200 });
    expect(again.connection.status).toBe('CONNECTED');
    await realWebhook(s.id, FAKE.checksumKey);
    await raw.sourceConnection.update({ where: { sourceId: s.id }, data: { lastCheckedAt: null } });
    const st = await conn.status(tenant, s.id);
    expect(st).toMatchObject({ lastError: 'secret_mismatch', fix: expect.stringMatching(/checksumKey/) });
    const versions = await raw.sourceSecret.findMany({ where: { sourceId: s.id }, orderBy: { version: 'asc' } });
    expect(versions.map((v) => [v.version, v.validUntil])).toEqual([[1, null], [2, null]]);
  });

  it('[KN:U26] (H-R2-1) FAILED (PayOS từ chối apiKey) với checksumKey khác -> không retire version nào', async () => {
    const s = await manualSource(tenant, FAKE.checksumKey);
    const r: any = await (conn as any).connectExisting(tenant, 'user:u1', s.id, { acknowledgeOverwrite: true, credentials: { ...FAKE, apiKey: 'nope', checksumKey: 'khac-hoan-toan' } });
    expect(r.connection.status).toBe('FAILED');
    const versions = await raw.sourceSecret.findMany({ where: { sourceId: s.id }, orderBy: { version: 'asc' } });
    expect(versions.every((v) => v.validUntil === null)).toBe(true);
  });

  it('[KN:U21] nguồn có sẵn: project khác -> 404 giống hệt id lạ; thiếu acknowledgeOverwrite -> 422; provider khác source -> 422; không gọi PayOS', async () => {
    const foreign = await manualSource(other, FAKE.checksumKey);
    const mine = await manualSource(tenant, FAKE.checksumKey);
    const hits = ingestHits.length;
    const a = await errOf((conn as any).connectExisting(tenant, 'user:u1', foreign.id, { acknowledgeOverwrite: true, credentials: FAKE }));
    const b = await errOf((conn as any).connectExisting(tenant, 'user:u1', randomUUID(), { acknowledgeOverwrite: true, credentials: FAKE }));
    expect(a).toEqual(b);
    expect(a.status).toBe(404);
    expect((await errOf((conn as any).connectExisting(tenant, 'user:u1', mine.id, { credentials: FAKE }))).body).toMatchObject({ error: 'overwrite_not_acknowledged' });
    expect((await errOf((conn as any).connectExisting(tenant, 'user:u1', mine.id, { provider: 'stripe', acknowledgeOverwrite: true, credentials: FAKE })))).toMatchObject({ status: 422, body: { error: 'validation_failed', field: 'provider' } });
    expect(ingestHits.length).toBe(hits);
    expect(await raw.sourceConnection.count({ where: { sourceId: { in: [foreign.id, mine.id] } } })).toBe(0);
  });

  it('[KN:U22] sourceKey trùng (UNIQUE toàn cục) -> 409 conflict GIỐNG HỆT dù key thuộc project mình hay project khác; không tạo gì', async () => {
    const foreign = await manualSource(other, FAKE.checksumKey);
    const mine = await manualSource(tenant, FAKE.checksumKey);
    const before = await sourceCount();
    const body = (sourceKey: string) => ({ provider: 'payos', name: 'trùng', sourceKey, acknowledgeOverwrite: true, credentials: FAKE });
    const x = await errOf(conn.connect(tenant, 'user:u1', body(foreign.sourceKey)));
    const y = await errOf(conn.connect(tenant, 'user:u1', body(mine.sourceKey)));
    expect(x).toEqual(y);
    expect(x).toMatchObject({ status: 409, body: { error: 'conflict', field: 'sourceKey' } });
    expect(await sourceCount()).toBe(before);
  });

  it('[KN:U23] kết nối đang PENDING (lượt khác đang gọi provider) -> retry / connectExisting 409 connection_in_progress; PENDING cũ (kẹt) -> cho chạy lại', async () => {
    const s = await manualSource(tenant, FAKE.checksumKey);
    await (conn as any).connectExisting(tenant, 'user:u1', s.id, { acknowledgeOverwrite: true, credentials: FAKE });
    await raw.sourceConnection.update({ where: { sourceId: s.id }, data: { status: 'PENDING', updatedAt: new Date() } });
    const hits = ingestHits.length;
    // M-R2-1: tạo promise LƯỜI — promise tạo sẵn mà reject trước khi được await thì Jest bắt thành lỗi (chập chờn).
    for (const call of [() => conn.retry(tenant, 'user:u1', s.id, {}), () => (conn as any).connectExisting(tenant, 'user:u1', s.id, { acknowledgeOverwrite: true, credentials: FAKE })]) {
      expect(await errOf(call())).toMatchObject({ status: 409, body: { error: 'conflict', code: 'connection_in_progress' } });
    }
    expect(ingestHits.length).toBe(hits);
    await raw.$executeRawUnsafe(`UPDATE hub.source_connections SET updated_at = now() - interval '10 minutes' WHERE source_id = $1::uuid`, s.id);
    expect((await conn.retry(tenant, 'user:u1', s.id, {})).connection.status).toBe('CONNECTED');
  });
});
