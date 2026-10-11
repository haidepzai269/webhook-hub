import { randomBytes, randomUUID } from 'crypto';
import { logger } from '../logger';
import type { MailMessage, MailSender } from './index';

/**
 * ADR-124: driver `MAIL_DRIVER=gmail` — Gmail API qua HTTPS + OAuth2 (refresh token), KHÔNG SMTP (Render free chặn cổng
 * SMTP). Access token giữ trong BỘ NHỚ tới ~60 s trước khi hết hạn (không Redis — ngân sách R1). Không bao giờ log token.
 */
export const GMAIL_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GMAIL_SEND_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';
const TIMEOUT_MS = 10_000;
const EARLY_REFRESH_MS = 60_000;

export interface GmailConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  from: string;
}

const GMAIL_VARS = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN', 'MAIL_FROM'] as const;

/** Kiểm lúc khởi động (hub-api thoát nếu có lỗi). Chỉ trả TÊN biến, không bao giờ giá trị. */
export function mailConfigProblems(env: Record<string, string | undefined> = process.env): string[] {
  const driver = (env.MAIL_DRIVER ?? 'log').trim().toLowerCase();
  if (driver === 'resend' && !(env.RESEND_API_KEY ?? '').trim()) return ['MAIL_DRIVER=resend nhưng thiếu RESEND_API_KEY'];
  if (driver !== 'gmail') return [];
  const problems = GMAIL_VARS.filter((k) => !(env[k] ?? '').trim()).map((k) => `MAIL_DRIVER=gmail nhưng thiếu ${k}`);
  const from = (env.MAIL_FROM ?? '').trim();
  if (from && !parseAddress(from)) problems.push('MAIL_FROM không phải địa chỉ email hợp lệ (vd "Webhook Hub <ban@gmail.com>")');
  return problems;
}

export function loadGmailConfig(env: Record<string, string | undefined>): GmailConfig {
  const problems = mailConfigProblems({ ...env, MAIL_DRIVER: 'gmail' });
  if (problems.length) throw new Error(problems.join('; '));
  return {
    clientId: env.GOOGLE_CLIENT_ID!.trim(),
    clientSecret: env.GOOGLE_CLIENT_SECRET!.trim(),
    refreshToken: env.GOOGLE_REFRESH_TOKEN!.trim(),
    from: env.MAIL_FROM!.trim(),
  };
}

// ------------------------------------------------------------------ MIME (RFC 2822 / 2045 / 2047)

/** G-1: C0 (U+0000–001F), DEL + C1 (U+007F–009F, gồm NEL U+0085), U+2028/2029 — dựng từ mã số cho khỏi lẫn ký tự thô trong nguồn. */
const CTRL_RE = new RegExp(`[${String.fromCharCode(0)}-${String.fromCharCode(0x1f)}${String.fromCharCode(0x7f)}-${String.fromCharCode(0x9f)}${String.fromCharCode(0x2028, 0x2029)}]`);

/** Header injection: giá trị header KHÔNG được chứa CR/LF (hoặc NUL) — ném thay vì làm sạch ngầm. */
export function assertHeaderSafe(field: string, value: string): void {
  if (/[\r\n\0]/.test(value)) throw new Error(`Header ${field} chứa ký tự xuống dòng — từ chối (chống CRLF injection)`);
  // G-1: mọi ký tự điều khiển C0/C1 (gồm U+0085 NEL) và U+2028/2029 cũng bị từ chối.
  if (CTRL_RE.test(value)) {
    throw new Error(`Header ${field} chứa ký tự điều khiển — từ chối (chống CRLF/NEL injection)`);
  }
}

const ADDR_RE = /^[^\s@<>()",;:\\[\]]+@[^\s@<>()",;:\\[\]]+\.[^\s@<>()",;:\\[\]]+$/;

/** `"Tên <a@b.c>"` hoặc `a@b.c` -> {name, address}; sai cú pháp -> null. */
export function parseAddress(v: string): { name: string; address: string } | null {
  const m = /^\s*(?:"?([^"<]*?)"?\s*)?<([^<>]+)>\s*$/.exec(v);
  const name = m ? (m[1] ?? '').trim() : '';
  const address = (m ? m[2] : v).trim();
  // G-1: địa chỉ chỉ gồm ASCII in được (không ghi byte lạ vào header dạng thô).
  return ADDR_RE.test(address) && /^[\x21-\x7e]+$/.test(address) ? { name, address } : null;
}

