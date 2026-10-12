import * as fs from 'fs';
import * as path from 'path';
import { ERROR_CATALOG, codeForStatus, isHubErrorCode, verificationFix } from '../src/errors/catalog';

const ROOT = path.join(__dirname, '..', '..', '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(path.join(dir, d.name)) : d.name.endsWith('.ts') ? [path.join(dir, d.name)] : []));
}

/** Mã chỉ dùng ở route NGOÀI phạm vi DX1 (`/auth/*`, `/hooks/*`, `/metrics`) — giữ định dạng riêng. */
const OUT_OF_SCOPE = new Set([
  'invalid_credentials', 'refresh_race', 'too_many_attempts', 'oauth_state_mismatch', 'github_oauth_disabled', 'google_oauth_disabled',
  'last_login_method', 'metrics_unauthorized', 'password_required', 'google_email_unverified', 'google_account_mismatch',
  'google_link_requires_password', 'scope_not_declared', // 500 -> filter trả internal_error
]);

describe('[DX] catalog lỗi (DX1)', () => {
  it('[DX:UX4] (phần a) mỗi mã có `## <mã>` trong docs/ERRORS.md; message + fix() là chuỗi không rỗng (cả khi thiếu tham số)', () => {
    const doc = read('docs/ERRORS.md');
    for (const [code, def] of Object.entries(ERROR_CATALOG)) {
      expect([code, new RegExp(`^## ${code}\\s*$`, 'm').test(doc)]).toEqual([code, true]);
      expect(def.message.length).toBeGreaterThan(5);
      const fix = (def.fix as (p: Record<string, unknown>) => string)({});
      expect([code, typeof fix === 'string' && fix.length > 10]).toEqual([code, true]);
      expect(def.status).toBeGreaterThanOrEqual(400);
    }
  });

  it('[DX:UX4] (phần b) mọi mã lỗi hub-api ném ở route /v1/p + /api/v1 đều có trong catalog (thêm mã mới mà quên catalog -> đỏ)', () => {
    const src = walk(path.join(ROOT, 'apps', 'hub-api', 'src'));
    const found = new Set<string>();
    for (const f of src) {
      const t = fs.readFileSync(f, 'utf8');
      for (const m of t.matchAll(/error:\s*'([a-z][a-z0-9_]*)'/g)) found.add(m[1]);
      for (const m of t.matchAll(/(?:authError|http)\(\s*HttpStatus\.[A-Z_]+,\s*'([a-z][a-z0-9_]*)'/g)) found.add(m[1]);
      for (const m of t.matchAll(/hubError\(\s*'([a-z][a-z0-9_]*)'/g)) found.add(m[1]);
    }
    expect(found.size).toBeGreaterThan(20);
    const missing = [...found].filter((c) => !isHubErrorCode(c) && !OUT_OF_SCOPE.has(c));
    expect(missing).toEqual([]);
  });

  it('[DX:UX4] (phần c) fix chỉ dựng từ tham số khai báo; tham số lạ (key/secret) không lọt vào fix', () => {
    for (const [code, def] of Object.entries(ERROR_CATALOG)) {
      const fix = (def.fix as (p: Record<string, unknown>) => string)({ apiKey: 'hk_test_SECRETKEY', secret: 's3cr3t', body: '{"a":1}' });
      expect([code, fix.includes('SECRETKEY') || fix.includes('s3cr3t') || fix.includes('"a":1')]).toEqual([code, false]);
    }
  });

  it('codeForStatus: status không mã -> mã catalog', () => {
    expect([400, 401, 403, 404, 409, 413, 415, 422, 429, 500, 502, 503, 418].map(codeForStatus)).toEqual([
      'bad_request', 'unauthenticated', 'forbidden', 'not_found', 'conflict', 'payload_too_large', 'unsupported_media_type',
      'validation_failed', 'rate_limited', 'internal_error', 'internal_error', 'service_unavailable', 'bad_request',
    ]);
  });

  it('[DX:UX6] (phần c) verificationFix cho từng verificationError của challenge; ssrf_blocked nêu CẢ URL công khai (deployed) lẫn hub listen (local)', () => {
    expect(verificationFix(null)).toBeNull();
    for (const c of ['timeout', 'http_500', 'http_404', 'challenge_mismatch', 'invalid_json', 'ssrf_blocked', 'unreachable', 'invalid_url', 'no_signing_secret', 'la_lung']) {
      expect([c, typeof verificationFix(c)]).toEqual([c, 'string']);
    }
    expect(verificationFix('timeout')).toMatch(/10s/);
    expect(verificationFix('http_500')).toMatch(/HTTP 500.*challenge/);
    expect(verificationFix('challenge_mismatch')).toMatch(/challengeResponse/);
    const ssrf = verificationFix('ssrf_blocked')!;
    expect(ssrf).toMatch(/hub listen/);
    expect(ssrf).toMatch(/SHOP_PUBLIC_URL/);
    expect(ssrf).toMatch(/[Dd]eployed/);
  });
});
