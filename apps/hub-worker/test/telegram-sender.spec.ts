jest.mock('axios', () => ({ __esModule: true, default: { post: jest.fn() } }));
jest.mock('@hub/crypto', () => ({
  createSsrfSafeAxiosConfig: jest.fn(async (url: string) => ({ url, httpAgent: undefined, httpsAgent: undefined })),
}));

import axios from 'axios';
import { TelegramSender } from '../src/senders/telegram.sender';

/** S1-7: Telegram gửi văn bản THUẦN — '_' hay '*' lẻ trong dữ liệu không còn làm Telegram trả 400. */
describe('TelegramSender (S1-7)', () => {
  it('payload không có parse_mode, giữ nguyên ký tự _a_b*c', async () => {
    (axios.post as jest.Mock).mockResolvedValue({ status: 200, data: { ok: true } });
    const res = await new TelegramSender().send(
      { botToken: '123:mock-token', chatId: '-1', apiUrl: 'http://hub-api:4000/mock/telegram' },
      'Nội dung _a_b*c [x',
      { id: 'e', type: 't', source: 'sepay' } as any,
    );
    expect(res.status).toBe(200);
    const [url, payload] = (axios.post as jest.Mock).mock.calls[0];
    expect(url).toBe('http://hub-api:4000/mock/telegram/bot123:mock-token/sendMessage');
    expect(payload).not.toHaveProperty('parse_mode');
    expect(payload).toEqual({ chat_id: '-1', text: 'Nội dung _a_b*c [x' });
  });
});
