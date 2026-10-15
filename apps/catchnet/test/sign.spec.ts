import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { catchnetHeaders, constantTimeEqual, rawTargetOf, requestTarget, sha256Hex, signingString } from '../src/sign';
import { firstSecret, loadConfig, retentionDays } from '../src/config';
import { ulid } from '../src/ulid';

// Vector CỐ ĐỊNH dùng chung với hub-api (ingest-catchnet.spec) — REVIEW-LH3 T-7. Đổi khuôn ký = cả hai bên cùng đỏ.
const VEC = JSON.parse(
  readFileSync(join(__dirname, '..', '..', '..', 'libs', 'crypto', 'test', 'fixtures', 'catchnet-vectors.json'), 'utf8'),
) as {
  secret: string;
  cases: Array<{
    name: string;
    id: string;
    receivedAt: string;
    clientIp: string;
    mode: 'forward' | 'replay';
    method: string;
    target: string;
    bodyUtf8: string;
    signingString: string;
    signature: string;
    bodySha256: string;
    bodySignature: string;
  }>;
};

describe('LH2 ký header lưới (vector chung với hub)', () => {
  for (const c of VEC.cases) {
    it(`[LH:T4] vector "${c.name}" -> chuỗi ký, chữ ký đầu, chữ ký body khớp hub`, async () => {
      const body = new TextEncoder().encode(c.bodyUtf8);
      const input = { id: c.id, receivedAt: Number(c.receivedAt), clientIp: c.clientIp, mode: c.mode, method: c.method, target: c.target, body };
      expect(signingString(input)).toBe(c.signingString);
      expect(await sha256Hex(body)).toBe(c.bodySha256);
      const h = await catchnetHeaders(VEC.secret, input);
      expect(h['x-catchnet-signature']).toBe(c.signature);
      expect(h['x-catchnet-body-signature']).toBe(c.bodySignature);
      expect(h['x-catchnet-id']).toBe(c.id);
      expect(h['x-catchnet-received-at']).toBe(c.receivedAt);
      expect(h['x-catchnet-client-ip']).toBe(c.clientIp);
      expect(h['x-catchnet-mode']).toBe(c.mode);
    });
  }

  it('[LH:T9] target ký = ĐÚNG chuỗi đưa vào fetch: giữ `?` đứng một mình và percent-encoding thô (T-7)', () => {
    const origin = 'https://hub.example.com';
    for (const c of VEC.cases) {
      const raw = rawTargetOf(`https://hub-hooks.webhookhub.workers.dev${c.target}`);
      expect(raw).toBe(c.target);
      const { url, target } = requestTarget(origin, raw);
      expect(target).toBe(c.target); // vector đã ở dạng chuẩn hoá WHATWG -> không đổi
      expect(url).toBe(origin + c.target);
    }
    // new URL().pathname + search làm rơi `?` — Worker KHÔNG được dùng cách đó.
    const u = new URL(`${origin}/hooks/github/src_gh?`);
    expect(u.pathname + u.search).toBe('/hooks/github/src_gh');
    expect(requestTarget(origin, '/hooks/github/src_gh?').target).toBe('/hooks/github/src_gh?');
    // Ký tự WHATWG mã hoá (khoảng trắng) -> target ký là bản fetch sẽ gửi.
    expect(requestTarget(origin, '/hooks/generic/k?a=b c').target).toBe('/hooks/generic/k?a=b%20c');
    expect(rawTargetOf('https://x.dev/hooks/a/b?q=1#frag')).toBe('/hooks/a/b?q=1');
    expect(() => requestTarget(origin, 'evil.com/x')).toThrow();
  });

  it('[LH:T4] so hằng thời gian, kiểm độ dài trước; secret ký = giá trị đầu ≥ 32 ký tự', () => {
    expect(constantTimeEqual('a'.repeat(40), 'a'.repeat(40))).toBe(true);
    expect(constantTimeEqual('a'.repeat(40), `${'a'.repeat(39)}b`)).toBe(false);
    expect(constantTimeEqual('abc', 'abcd')).toBe(false);
    expect(firstSecret(` ${'n'.repeat(32)} , ${'o'.repeat(32)}`)).toBe('n'.repeat(32));
    expect(firstSecret('ngan')).toBeNull();
    expect(firstSecret(undefined)).toBeNull();
    // Hạn giữ CÙNG luật hub (catchnetRetentionMs): nguyên 1..30, sai khuôn -> 7.
    expect([retentionDays('3'), retentionDays('31'), retentionDays('x'), retentionDays(undefined)]).toEqual([3, 7, 7, 7]);
    const cfg = loadConfig({ DB: null as never, CATCHNET_FORWARD_TIMEOUT_MS: '99999', CATCHNET_REPLAY_BATCH: '0' });
    expect([cfg.forwardTimeoutMs, cfg.replayBatch]).toEqual([8000, 1]);
    expect(ulid(1760425200000)).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });
});
