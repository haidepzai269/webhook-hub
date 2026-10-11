import { createPublicKey, KeyObject, verify as cryptoVerify } from 'crypto';

/**
 * AU5b (ADR-127): kiểm ID token của Google (OpenID Connect Core §3.1.3.7) — tự làm bằng `crypto` của Node, không thêm
 * thư viện: chữ ký RS256 theo JWKS của Google (cache theo `Cache-Control: max-age`, `kid` lạ -> tải lại MỘT lần, có
 * giãn cách để `kid` rác không biến thành vòng gọi Google), `iss`, `aud`, `exp`/`iat` (lệch giờ ±60 s), `nonce`.
 */
export const GOOGLE_ISSUERS = ['accounts.google.com', 'https://accounts.google.com'] as const;
const SKEW_S = 60;
const DEFAULT_JWKS_TTL_MS = 60 * 60_000;
const MIN_REFETCH_MS = 30_000;

export interface GoogleIdClaims {
  sub: string;
  email: string;
  emailVerified: boolean;
  name: string;
  /** Workspace: domain của tổ chức (GO-2). */
  hd?: string;
}

export class IdTokenError extends Error {
  constructor(readonly reason: string) {
    super(`ID token không hợp lệ: ${reason}`);
  }
}

interface Jwk {
  kid?: string;
  kty?: string;
  alg?: string;
  n?: string;
  e?: string;
  use?: string;
}

export class GoogleJwks {
  private keys = new Map<string, KeyObject>();
  private expiresAt = 0;
  private lastFetch = 0;
  private inflight: Promise<void> | null = null;

  constructor(
    private readonly url: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  /** Khoá theo `kid`. Cache hết hạn -> tải lại; `kid` không có (Google xoay khoá) -> tải lại ngay, tối đa 1 lần / 30 s. */
  async key(kid: string): Promise<KeyObject> {
    if (this.now() >= this.expiresAt) await this.refresh();
    let k = this.keys.get(kid);
    if (!k && this.now() - this.lastFetch >= MIN_REFETCH_MS) {
      await this.refresh();
      k = this.keys.get(kid);
    }
    if (!k) throw new IdTokenError('kid_unknown');
    return k;
  }

  private refresh(): Promise<void> {
    this.inflight ??= this.load().finally(() => (this.inflight = null));
    return this.inflight;
  }

  private async load(): Promise<void> {
    this.lastFetch = this.now();
    const res = await this.fetchImpl(this.url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new IdTokenError(`jwks_http_${res.status}`);
    const body = (await res.json()) as { keys?: Jwk[] };
    const next = new Map<string, KeyObject>();
    for (const j of body.keys ?? []) {
      if (j.kty !== 'RSA' || !j.kid || !j.n || !j.e || (j.alg && j.alg !== 'RS256') || (j.use && j.use !== 'sig')) continue;
      next.set(j.kid, createPublicKey({ key: { kty: 'RSA', n: j.n, e: j.e }, format: 'jwk' }));
    }
    this.keys = next;
    const maxAge = /max-age=(\d+)/.exec(res.headers?.get?.('cache-control') ?? '')?.[1];
    this.expiresAt = this.now() + (maxAge ? Number(maxAge) * 1000 : DEFAULT_JWKS_TTL_MS);
  }
}

function part(s: string): Record<string, unknown> {
  try {
    return JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));
  } catch {
    throw new IdTokenError('malformed');
  }
}

/** Kiểm đủ chữ ký + claim; trả `sub`, `email`, `email_verified`, `name`. Sai bất kỳ -> `IdTokenError(lý do)`. */
export async function verifyGoogleIdToken(
  token: string,
  opts: { jwks: GoogleJwks; clientId: string; nonce: string; now?: () => number },
): Promise<GoogleIdClaims> {
  const segs = typeof token === 'string' ? token.split('.') : [];
  if (segs.length !== 3) throw new IdTokenError('malformed');
  const [h, p, sig] = segs;
  const header = part(h);
  if (header.alg !== 'RS256') throw new IdTokenError('alg');
  if (typeof header.kid !== 'string' || !header.kid) throw new IdTokenError('kid_missing');
  const key = await opts.jwks.key(header.kid);
  if (!cryptoVerify('RSA-SHA256', Buffer.from(`${h}.${p}`), key, Buffer.from(sig, 'base64url'))) throw new IdTokenError('signature');
  const c = part(p);
  const nowS = Math.floor((opts.now ?? Date.now)() / 1000);
  if (!GOOGLE_ISSUERS.includes(c.iss as (typeof GOOGLE_ISSUERS)[number])) throw new IdTokenError('iss');
  const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
  // GO-3: có `azp` thì phải bằng client id (kể cả khi aud là chuỗi); aud là mảng thì azp bắt buộc.
  if (!aud.includes(opts.clientId) || (c.azp !== undefined && c.azp !== opts.clientId) || (Array.isArray(c.aud) && c.azp === undefined)) {
    throw new IdTokenError('aud');
  }
  if (typeof c.exp !== 'number' || c.exp + SKEW_S < nowS) throw new IdTokenError('expired');
  if (typeof c.iat === 'number' && c.iat - SKEW_S > nowS) throw new IdTokenError('iat_future');
  if (!opts.nonce || typeof c.nonce !== 'string' || c.nonce !== opts.nonce) throw new IdTokenError('nonce');
  if (typeof c.sub !== 'string' || !c.sub || c.sub.length > 255) throw new IdTokenError('sub');
  if (typeof c.email !== 'string' || !c.email) throw new IdTokenError('email');
  return {
    sub: c.sub,
    email: c.email,
    emailVerified: c.email_verified === true || c.email_verified === 'true',
    name: (typeof c.name === 'string' && c.name.trim() ? c.name.trim() : c.email.split('@')[0]).slice(0, 100),
    ...(typeof c.hd === 'string' && c.hd ? { hd: c.hd } : {}),
  };
}
