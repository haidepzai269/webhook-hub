import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { logger } from '../logger';
import { GmailSender, loadGmailConfig } from './gmail';

export * from './gmail';

/**
 * SPEC-auth §5.9 + SPEC-verification §4.2: một giao diện, ba driver.
 *   log     (mặc định, local): in thư ra log mức info — link nằm trong log, CHỈ dùng ở máy dev;
 *   gmail   : Gmail API qua HTTPS + OAuth2 refresh token (GOOGLE_CLIENT_ID/SECRET/REFRESH_TOKEN, MAIL_FROM) — ADR-124;
 *   resend  : gọi API Resend (RESEND_API_KEY, MAIL_FROM). Chưa xác minh domain thì Resend chỉ gửi tới email chủ tài khoản;
 *   capture : ghi mỗi thư một file JSON vào MAIL_CAPTURE_DIR — CHỈ stack kiểm chứng (production + capture -> app thoát,
 *             xem test-only-config.ts). Runner e2e đọc link từ file, không grep log.
 * Muốn nhà khác (Brevo, SendGrid…) thì thêm driver, giao diện không đổi.
 */
export interface MailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export interface MailSender {
  send(m: MailMessage): Promise<void>;
}

export const MAIL_SENDER = Symbol('MAIL_SENDER');

export function createMailSender(env: Record<string, string | undefined> = process.env, fetchImpl: typeof fetch = fetch): MailSender {
  const driver = (env.MAIL_DRIVER ?? 'log').trim().toLowerCase() || 'log';
  if (driver === 'log') {
    return {
      async send(m) {
        logger.info({ to: m.to, subject: m.subject }, `MAIL (driver log, chỉ dùng ở local):\n${m.text}`);
      },
    };
  }
  if (driver === 'capture') {
    const dir = env.MAIL_CAPTURE_DIR || path.join(process.cwd(), 'mail-capture');
    return {
      async send(m) {
        await fs.promises.mkdir(dir, { recursive: true });
        const file = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}.json`);
        // Ghi NGUYÊN TỬ (file tạm + rename): runner e2e đọc thư mục song song không bao giờ thấy JSON ghi dở.
        await fs.promises.writeFile(`${file}.tmp`, JSON.stringify({ ...m, at: new Date().toISOString() }, null, 2));
        await fs.promises.rename(`${file}.tmp`, file);
      },
    };
  }
  if (driver === 'resend') {
    const key = (env.RESEND_API_KEY ?? '').trim();
    if (!key) throw new Error('MAIL_DRIVER=resend nhưng thiếu RESEND_API_KEY');
    const from = (env.MAIL_FROM ?? '').trim() || 'Webhook Hub <onboarding@resend.dev>';
    return {
      async send(m) {
        const res = await fetchImpl('https://api.resend.com/emails', {
          method: 'POST',
          headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
          body: JSON.stringify({ from, to: [m.to], subject: m.subject, html: m.html, text: m.text }),
        });
        if (!res.ok) throw new Error(`Resend trả HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      },
    };
  }
  if (driver === 'gmail') return new GmailSender(loadGmailConfig(env), fetchImpl);
  throw new Error(`MAIL_DRIVER không hợp lệ: "${driver}" (log | resend | gmail | capture)`);
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function layout(title: string, paragraphs: string[], link?: { href: string; label: string }) {
  const html = [
    `<div style="font-family:system-ui,sans-serif;max-width:560px">`,
    `<h2>${esc(title)}</h2>`,
    ...paragraphs.map((p) => `<p>${esc(p)}</p>`),
    link ? `<p><a href="${esc(link.href)}">${esc(link.label)}</a></p><p style="color:#666;font-size:12px">${esc(link.href)}</p>` : '',
    `<p style="color:#666;font-size:12px">Webhook Hub</p></div>`,
  ].join('\n');
  const text = [title, '', ...paragraphs, ...(link ? ['', `${link.label}: ${link.href}`] : []), '', '— Webhook Hub'].join('\n');
  return { html, text };
}

/** Mẫu mail tiếng Việt, có bản text thuần (SPEC-auth §5.9). Tên người dùng luôn được escape HTML. */
export const mailTemplates = {
  verifyEmail(link: string, name: string) {
    return {
      subject: 'Xác minh email của bạn — Webhook Hub',
      ...layout(`Chào ${name},`, ['Bấm link dưới để xác minh email. Link dùng được một lần, hết hạn sau 24 giờ.', 'Nếu bạn không đăng ký, hãy bỏ qua thư này.'], {
        href: link,
        label: 'Xác minh email',
      }),
    };
  },
  resetPassword(link: string, name: string) {
    return {
      subject: 'Đặt lại mật khẩu — Webhook Hub',
      ...layout(`Chào ${name},`, ['Có yêu cầu đặt lại mật khẩu cho tài khoản này. Link dùng được một lần, hết hạn sau 1 giờ.', 'Đặt lại xong, mọi thiết bị đang đăng nhập sẽ bị đăng xuất.', 'Nếu không phải bạn, hãy bỏ qua thư này — mật khẩu không đổi.'], {
        href: link,
        label: 'Đặt lại mật khẩu',
      }),
    };
  },
  /** §5.2: đăng ký bằng email đã có tài khoản — báo chủ email, KHÔNG kèm token nào. */
  registerAttempt(forgotLink: string) {
    return {
      subject: 'Có người vừa thử đăng ký bằng email của bạn — Webhook Hub',
      ...layout('Có người vừa thử đăng ký Webhook Hub bằng email của bạn.', ['Email này đã có tài khoản nên không có tài khoản mới nào được tạo.', 'Nếu là bạn và quên mật khẩu, dùng link dưới. Nếu không phải bạn, không cần làm gì.'], {
        href: forgotLink,
        label: 'Quên mật khẩu',
      }),
    };
  },
  invite(link: string, projectName: string, role: string, inviter: string) {
    return {
      subject: `Lời mời vào project "${projectName}" — Webhook Hub`,
      ...layout('Bạn được mời vào một project', [`${inviter} mời bạn vào project "${projectName}" với vai trò ${role}.`, 'Link dùng được một lần, hết hạn sau 7 ngày.'], {
        href: link,
        label: 'Nhận lời mời',
      }),
    };
  },
  githubLinked(name: string) {
    return {
      subject: 'GitHub vừa được liên kết với tài khoản của bạn — Webhook Hub',
      ...layout(`Chào ${name},`, ['Tài khoản GitHub vừa được liên kết; từ giờ bạn đăng nhập được bằng GitHub.', 'Nếu không phải bạn, hãy đổi mật khẩu và gỡ liên kết GitHub ngay.']),
    };
  },
};
