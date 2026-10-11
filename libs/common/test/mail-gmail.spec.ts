import { createMailSender, GmailSender, buildMimeMessage, base64url, encodeHeaderWord, mailConfigProblems, logger } from '@hub/common';

/** ADR-124: MAIL_DRIVER=gmail — Gmail API qua HTTPS + OAuth2. HTTP luôn là fetch GIẢ, không bao giờ gọi Google thật. */
const CFG = { clientId: 'cid.apps.googleusercontent.com', clientSecret: 'GOCSPX-secret', refreshToken: '1//refresh-token-bi-mat', from: 'Webhook Hub <hub.test@gmail.com>' };
const MSG = { to: 'nguoi.nhan@vi-du.vn', subject: 'Xác minh email của bạn — Webhook Hub', text: 'Chào An, bấm link: https://x/verify-email?token=abc', html: '<p>Chào <b>An</b></p>' };

type Call = { url: string; init: any };
function fakeGoogle(opts: { sendStatuses?: number[]; tokenError?: string; expiresIn?: number } = {}) {
  const calls: Call[] = [];
  const sendStatuses = [...(opts.sendStatuses ?? [200])];
  let n = 0;
  const json = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });
  const fetchImpl = (async (url: string, init: any) => {
    calls.push({ url, init });
    if (url === 'https://oauth2.googleapis.com/token') {
      if (opts.tokenError) return json({ error: opts.tokenError, error_description: 'Token has been expired or revoked.' }, 400);
      n += 1;
      return json({ access_token: `ya29.token-${n}`, expires_in: opts.expiresIn ?? 3599, token_type: 'Bearer' });
    }
    if (url === 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send') {
      const status = sendStatuses.length > 1 ? sendStatuses.shift()! : sendStatuses[0];
      return json(status < 400 ? { id: 'm1' } : { error: { code: status } }, status);
    }
    return json({}, 404);
  }) as unknown as typeof fetch;
  return { calls, fetchImpl, tokenCalls: () => calls.filter((c) => c.url.includes('oauth2')), sendCalls: () => calls.filter((c) => c.url.includes('gmail.googleapis')) };
}
const decodeRaw = (raw: string) => Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');

