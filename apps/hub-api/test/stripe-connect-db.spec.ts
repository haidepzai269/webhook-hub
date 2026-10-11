import * as http from 'http';
import { randomUUID, createHmac } from 'crypto';
import { AddressInfo } from 'net';
import { PrismaService, getMasterKey } from '@hub/database';
import { aesGcmDecrypt } from '@hub/crypto';
import { ProviderRegistry, STRIPE_ENABLED_EVENTS } from '@hub/providers';
import { SourceConnectionService } from '../src/modules/console/source-connection.service';
import { describeDb, newTestPrisma } from '../../../libs/database/test/support/test-db';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createSink } = require('../../../tools/verify-sink/sink.js');

/**
 * KN4 (SPEC-ket-noi §5.2, §8.1) trên Postgres THẬT + Stripe GIẢ của sink (trong tiến trình test). Ký event theo đúng lược
 * đồ Stripe (`t=<ts>,v1=HMAC-SHA256(secret, "<ts>.<raw body>")`) rồi cho `StripeAdapter.verify` kiểm bằng các SourceSecret
 * còn hiệu lực — đúng cách ingest thật lấy secret (`findSourceBySourceKeyForIngest`).
 */
describeDb('[KN4] Kết nối Stripe với fake Stripe (Postgres)', () => {
  const raw = newTestPrisma('owner');
  const svc = new PrismaService();
  const tenant = randomUUID();
  const KEY = { secretKey: `rk_test_${randomUUID().replace(/-/g, '')}` };
  let sink: http.Server;
  let sinkBase = '';
  let conn: SourceConnectionService;

  const sign = (secret: string, body: string) => {
    const t = Math.floor(Date.now() / 1000);
    return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;
  };
  /** Như ingest thật: tra source theo sourceKey (lối thoát của ingest) -> secret còn hiệu lực -> adapter.verify trên raw body. */
  const verifies = async (sourceKey: string, secret: string) => {
    const body = JSON.stringify({ id: `evt_${randomUUID()}`, type: 'payment_intent.succeeded', data: { object: { id: 'pi_1', amount_received: 2000, currency: 'vnd' } } });
    const source = await svc.findSourceBySourceKeyForIngest(sourceKey);
    const secrets = (source?.secrets ?? []).map((x: any) => aesGcmDecrypt(x.secretEncrypted, getMasterKey()));
    return ProviderRegistry.get('stripe').verify({ provider: 'stripe', sourceKey, headers: { 'stripe-signature': sign(secret, body) }, rawBody: Buffer.from(body), body: JSON.parse(body) }, secrets);
  };
  const requests = async (method: string) =>
    ((await (await fetch(`${sinkBase}/_requests`)).json()) as any[]).filter((r) => r.method === method && r.path.startsWith('/_fake/stripe/v1/webhook_endpoints'));

  beforeAll(async () => {
    sink = createSink();
    await new Promise<void>((r) => sink.listen(0, '127.0.0.1', () => r()));
    sinkBase = `http://127.0.0.1:${(sink.address() as AddressInfo).port}`;
    conn = new SourceConnectionService(svc, { STRIPE_FAKE_BASE_URL: `${sinkBase}/_fake/stripe`, HUB_PUBLIC_URL: 'https://hub.example.com' });
  }, 60_000);

  afterAll(async () => {
    await raw.auditLog.deleteMany({ where: { tenantId: tenant } });
    await raw.source.deleteMany({ where: { tenantId: tenant } });
    await raw.$disconnect();
    await svc.$disconnect();
    await new Promise((r) => sink.close(r));
  });

  let sourceId = '';
  let sourceKey = '';
  let firstSecret = '';
  let firstWe = '';

  it('[KN:U14] Stripe: `secret` trong response thành SourceSecret (dev không nhập secret ký); event ký bằng secret đó verify qua', async () => {
    const r: any = await conn.connect(tenant, 'user:u1', { provider: 'stripe', name: 'Stripe shop', credentials: KEY });
    expect(r.connection).toMatchObject({ status: 'CONNECTED', display: expect.stringMatching(/^Stripe \(test\) · we_test/) });
    sourceId = r.source.id;
    sourceKey = r.source.sourceKey;
    const created = (await requests('POST')).at(-1);
    expect(created.headers.authorization).toBe(`Bearer ${KEY.secretKey}`);
    const form = new URLSearchParams(created.body);
    expect(form.get('url')).toBe(`https://hub.example.com/hooks/stripe/${sourceKey}`);
    expect(form.getAll('enabled_events[]')).toEqual(STRIPE_ENABLED_EVENTS);
    const secrets = await raw.sourceSecret.findMany({ where: { sourceId } });
    expect(secrets).toHaveLength(1);
    firstSecret = aesGcmDecrypt(secrets[0].secretEncrypted, getMasterKey());
    expect(firstSecret).toMatch(/^whsec_test/);
    firstWe = (await raw.sourceConnection.findUniqueOrThrow({ where: { sourceId } })).remoteRef!;
    expect(await verifies(sourceKey, firstSecret)).toBe(true);
    expect(await verifies(sourceKey, 'whsec_wrong')).toBe(false);
    // Không route nào trả secret Stripe sinh ra.
    expect(JSON.stringify(r)).not.toContain(firstSecret);
  });

  it('[KN:U15] kết nối lại -> SourceSecret version mới; secret cũ VẪN verify trong lúc chuyển (24 giờ); DELETE gọi đúng we_id cũ', async () => {
    const r: any = await conn.retry(tenant, 'user:u1', sourceId, {});
    expect(r.connection.status).toBe('CONNECTED');
    const versions = await raw.sourceSecret.findMany({ where: { sourceId }, orderBy: { version: 'asc' } });
    expect(versions.map((v) => v.version)).toEqual([1, 2]);
    const newSecret = aesGcmDecrypt(versions[1].secretEncrypted, getMasterKey());
    expect(newSecret).not.toBe(firstSecret);
    expect(versions[0].validUntil!.getTime()).toBeGreaterThan(Date.now() + 23 * 3600_000);
    expect(versions[1].validUntil).toBeNull();
    expect(await verifies(sourceKey, firstSecret)).toBe(true);
    expect(await verifies(sourceKey, newSecret)).toBe(true);
    const deletes = await requests('DELETE');
    expect(deletes.map((d) => d.path)).toEqual([`/_fake/stripe/v1/webhook_endpoints/${firstWe}`]);
    expect((await raw.sourceConnection.findUniqueOrThrow({ where: { sourceId } })).remoteRef).not.toBe(firstWe);
  });

  it('[KN:U24] (M-1) kết nối lại mà TX lưu we_ mới + secret mới LỖI -> we_ CŨ còn nguyên ở Stripe (không DELETE), DB vẫn trỏ we_ cũ, secret cũ vẫn verify; we_ mới mồ côi bị dọn; lần sau thành công mới gỡ we_ cũ (SAU commit)', async () => {
    const oldWe = (await raw.sourceConnection.findUniqueOrThrow({ where: { sourceId } })).remoteRef!;
    const oldSecrets = await raw.sourceSecret.findMany({ where: { sourceId }, orderBy: { version: 'asc' } });
    const liveSecret = aesGcmDecrypt(oldSecrets.at(-1)!.secretEncrypted, getMasterKey());
    const deletesBefore = (await requests('DELETE')).length;
    const postsBefore = (await requests('POST')).length;
    // TX thứ 2 của retry (= TX3, lưu kết quả của provider) lỗi như Neon pooler rớt; các TX khác chạy thật.
    let calls = 0;
    const flaky: any = new Proxy(svc, {
      get(t: any, p) {
        if (p === 'tenantTx') {
          return (tid: string, fn: any, o?: any) => (++calls === 2 ? Promise.reject(Object.assign(new Error('Can\'t reach database server (giả)'), { code: 'P1001' })) : t.tenantTx(tid, fn, o));
        }
        const v = t[p];
        return typeof v === 'function' ? v.bind(t) : v;
      },
    });
    const flakyConn = new SourceConnectionService(flaky, { STRIPE_FAKE_BASE_URL: `${sinkBase}/_fake/stripe`, HUB_PUBLIC_URL: 'https://hub.example.com' });
    await expect(flakyConn.retry(tenant, 'user:u1', sourceId, {})).rejects.toBeDefined();
    expect((await requests('POST')).length).toBe(postsBefore + 1);
    const deletes = (await requests('DELETE')).slice(deletesBefore).map((d) => d.path);
    expect(deletes).not.toContain(`/_fake/stripe/v1/webhook_endpoints/${oldWe}`);
    // we_ mới (secret của nó đã mất cùng TX) bị dọn để không bắn event ký bằng secret không ai giữ.
    expect(deletes).toHaveLength(1);
    const after = await raw.sourceConnection.findUniqueOrThrow({ where: { sourceId } });
    expect(after.remoteRef).toBe(oldWe);
    expect(after.status).toBe('FAILED');
    expect((await raw.sourceSecret.findMany({ where: { sourceId } })).length).toBe(oldSecrets.length);
    expect(await verifies(sourceKey, liveSecret)).toBe(true);
    // we_ cũ vẫn sống ở fake Stripe.
    const got = await fetch(`${sinkBase}/_fake/stripe/v1/webhook_endpoints/${oldWe}`, { headers: { authorization: `Bearer ${KEY.secretKey}` } });
    expect(got.status).toBe(200);
    // Lần sau thành công: COMMIT trước, rồi mới gỡ we_ cũ.
    const ok: any = await conn.retry(tenant, 'user:u1', sourceId, {});
    expect(ok.connection.status).toBe('CONNECTED');
    expect((await requests('DELETE')).at(-1).path).toBe(`/_fake/stripe/v1/webhook_endpoints/${oldWe}`);
  });

  it('[KN4] status: URL ở Stripe khớp -> CONNECTED; we_ bị xoá ở Stripe -> FAILED remote_gone; ngắt -> DELETE we_ hiện tại, DISCONNECTED', async () => {
    await raw.sourceConnection.update({ where: { sourceId }, data: { lastCheckedAt: null } });
    expect((await conn.status(tenant, sourceId)).status).toBe('CONNECTED');
    const we = (await raw.sourceConnection.findUniqueOrThrow({ where: { sourceId } })).remoteRef!;
    await fetch(`${sinkBase}/_fake/stripe/v1/webhook_endpoints/${we}`, { method: 'DELETE', headers: { authorization: `Bearer ${KEY.secretKey}` } });
    await raw.sourceConnection.update({ where: { sourceId }, data: { lastCheckedAt: null } });
    expect(await conn.status(tenant, sourceId)).toMatchObject({ status: 'FAILED', lastError: 'remote_gone' });
    const again: any = await conn.retry(tenant, 'user:u1', sourceId, {});
    const cur = (await raw.sourceConnection.findUniqueOrThrow({ where: { sourceId } })).remoteRef!;
    expect(again.connection.status).toBe('CONNECTED');
    const d: any = await conn.disconnect(tenant, 'user:u1', sourceId);
    expect(d).toMatchObject({ remoteDeleted: true, connection: { status: 'DISCONNECTED' } });
    expect((await requests('DELETE')).at(-1).path).toBe(`/_fake/stripe/v1/webhook_endpoints/${cur}`);
  });
});
