/**
 * VF3 (SPEC-verification §5.2–§5.4): fixture = file dữ liệu đầu vào CỐ ĐỊNH (`fixtures/<provider>/<case>.json`).
 * Body giữ dạng BYTES (`bodyBase64`) — không parse rồi stringify lại. Mọi fixture được KÝ LẠI lúc phát bằng secret
 * giả (§5.3); chỉ ca `fixedAt` (Stripe cũ) giữ nguyên `t` để chứng minh chống phát lại.
 */
import * as fs from 'fs';
import * as path from 'path';
import { genericHmac, githubSignature256, payosSignature, sepayAuthorization, stripeSignatureHeader, swHeaders, tamperOneChar } from './sign';

export type SimProvider = 'payos' | 'sepay' | 'stripe' | 'github' | 'generic';

export interface SignatureSpec {
  scheme: 'payos-body-field' | 'sepay-apikey' | 'stripe' | 'github' | 'generic-hmac' | 'standard-webhooks' | 'none';
  timestamped: boolean;
  /** Đổi 1 ký tự của chữ ký sau khi ký đúng. */
  tamper?: boolean;
  /** Stripe: dùng `t` cố định (ISO 8601, không viết epoch để gate fixture-account khỏi nhầm số tài khoản) (KHÔNG ký lại thời gian) — ca chống phát lại. */
  fixedAt?: string;
  /** SePay: tiền tố của Authorization (mặc định "Apikey "; "" = ca thiếu tiền tố). */
  authPrefix?: string;
  /** generic-hmac: đặt chữ ký vào header KHÁC header source khai (ca lắng nghe báo sai header). */
  headerOverride?: string;
}

export interface FixtureExpect {
  /** HTTP hub trả cho provider. */
  status: 200 | 401;
  /** Kiểu chuẩn sau normalize (khi 200). */
  type?: string;
  normalized?: boolean;
  /**
   * Request kiểm tra của provider (ADR-159): hub lưu event nhưng KHÔNG định tuyến, KHÔNG trả ở polling — runner L2
   * kiểm 0 delivery + vắng ở polling thay vì chờ event hiện ra.
   */
  probe?: boolean;
  /** Ghi chú cho người đọc. */
  why?: string;
}

export interface Fixture {
  provider: SimProvider;
  case: string;
  origin: 'synthetic' | 'real';
  description: string;
  method: 'POST';
  headers: Record<string, string>;
  bodyBase64: string;
  signature: SignatureSpec;
  /** Body cố tình KHÁC `JSON.stringify` của chính nó (§5.4 "bytes lạ"). */
  oddBytes?: boolean;
  /** generic: `verificationConfig` của source nhận fixture này. */
  sourceConfig?: Record<string, unknown>;
  expect: FixtureExpect;
}

export interface Prepared {
  method: 'POST';
  headers: Record<string, string>;
  body: Buffer;
}

export const FIXTURES_DIR = path.join(__dirname, '..', 'fixtures');
/** Thay trong body + header lúc phát (`--unique`): tạo sự kiện MỚI có chủ đích mà khoá chống trùng vẫn tất định. */
export const UNIQUE_TOKEN = '__U__';

export function listFixtures(dir = FIXTURES_DIR): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .flatMap((d) =>
      fs
        .readdirSync(path.join(dir, d.name))
        .filter((f) => f.endsWith('.json'))
        .map((f) => `${d.name}/${f.replace(/\.json$/, '')}`),
    )
    .sort();
}

export function loadFixture(id: string, dir = FIXTURES_DIR): Fixture {
  if (!/^[a-z]+\/[a-z0-9-]+$/.test(id)) throw new Error(`id fixture dạng <provider>/<case>: ${id}`);
  const f = JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), 'utf8')) as Fixture;
  if (`${f.provider}/${f.case}` !== id) throw new Error(`fixture ${id}: provider/case trong file không khớp tên file`);
  return f;
}

export function bodyOf(f: Fixture): Buffer {
  return Buffer.from(f.bodyBase64, 'base64');
}

/** Ký lại fixture bằng `secret` (phía PROVIDER) tại thời điểm `nowS`. Trả bytes + header sẵn sàng gửi. */
export function prepare(f: Fixture, secret: string, opts: { nowS?: number; unique?: string } = {}): Prepared {
  const nowS = opts.nowS ?? Math.floor(Date.now() / 1000);
  const u = opts.unique ?? '0';
  // Chỉ chữ số: chỗ giữ có thể nằm trong số JSON (vd SePay `id`) — chữ cái sẽ làm hỏng body.
  if (!/^[0-9]{1,9}$/.test(u)) throw new Error('--unique là 1–9 chữ số');
  const sub = (s: string) => s.split(UNIQUE_TOKEN).join(u);
  let body = Buffer.from(sub(bodyOf(f).toString('utf8')), 'utf8');
  const headers: Record<string, string> = Object.fromEntries(Object.entries(f.headers).map(([k, v]) => [k.toLowerCase(), sub(v)]));
  const sig = f.signature;
  const maybeTamper = (s: string) => (sig.tamper ? tamperOneChar(s) : s);

  switch (sig.scheme) {
    case 'payos-body-field': {
      // Chữ ký nằm TRONG body: thay đúng chuỗi giữ chỗ, mọi byte khác giữ nguyên.
      const text = body.toString('utf8');
      if (!text.includes('__SIG__')) throw new Error(`${f.case}: body PayOS thiếu "__SIG__"`);
      const data = JSON.parse(text).data;
      body = Buffer.from(text.replace('__SIG__', maybeTamper(payosSignature(data, secret))), 'utf8');
      break;
    }
    case 'sepay-apikey':
      headers['authorization'] = maybeTamper(sepayAuthorization(secret, sig.authPrefix ?? 'Apikey '));
      break;
    case 'stripe':
      headers['stripe-signature'] = maybeTamper(stripeSignatureHeader(body, secret, sig.fixedAt ? Math.floor(Date.parse(sig.fixedAt) / 1000) : nowS));
      break;
    case 'github':
      headers['x-hub-signature-256'] = maybeTamper(githubSignature256(body, secret));
      break;
    case 'generic-hmac': {
      const c = (f.sourceConfig ?? {}) as { header?: string; encoding?: 'hex' | 'base64'; prefix?: string };
      if (!c.header) throw new Error(`${f.case}: generic-hmac cần sourceConfig.header`);
      headers[sig.headerOverride ?? c.header] = maybeTamper(genericHmac(body, secret, c.encoding ?? 'hex', c.prefix ?? ''));
      break;
    }
    case 'standard-webhooks': {
      const id = headers['webhook-id'] ?? `msg_sim_${u}`;
      Object.assign(headers, swHeaders(secret, id, nowS, body));
      if (sig.tamper) headers['webhook-signature'] = tamperOneChar(headers['webhook-signature']);
      break;
    }
    case 'none':
      break;
  }
  if (!headers['content-type']) headers['content-type'] = 'application/json';
  return { method: 'POST', headers, body };
}

/** Body có "bytes lạ" thật không: bytes ≠ JSON.stringify(JSON.parse(bytes)). */
export function isOddBytes(body: Buffer): boolean {
  const text = body.toString('utf8');
  return JSON.stringify(JSON.parse(text)) !== text;
}
