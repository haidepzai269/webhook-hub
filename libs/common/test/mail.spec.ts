import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createMailSender, mailTemplates } from '@hub/common';

/** SPEC-auth §5.9 + SPEC-verification §4.2: ba driver cùng giao diện MailSender. */
describe('MailSender (log | resend | capture)', () => {
  const msg = { to: 'an@vi-du.vn', subject: 'Xác minh email', html: '<p>x</p>', text: 'x' };

  it('capture: mỗi thư một file JSON trong MAIL_CAPTURE_DIR (runner e2e đọc link từ file, không grep log)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-'));
    await createMailSender({ MAIL_DRIVER: 'capture', MAIL_CAPTURE_DIR: dir }).send(msg);
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    expect(files).toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(path.join(dir, files[0]), 'utf8'))).toMatchObject(msg);
  });

  it('resend: POST https://api.resend.com/emails với Bearer RESEND_API_KEY + MAIL_FROM; lỗi HTTP -> ném', async () => {
    const calls: any[] = [];
    const fetchImpl = (async (url: string, init: any) => {
      calls.push({ url, init });
      return { ok: calls.length === 1, status: calls.length === 1 ? 200 : 422, text: async () => 'err' };
    }) as unknown as typeof fetch;
    const s = createMailSender({ MAIL_DRIVER: 'resend', RESEND_API_KEY: 're_test', MAIL_FROM: 'Hub <onboarding@resend.dev>' }, fetchImpl);
    await s.send(msg);
    expect(calls[0].url).toBe('https://api.resend.com/emails');
    expect(calls[0].init.headers.authorization).toBe('Bearer re_test');
    expect(JSON.parse(calls[0].init.body)).toEqual({ from: 'Hub <onboarding@resend.dev>', to: ['an@vi-du.vn'], subject: msg.subject, html: msg.html, text: msg.text });
    await expect(s.send(msg)).rejects.toThrow(/422/);
  });

  it('mặc định / log: không ném; resend thiếu key -> ném lúc tạo (không gửi im lặng vào hư không)', async () => {
    await expect(createMailSender({}).send(msg)).resolves.toBeUndefined();
    expect(() => createMailSender({ MAIL_DRIVER: 'resend' })).toThrow(/RESEND_API_KEY/);
    expect(() => createMailSender({ MAIL_DRIVER: 'lạ' })).toThrow(/MAIL_DRIVER/);
  });

  it('mẫu mail tiếng Việt có bản text thuần, link nằm trong cả html lẫn text; tên người được escape HTML', () => {
    const link = 'https://web.vn/verify-email?token=abc';
    for (const m of [mailTemplates.verifyEmail(link, '<b>An</b>'), mailTemplates.resetPassword(link, 'An'), mailTemplates.registerAttempt('https://web.vn/forgot-password')]) {
      expect(m.subject.length).toBeGreaterThan(0);
      expect(m.text).toContain('https://web.vn/');
      expect(m.html).toContain('https://web.vn/');
    }
    expect(mailTemplates.verifyEmail(link, '<b>An</b>').html).not.toContain('<b>An</b>');
  });
});
