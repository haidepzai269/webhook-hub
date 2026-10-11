import { HttpException } from '@nestjs/common';
import { ConnectorError, PayosAdapter, ProviderRegistry, connectorBaseUrl, payosConnector } from '@hub/providers';
import { SourceConnectionService } from '../src/modules/console/source-connection.service';

/** KN3 (SPEC-ket-noi §5.1) — connector PayOS, không DB, không gọi PayOS thật (fetch giả). */
const noDb: any = new Proxy({}, { get: () => { throw new Error('không được chạm DB'); } });
const CREDS = { clientId: 'cid-123', apiKey: 'APIKEY_SECRET_VALUE', checksumKey: 'CHECKSUM_SECRET_VALUE' };

describe('[KN3] connector PayOS — L0', () => {
  afterEach(() => jest.restoreAllMocks());

  it('[KN:U13] PayOS thiếu acknowledgeOverwrite (hoặc khác true) -> 422 overwrite_not_acknowledged; không chạm DB, không gọi PayOS', async () => {
    const f = jest.spyOn(global, 'fetch');
    const svc = new SourceConnectionService(noDb, { HUB_PUBLIC_URL: 'https://hub.example.com' });
    for (const ack of [undefined, false, 'true']) {
      const e = await svc.connect('t', 'user:u', { provider: 'payos', name: 'PayOS', credentials: CREDS, acknowledgeOverwrite: ack }).then(() => null, (x) => x);
      expect(e).toBeInstanceOf(HttpException);
      expect([e.getStatus(), e.getResponse()]).toEqual([422, expect.objectContaining({ error: 'overwrite_not_acknowledged', field: 'acknowledgeOverwrite' })]);
    }
    expect(f).not.toHaveBeenCalled();
    expect(ProviderRegistry.get('payos').connector).toBe(payosConnector);
    expect(new PayosAdapter().connector?.spec.sourceSecretField).toBe('checksumKey');
  });

  it('[KN:U12] (phần b) PAYOS_BASE_URL trong env KHÔNG đổi được host connector gọi; gọi đúng confirm-webhook + header; display "TÊN · ****1234"', async () => {
    const prev = process.env.PAYOS_BASE_URL;
    process.env.PAYOS_BASE_URL = 'http://evil.example';
    const f = jest.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify({ code: '00', desc: 'success', data: { webhookUrl: 'x', accountName: 'CAFE ABC', accountNumber: '0123451234' } }), { status: 200 }));
    try {
      const baseUrl = connectorBaseUrl(payosConnector.spec, { ...process.env, NODE_ENV: 'production' });
      const r = await payosConnector.connect({ ingestUrl: 'https://hub.example.com/hooks/payos/src_a', credentials: CREDS, secretForSource: CREDS.checksumKey, baseUrl });
      expect(r).toEqual({ remoteRef: '****1234', display: 'CAFE ABC · ****1234' });
      const [url, init] = f.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://api-merchant.payos.vn/confirm-webhook');
      expect(init.headers).toMatchObject({ 'x-client-id': 'cid-123', 'x-api-key': 'APIKEY_SECRET_VALUE' });
      expect(JSON.parse(String(init.body))).toEqual({ webhookUrl: 'https://hub.example.com/hooks/payos/src_a' });
    } finally {
      if (prev === undefined) delete process.env.PAYOS_BASE_URL;
      else process.env.PAYOS_BASE_URL = prev;
    }
  });

  it('[KN3] lỗi PayOS -> ConnectorError có mã ngắn + fix; fix không chứa credentials', async () => {
    const run = async (status: number, body: unknown) => {
      jest.spyOn(global, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify(body), { status }));
      return payosConnector.connect({ ingestUrl: 'https://h.example/hooks/payos/k', credentials: CREDS, baseUrl: 'http://fake' }).then(() => null, (e) => e as ConnectorError);
    };
    const bad = await run(401, { code: '01', desc: 'Client id hoặc api key không hợp lệ' });
    expect(bad).toBeInstanceOf(ConnectorError);
    expect(bad!.code).toBe('invalid_credentials');
    const rej = await run(200, { code: '20', desc: 'Webhook url invalid' });
    expect(rej!.code).toBe('webhook_rejected');
    for (const e of [bad!, rej!]) for (const v of [CREDS.apiKey, CREDS.checksumKey]) expect(`${e.fix}${e.message}`).not.toContain(v);
    jest.spyOn(global, 'fetch').mockRejectedValueOnce(new TypeError('fetch failed'));
    const down = await payosConnector.connect({ ingestUrl: 'x', credentials: CREDS, baseUrl: 'http://fake' }).then(() => null, (e) => e);
    expect(down.code).toBe('provider_unreachable');
  });
});
