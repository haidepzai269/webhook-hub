import * as http from 'http';
import { AddressInfo } from 'net';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createSink } = require('../../tools/verify-sink/sink.js');

/**
 * Sink nhận thử của hubv (DINH-CHINH-AUTH §8 #6, thay echo.js của SPEC đa service §7.0):
 * trả challenge, ghi mọi request + API đọc lại, ?mode=fail → 500, ?mode=slow → ngủ.
 */
describe('verify-sink', () => {
  let server: http.Server;
  let base: string;
  beforeAll(async () => {
    server = createSink({ slowMs: 50 });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));
  beforeEach(() => fetch(`${base}/_requests`, { method: 'DELETE' }));

  it('body endpoint.verification → 200 trả đúng challenge', async () => {
    const res = await fetch(`${base}/in/a`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'endpoint.verification', challenge: 'abc_123' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ challenge: 'abc_123' });
  });

  it('ghi lại bytes thô + header, đọc lại theo path; DELETE xoá', async () => {
    const raw = '{"a": 1,  "b":"\u00e0"}';
    await fetch(`${base}/in/x?k=1`, { method: 'POST', headers: { 'webhook-id': 'msg_1' }, body: raw });
    await fetch(`${base}/in/y`, { method: 'POST', body: 'khác' });
    const list = await (await fetch(`${base}/_requests?path=/in/x`)).json();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ method: 'POST', path: '/in/x', query: { k: '1' }, body: raw });
    expect(list[0].headers['webhook-id']).toBe('msg_1');
    await fetch(`${base}/_requests`, { method: 'DELETE' });
    expect(await (await fetch(`${base}/_requests`)).json()).toEqual([]);
  });

  it('?mode=fail → 500, ?mode=slow → chậm rồi 200', async () => {
    expect((await fetch(`${base}/in/f?mode=fail`, { method: 'POST', body: '{}' })).status).toBe(500);
    const t = Date.now();
    expect((await fetch(`${base}/in/s?mode=slow`, { method: 'POST', body: '{}' })).status).toBe(200);
    expect(Date.now() - t).toBeGreaterThanOrEqual(45);
  });
});
