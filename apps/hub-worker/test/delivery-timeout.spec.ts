import * as http from 'http';
import { AddressInfo } from 'net';

/**
 * S10 (SPEC §4.9, ADR-078): `DELIVERY_TIMEOUT_MS` (kẹp 1000–10000, mặc định 5000) là trần TỔNG một lần gửi.
 * Đích ngủ lâu hơn trần -> SendResult 500 + error chứa "timeout" (không throw), trả về đúng khoảng trần.
 */
describe('DELIVERY_TIMEOUT_MS (S10)', () => {
  const load = (v?: string) => {
    let mod: typeof import('../src/senders/http-limits');
    jest.isolateModules(() => {
      if (v === undefined) delete process.env.DELIVERY_TIMEOUT_MS;
      else process.env.DELIVERY_TIMEOUT_MS = v;
      mod = require('../src/senders/http-limits');
    });
    return mod!;
  };
  afterEach(() => delete process.env.DELIVERY_TIMEOUT_MS);

  it('S10: kẹp 1000–10000, không đặt / rác -> 5000', () => {
    expect(load().SEND_TIMEOUT_MS).toBe(5000);
    expect(load('10000').SEND_TIMEOUT_MS).toBe(10000);
    expect(load('50000').SEND_TIMEOUT_MS).toBe(10000);
    expect(load('10').SEND_TIMEOUT_MS).toBe(1000);
    expect(load('abc').SEND_TIMEOUT_MS).toBe(5000);
    expect(load('2500').SEND_TIMEOUT_MS).toBe(2500);
  });

  it('[MS:T10] (phần a) đích ngủ 3s, DELIVERY_TIMEOUT_MS=1000 -> WebhookSender trả 500 + "timeout" sau ~1s', async () => {
    const server = http.createServer((_req, res) => setTimeout(() => res.writeHead(200).end('ok'), 3000));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/slow`;
    try {
      let Sender: any;
      jest.isolateModules(() => {
        process.env.DELIVERY_TIMEOUT_MS = '1000';
        jest.doMock('@hub/crypto', () => ({
          ...jest.requireActual('@hub/crypto'),
          createSsrfSafeAxiosConfig: async (u: string) => ({ url: u }),
        }));
        Sender = require('../src/senders/webhook.sender').WebhookSender;
      });
      const t0 = Date.now();
      const r = await new Sender().send({ url }, '', { id: 'evt_t', type: 'order.x', source: 'api', data: {} });
      const ms = Date.now() - t0;
      expect(r.status).toBe(500);
      expect(r.error).toMatch(/timeout/);
      expect(ms).toBeGreaterThanOrEqual(900);
      expect(ms).toBeLessThan(2500);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