describe('MAIL_DRIVER=gmail (Gmail API + OAuth2, ADR-124)', () => {
  it('[AU:GM1] access token lấy bằng refresh_token rồi GIỮ trong bộ nhớ; còn < 60 s thì làm mới; nhiều thư cùng lúc dùng chung một lần làm mới', async () => {
    const g = fakeGoogle({ expiresIn: 3600 });
    let t = 1_000_000;
    const s = new GmailSender(CFG, g.fetchImpl, () => t);
    await Promise.all([s.send(MSG), s.send(MSG), s.send(MSG)]);
    expect(g.tokenCalls()).toHaveLength(1);
    const form = new URLSearchParams(g.tokenCalls()[0].init.body);
    expect(Object.fromEntries(form)).toEqual({ grant_type: 'refresh_token', client_id: CFG.clientId, client_secret: CFG.clientSecret, refresh_token: CFG.refreshToken });
    expect(g.sendCalls().map((c) => c.init.headers.authorization)).toEqual(Array(3).fill('Bearer ya29.token-1'));
    t += 3600_000 - 61_000; // còn 61 s -> vẫn dùng
    await s.send(MSG);
    expect(g.tokenCalls()).toHaveLength(1);
    t += 2_000; // còn 59 s -> làm mới
    await s.send(MSG);
    expect(g.tokenCalls()).toHaveLength(2);
    expect(g.sendCalls().at(-1)!.init.headers.authorization).toBe('Bearer ya29.token-2');
    expect(g.sendCalls()[0].init.signal).toBeInstanceOf(AbortSignal); // có timeout
  });

  it('[AU:GM2] (phần a) Gmail trả 401 -> làm mới token MỘT lần rồi gửi lại; 401 lần nữa -> ném (không lặp vô hạn)', async () => {
    const ok = fakeGoogle({ sendStatuses: [401, 200] });
    await new GmailSender(CFG, ok.fetchImpl).send(MSG);
    expect(ok.tokenCalls()).toHaveLength(2);
    expect(ok.sendCalls().map((c) => c.init.headers.authorization)).toEqual(['Bearer ya29.token-1', 'Bearer ya29.token-2']);
    const bad = fakeGoogle({ sendStatuses: [401] });
    await expect(new GmailSender(CFG, bad.fetchImpl).send(MSG)).rejects.toThrow(/HTTP 401/);
    expect(bad.sendCalls()).toHaveLength(2);
  });

  it('[AU:GM3] invalid_grant -> log lỗi RÕ cho operator (refresh token bị thu hồi/hết hạn), ném; log không chứa token/secret', async () => {
    const g = fakeGoogle({ tokenError: 'invalid_grant' });
    const spy = jest.spyOn(logger, 'error').mockImplementation(() => undefined as any);
    try {
      await expect(new GmailSender(CFG, g.fetchImpl).send(MSG)).rejects.toThrow(/invalid_grant/);
      const logged = JSON.stringify(spy.mock.calls);
      expect(logged).toMatch(/GOOGLE_REFRESH_TOKEN.*(thu hồi|hết hạn)/);
      for (const secret of [CFG.refreshToken, CFG.clientSecret]) expect(logged).not.toContain(secret);
      expect(g.sendCalls()).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });

  it('[AU:GM4] (phần a) raw = base64url của thư RFC 2822 multipart/alternative: Subject tiếng Việt là encoded-word UTF-8, text + html giải mã ra đúng', async () => {
    const g = fakeGoogle();
    await createMailSender({ MAIL_DRIVER: 'gmail', GOOGLE_CLIENT_ID: CFG.clientId, GOOGLE_CLIENT_SECRET: CFG.clientSecret, GOOGLE_REFRESH_TOKEN: CFG.refreshToken, MAIL_FROM: 'Trạm Webhook <hub.test@gmail.com>' }, g.fetchImpl).send(MSG);
    const raw: string = JSON.parse(g.sendCalls()[0].init.body).raw;
    expect(raw).toMatch(/^[A-Za-z0-9_-]+$/); // base64url, không '+', '/', '='
    const mime = decodeRaw(raw);
    const cut = mime.indexOf('\r\n\r\n');
    const head = mime.slice(0, cut);
    const body = mime.slice(cut + 4);
    expect(head).toMatch(/^From: =\?UTF-8\?B\?[^?]+\?= <hub\.test@gmail\.com>\r\nTo: nguoi\.nhan@vi-du\.vn\r\nSubject: /);
    expect(head).toContain('MIME-Version: 1.0');
    const boundary = /boundary="([^"]+)"/.exec(head)![1];
    // Subject: giải từng encoded-word ra đúng chuỗi gốc; mỗi dòng header ≤ 78 ký tự
    const subj = /Subject: ([\s\S]*?)\r\nMIME/.exec(head)![1];
    const words = [...subj.matchAll(/=\?UTF-8\?B\?([^?]+)\?=/g)].map((w) => Buffer.from(w[1], 'base64').toString('utf8'));
    expect(words.join('')).toBe(MSG.subject);
    for (const line of head.split('\r\n')) expect(line.length).toBeLessThanOrEqual(78);
    const parts = body.split(`--${boundary}`).filter((p) => p.includes('Content-Type'));
    const dec = (p: string) => Buffer.from(p.split('\r\n\r\n')[1].replace(/\s+/g, ''), 'base64').toString('utf8');
    expect(parts[0]).toContain('text/plain; charset="UTF-8"');
    expect(dec(parts[0])).toBe(MSG.text);
    expect(parts[1]).toContain('text/html; charset="UTF-8"');
    expect(dec(parts[1])).toBe(MSG.html);
    expect(body.trimEnd().endsWith(`--${boundary}--`)).toBe(true);
    expect(encodeHeaderWord('Thư mời')).toMatch(/^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
    expect(encodeHeaderWord('Plain ASCII')).toBe('Plain ASCII');
    expect(base64url('ÿÿ>?')).not.toMatch(/[+/=]/);
  });

  it('[AU:GM5] (phần a) CRLF injection ở To / Subject / From bị TỪ CHỐI (ném trước khi gọi mạng), không làm sạch ngầm', async () => {
    for (const bad of [
      { ...MSG, to: 'a@b.vn\r\nBcc: victim@x.vn' },
      { ...MSG, subject: 'Xin chào\r\nBcc: victim@x.vn' },
      { ...MSG, subject: 'Xin chào\nX-Evil: 1' },
      { ...MSG, to: 'khong-phai-email' },
    ]) {
      const g = fakeGoogle();
      await expect(new GmailSender(CFG, g.fetchImpl).send(bad)).rejects.toThrow(/CRLF|không hợp lệ/);
      expect(g.calls).toHaveLength(0);
    }
    expect(() => buildMimeMessage('Hub <a@b.vn>\r\nBcc: x@y.vn', MSG)).toThrow(/CRLF/);
  });

  it('[AU:GM2] (phần b) G-3: lỗi send chỉ mang status + mã lỗi Google, KHÔNG chép body lỗi (có thể chứa địa chỉ/header)', async () => {
    const fetchImpl = (async (url: string) => {
      if (url.includes('oauth2')) return { ok: true, status: 200, json: async () => ({ access_token: 't', expires_in: 3600 }) };
      const body = { error: { code: 400, status: 'INVALID_ARGUMENT', message: 'Invalid To header: nguoi.nhan@vi-du.vn Bcc...', errors: [{ reason: 'invalidArgument' }] } };
      return { ok: false, status: 400, json: async () => body, text: async () => JSON.stringify(body) };
    }) as unknown as typeof fetch;
    const err = await new GmailSender(CFG, fetchImpl).send(MSG).catch((e: Error) => e);
    expect((err as Error).message).toBe('Gmail send trả HTTP 400 (INVALID_ARGUMENT/invalidArgument)');
  });

  it('[AU:GM4] (phần b) G-2: có Date (RFC 5322) + Message-ID @ domain của MAIL_FROM; Subject ASCII dài được gập (mọi dòng ≤ 78) và giải ra đúng', async () => {
    const long = 'Webhook Hub notification '.repeat(48).trim(); // ~1200 ký tự ASCII
    const mime = buildMimeMessage('Webhook Hub <hub.test@gmail.com>', { ...MSG, subject: long });
    const head = mime.slice(0, mime.indexOf('\r\n\r\n'));
    expect(head).toMatch(/\r\nDate: [A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT\r\n/);
    expect(head).toMatch(/\r\nMessage-ID: <[0-9a-f-]{36}@gmail\.com>\r\n/);
    for (const line of head.split('\r\n')) expect(line.length).toBeLessThanOrEqual(78);
    const subj = /Subject: ([\s\S]*?)\r\nDate/.exec(head)![1];
    const words = [...subj.matchAll(/=\?UTF-8\?B\?([^?]+)\?=/g)].map((w) => Buffer.from(w[1], 'base64').toString('utf8'));
    expect(words.join('')).toBe(long);
    expect(encodeHeaderWord('Ngắn')).toMatch(/^=\?UTF-8\?B\?/);
    expect(encodeHeaderWord('Short ASCII')).toBe('Short ASCII');
  });

  it('[AU:GM5] (phần b) G-1: ký tự điều khiển không-ASCII (U+0085 NEL, U+2028/2029, C1) trong địa chỉ / Subject / tên -> từ chối, không gọi mạng', async () => {
    const NEL = String.fromCharCode(0x85);
    for (const bad of [
      { ...MSG, to: `a${NEL}b@vi-du.vn` },
      { ...MSG, to: 'nguời@vi-du.vn' },
      { ...MSG, subject: `Xin chào${String.fromCharCode(0x2028)}Bcc: x@y.vn` },
      { ...MSG, subject: `Xin chào${String.fromCharCode(0x9b)}x` },
    ]) {
      const g = fakeGoogle();
      await expect(new GmailSender(CFG, g.fetchImpl).send(bad)).rejects.toThrow(/điều khiển|không hợp lệ/);
      expect(g.calls).toHaveLength(0);
    }
    expect(() => buildMimeMessage(`Hub${String.fromCharCode(0x2029)} <a@b.vn>`, MSG)).toThrow(/điều khiển/);
  });

  it('[AU:GM6] kiểm lúc khởi động: MAIL_DRIVER=gmail thiếu biến nào -> nêu TÊN biến (không giá trị); đủ -> không lỗi; driver khác không đòi', () => {
    const full = { MAIL_DRIVER: 'gmail', GOOGLE_CLIENT_ID: 'a', GOOGLE_CLIENT_SECRET: 'b', GOOGLE_REFRESH_TOKEN: 'c', MAIL_FROM: 'Hub <x@gmail.com>' };
    expect(mailConfigProblems(full)).toEqual([]);
    expect(mailConfigProblems({ MAIL_DRIVER: 'gmail' })).toEqual([
      'MAIL_DRIVER=gmail nhưng thiếu GOOGLE_CLIENT_ID',
      'MAIL_DRIVER=gmail nhưng thiếu GOOGLE_CLIENT_SECRET',
      'MAIL_DRIVER=gmail nhưng thiếu GOOGLE_REFRESH_TOKEN',
      'MAIL_DRIVER=gmail nhưng thiếu MAIL_FROM',
    ]);
    expect(mailConfigProblems({ ...full, MAIL_FROM: 'khong hop le' })).toHaveLength(1);
    expect(JSON.stringify(mailConfigProblems({ ...full, GOOGLE_REFRESH_TOKEN: '' }))).not.toContain('"c"');
    expect(mailConfigProblems({ MAIL_DRIVER: 'log' })).toEqual([]);
    expect(() => createMailSender({ MAIL_DRIVER: 'gmail' })).toThrow(/GOOGLE_CLIENT_ID/);
    const { authSecretProblems } = require('../../../apps/hub-api/src/modules/auth/auth-config');
    const secrets = { JWT_SECRET: 'j'.repeat(40), CSRF_SECRET: 'c'.repeat(40), SOCKET_TICKET_SECRET: 's'.repeat(40), OAUTH_COOKIE_SECRET: 'o'.repeat(40) };
    expect(authSecretProblems({ ...secrets, MAIL_DRIVER: 'gmail' })).toContain('MAIL_DRIVER=gmail nhưng thiếu GOOGLE_REFRESH_TOKEN');
  });
});
