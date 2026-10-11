import * as http from 'http';
import { randomUUID } from 'crypto';
import { AddressInfo } from 'net';
import { PrismaService, getMasterKey } from '@hub/database';
import { aesGcmDecrypt } from '@hub/crypto';
import { ProviderRegistry } from '@hub/providers';
import { SourceConnectionService } from '../src/modules/console/source-connection.service';
import { describeDb, newTestPrisma } from '../../../libs/database/test/support/test-db';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createSink } = require('../../../tools/verify-sink/sink.js');

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
    await raw.auditLog.deleteMany({ where: { tenantId: tenant } });
    await raw.source.deleteMany({ where: { tenantId: tenant } });
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
});