/** RFC 2047 encoded-word (UTF-8, B) — chỉ khi có ký tự ngoài ASCII in được; cắt theo ký tự, mỗi word ≤ 39 byte gốc (dòng "Subject: " + word ≤ 78 ký tự). */
export function encodeHeaderWord(s: string): string {
  // G-2: ASCII ngắn giữ nguyên; ASCII dài (> 70) cũng mã hoá để cắt thành nhiều word (mỗi dòng ≤ 78, RFC 5322).
  if (/^[\x20-\x7e]*$/.test(s) && s.length <= 70) return s;
  const words: string[] = [];
  let chunk = '';
  for (const ch of s) {
    if (Buffer.byteLength(chunk + ch, 'utf8') > 39) {
      words.push(chunk);
      chunk = '';
    }
    chunk += ch;
  }
  if (chunk) words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w, 'utf8').toString('base64')}?=`).join('\r\n ');
}

function formatAddress(field: string, v: string): string {
  assertHeaderSafe(field, v);
  const a = parseAddress(v);
  if (!a) throw new Error(`Header ${field}: địa chỉ email không hợp lệ`);
  if (!a.name) return a.address;
  const name = /^[\x20-\x7e]*$/.test(a.name) ? `"${a.name.replace(/["\\]/g, '')}"` : encodeHeaderWord(a.name);
  return `${name} <${a.address}>`;
}

const b64lines = (s: string) => (Buffer.from(s, 'utf8').toString('base64').match(/.{1,76}/g) ?? ['']).join('\r\n');

/** Thư RFC 2822 multipart/alternative (text + html), thân base64 UTF-8, header đã kiểm CRLF. */
export function buildMimeMessage(from: string, m: MailMessage, boundary = `hub_${randomBytes(12).toString('hex')}`): string {
  assertHeaderSafe('Subject', m.subject);
  const fromHeader = formatAddress('From', from);
  const domain = parseAddress(from)!.address.split('@')[1];
  return [
    `From: ${fromHeader}`,
    `To: ${formatAddress('To', m.to)}`,
    `Subject: ${encodeHeaderWord(m.subject)}`,
    `Date: ${new Date().toUTCString()}`, // G-2: RFC 5322 bắt buộc Date
    `Message-ID: <${randomUUID()}@${domain}>`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    b64lines(m.text),
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    b64lines(m.html),
    `--${boundary}--`,
    '',
  ].join('\r\n');
}

export const base64url = (s: string) => Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// ------------------------------------------------------------------ OAuth2 + gửi

export class GmailSender implements MailSender {
  private token: { value: string; expiresAt: number } | null = null;
  private refreshing: Promise<string> | null = null;

  constructor(
    private readonly cfg: GmailConfig,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  /** Access token trong bộ nhớ; còn < 60 s thì làm mới. `force` = bỏ cache (sau 401). Nhiều lời gọi cùng lúc dùng chung một lần làm mới. */
  async accessToken(force = false): Promise<string> {
    if (!force && this.token && this.now() < this.token.expiresAt - EARLY_REFRESH_MS) return this.token.value;
    this.refreshing ??= this.refresh().finally(() => (this.refreshing = null));
    return this.refreshing;
  }

  private async refresh(): Promise<string> {
    this.token = null;
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: this.cfg.clientId,
      client_secret: this.cfg.clientSecret,
      refresh_token: this.cfg.refreshToken,
    });
    const res = await this.fetchImpl(GMAIL_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const data = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string };
    if (!res.ok || !data.access_token) {
      if (data.error === 'invalid_grant') {
        logger.error(
          'Gmail: GOOGLE_REFRESH_TOKEN đã bị thu hồi hoặc hết hạn (invalid_grant) — lấy refresh token mới theo DEPLOYMENT.md §9 "Lấy GOOGLE_REFRESH_TOKEN" (app OAuth phải ở trạng thái In production, nếu không token Gmail hết hạn sau 7 ngày)',
        );
        throw new Error('Gmail OAuth: invalid_grant (refresh token bị thu hồi/hết hạn)');
      }
      throw new Error(`Gmail OAuth: đổi refresh token thất bại HTTP ${res.status}${data.error ? ` (${data.error})` : ''}`);
    }
    const ttl = Number.isFinite(data.expires_in) ? Number(data.expires_in) : 3600;
    this.token = { value: data.access_token, expiresAt: this.now() + ttl * 1000 };
    return data.access_token;
  }

  async send(m: MailMessage): Promise<void> {
    const raw = base64url(buildMimeMessage(this.cfg.from, m)); // ném TRƯỚC khi gọi mạng nếu header bẩn
    const post = (token: string) =>
      this.fetchImpl(GMAIL_SEND_URL, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ raw }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    let res = await post(await this.accessToken());
    if (res.status === 401) res = await post(await this.accessToken(true)); // token bị thu hồi sớm: làm mới MỘT lần
    if (!res.ok) {
      // G-3: KHÔNG chép body lỗi (có thể chứa header/địa chỉ người nhận) — chỉ status + mã lỗi của Google.
      const err = ((await res.json().catch(() => ({}))) as { error?: { status?: unknown; errors?: { reason?: unknown }[] } }).error;
      const code = [err?.status, err?.errors?.[0]?.reason].filter((x): x is string => typeof x === 'string' && /^[A-Za-z_]{1,64}$/.test(x)).join('/');
      throw new Error(`Gmail send trả HTTP ${res.status}${code ? ` (${code})` : ''}`);
    }
  }
}
