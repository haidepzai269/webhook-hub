'use strict';
/**
 * fake-google của stack `hubv` (AU5b, ADR-127) — đóng vai Google OIDC để e2e chạy trọn luồng mà KHÔNG gọi Google thật.
 * KHÔNG import gì từ apps/ hay libs/. hub-api chỉ trỏ vào đây khi GOOGLE_OAUTH_FAKE_BASE_URL đặt VÀ NODE_ENV ≠ production.
 *
 *   GET  /fake-google/o/oauth2/v2/auth   (như Google) + tham số test_sub, test_email, test_verified(=false), test_name, test_deny
 *        → 302 redirect_uri?code=…&state=…   (code mang sub/email/nonce/code_challenge, dùng MỘT lần)
 *   POST /fake-google/token              grant_type=authorization_code, kiểm client_id, redirect_uri, PKCE S256
 *        → {id_token (RS256, kid fake-1, iss https://accounts.google.com, aud = client_id, nonce), access_token, expires_in}
 *   GET  /fake-google/oauth2/v3/certs    JWKS
 */
const crypto = require('crypto');

const KID = 'fake-1';
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const JWK = { ...publicKey.export({ format: 'jwk' }), kid: KID, alg: 'RS256', use: 'sig' };
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

function idToken(claims) {
  const h = b64({ alg: 'RS256', kid: KID, typ: 'JWT' });
  const p = b64(claims);
  return `${h}.${p}.${crypto.sign('RSA-SHA256', Buffer.from(`${h}.${p}`), privateKey).toString('base64url')}`;
}

function createFakeGoogle() {
  const used = new Set();
  /** Trả true nếu đã xử lý request. */
  return function handle(req, res, url, body) {
    if (!url.pathname.startsWith('/fake-google/')) return false;
    const json = (status, obj) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'public, max-age=3600' });
      res.end(JSON.stringify(obj));
    };
    const q = url.searchParams;
    if (url.pathname === '/fake-google/oauth2/v3/certs') return json(200, { keys: [JWK] }), true;
    if (url.pathname === '/fake-google/o/oauth2/v2/auth') {
      const redirect = new URL(q.get('redirect_uri'));
      redirect.searchParams.set('state', q.get('state') || '');
      if (q.get('test_deny')) {
        redirect.searchParams.set('error', 'access_denied');
      } else {
        if (q.get('response_type') !== 'code' || q.get('code_challenge_method') !== 'S256' || !/openid/.test(q.get('scope') || '')) {
          return json(400, { error: 'invalid_request' }), true;
        }
        const code = b64({
          sub: q.get('test_sub') || '100000000000000000001',
          email: q.get('test_email') || 'fake.user@gmail.test',
          ev: q.get('test_verified') !== 'false',
          name: q.get('test_name') || 'Fake Google User',
          nonce: q.get('nonce'),
          cc: q.get('code_challenge'),
          cid: q.get('client_id'),
          ru: q.get('redirect_uri'),
          r: crypto.randomBytes(8).toString('hex'),
        });
        redirect.searchParams.set('code', code);
      }
      res.writeHead(302, { location: redirect.toString() });
      res.end();
      return true;
    }
    if (url.pathname === '/fake-google/token' && req.method === 'POST') {
      const f = new URLSearchParams(body);
      let c;
      try {
        c = JSON.parse(Buffer.from(f.get('code') || '', 'base64url').toString('utf8'));
      } catch {
        return json(400, { error: 'invalid_grant' }), true;
      }
      const verifierOk = crypto.createHash('sha256').update(f.get('code_verifier') || '').digest('base64url') === c.cc;
      if (used.has(f.get('code')) || f.get('grant_type') !== 'authorization_code' || f.get('client_id') !== c.cid || !f.get('client_secret') || f.get('redirect_uri') !== c.ru || !verifierOk) {
        return json(400, { error: 'invalid_grant' }), true;
      }
      used.add(f.get('code'));
      const now = Math.floor(Date.now() / 1000);
      return json(200, {
        access_token: `fake-at-${crypto.randomBytes(8).toString('hex')}`,
        expires_in: 3599,
        token_type: 'Bearer',
        id_token: idToken({ iss: 'https://accounts.google.com', aud: c.cid, azp: c.cid, sub: c.sub, email: c.email, email_verified: c.ev, name: c.name, nonce: c.nonce, iat: now, exp: now + 3600 }),
      }), true;
    }
    json(404, { error: 'fake_google_not_found' });
    return true;
  };
}

module.exports = { createFakeGoogle };
