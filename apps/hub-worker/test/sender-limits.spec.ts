jest.mock('axios', () => ({ __esModule: true, default: { post: jest.fn() } }));
jest.mock('@hub/crypto', () => ({
  createSsrfSafeAxiosConfig: jest.fn(async (url: string) => ({ url, httpAgent: undefined, httpsAgent: undefined })),
  hmacSha256: jest.fn(() => 'sig'),
}));

import axios from 'axios';
import { WebhookSender } from '../src/senders/webhook.sender';
import { TelegramSender } from '../src/senders/telegram.sender';
import { DiscordSender } from '../src/senders/discord.sender';
import { SEND_MAX_BYTES, SEND_TIMEOUT_MS, outboundLimits } from '../src/senders/http-limits';

/**
 * Review SPEC-1 (thấp): axios `timeout` chỉ là idle timeout -> thêm AbortSignal.timeout để giới hạn
 * TỔNG thời gian, và trần 64KB cho body gửi/nhận. Abort vẫn thành SendResult (không throw).
 */
const event = { id: 'e1', type: 't', source: 's', data: {} } as any;
const cases: [string, () => Promise<any>][] = [
  ['webhook', () => new WebhookSender().send({ url: 'http://dest.example/x' }, 'c', event, 'secret')],
  ['telegram', () => new TelegramSender().send({ botToken: '1:mock', chatId: '-1', apiUrl: 'http://tg.example' }, 'c', event)],
  ['discord', () => new DiscordSender().send({ webhookUrl: 'http://dc.example/x' }, 'c', event)],
];

describe('Giới hạn HTTP chiều ra của senders', () => {
  beforeEach(() => (axios.post as jest.Mock).mockReset());

  it('outboundLimits: timeout + signal + body GỬI 64KB; KHÔNG còn maxContentLength (ADR-054)', () => {
    const l: any = outboundLimits();
    expect(l.timeout).toBe(SEND_TIMEOUT_MS);
    expect(l.signal).toBeInstanceOf(AbortSignal);
    expect(l.signal.aborted).toBe(false);
    expect(l).not.toHaveProperty('maxContentLength');
    expect(l.maxBodyLength).toBe(64 * 1024);
    expect(SEND_MAX_BYTES).toBe(65536);
  });

  it('AbortSignal.timeout thật sự abort sau đúng thời hạn tổng', async () => {
    const l = outboundLimits(30);
    await new Promise((r) => setTimeout(r, 60));
    expect(l.signal.aborted).toBe(true);
  });

  it.each(cases)('%s: gọi axios với signal + maxBodyLength + responseType stream, không ném cho non-2xx', async (_n, run) => {
    (axios.post as jest.Mock).mockResolvedValue({ status: 200, data: { ok: true } });
    const res = await run();
    expect(res.status).toBe(200);
    expect(res.error).toBeUndefined();
    const opts = (axios.post as jest.Mock).mock.calls[0][2];
    expect(opts).toMatchObject({ timeout: SEND_TIMEOUT_MS, maxBodyLength: 65536, maxRedirects: 0, responseType: 'stream' });
    expect(opts).not.toHaveProperty('maxContentLength');
    expect(opts.validateStatus(503)).toBe(true);
    expect(opts.signal).toBeInstanceOf(AbortSignal);
  });

  it.each(cases)('%s: non-2xx -> status giữ nguyên + error "Request failed with status code"', async (_n, run) => {
    (axios.post as jest.Mock).mockResolvedValue({ status: 503, data: 'down' });
    const res = await run();
    expect(res.status).toBe(503);
    expect(res.error).toBe('Request failed with status code 503');
    expect(res.body).toBe('down');
  });

  it.each(cases)('%s: bị abort (ERR_CANCELED) -> SendResult 500 retryable như timeout, không throw', async (_n, run) => {
    const err: any = new Error('canceled');
    err.code = 'ERR_CANCELED';
    err.name = 'CanceledError';
    (axios.post as jest.Mock).mockRejectedValue(err);
    const res = await run();
    expect(res.status).toBe(500);
    expect(res.error).toMatch(/timeout/i);
    expect(typeof res.durationMs).toBe('number');
  });

  it.each(cases)('%s: idle timeout (ECONNABORTED) vẫn 500 như trước', async (_n, run) => {
    const err: any = new Error('timeout of 5000ms exceeded');
    err.code = 'ECONNABORTED';
    (axios.post as jest.Mock).mockRejectedValue(err);
    const res = await run();
    expect(res.status).toBe(500);
  });
});
