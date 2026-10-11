import { createHmac } from 'crypto';
import { PayOS } from '@payos/node';
import Stripe from 'stripe';
import { sign as octokitSign, verify as octokitVerify } from '@octokit/webhooks-methods';
import { bodyOf, isOddBytes, listFixtures, loadFixture, prepare } from '../src/fixture';
import { githubSignature256, payosSignature, stripeSignatureHeader, swSign, swVerify, tamperOneChar } from '../src/sign';
import { findSuspiciousNumbers, scrubText } from '../src/scrub';
import { GATES } from '../../../verify/lib/gates';

/**
 * VF3 (SPEC-verification §5): bộ giả lập ký ĐỘC LẬP. Test này chỉ dùng SDK CHÍNH CHỦ của provider (node_modules) để
 * đối chiếu — không import apps/, libs/ (gate `sim-independent`).
 */
const payosCrypto = new PayOS({ clientId: 'x', apiKey: 'x', checksumKey: 'x' }).crypto;
const stripe = new Stripe('sk_test_sim_only');

describe('hub-sim — chữ ký khớp SDK chính thức (VT5)', () => {
  it('[VF:VT5] (phần a) PayOS: chữ ký hub-sim BẰNG createSignatureFromObj của @payos/node trên cùng data + key', async () => {
    const samples: Record<string, unknown>[] = [
      JSON.parse(bodyOf(loadFixture('payos/paid-69000')).toString('utf8').split('__U__').join('0')).data,
      JSON.parse(bodyOf(loadFixture('payos/code-not-00')).toString('utf8').split('__U__').join('0')).data,
      { b: null, a: 'null', c: undefined, d: [{ z: 1, y: 2 }], e: 0, f: '' },
    ];
    for (const data of samples) {
      expect(payosSignature(data, 'VERIFY_ONLY_payos_checksum_key')).toBe(await payosCrypto.createSignatureFromObj(data, 'VERIFY_ONLY_payos_checksum_key'));
    }
  });

  it('[VF:VT5] (phần b) Stripe: header hub-sim BẰNG generateTestHeaderString của SDK stripe; constructEvent chấp nhận', () => {
    const f = loadFixture('stripe/pi-succeeded');
    const body = bodyOf(f);
    const secret = 'whsec_VERIFY_ONLY_sim_stripe';
    const t = 1760104960;
    const sdk = stripe.webhooks.generateTestHeaderString({ payload: body.toString('utf8'), secret, timestamp: t });
    expect(stripeSignatureHeader(body, secret, t)).toBe(sdk);
    const now = Math.floor(Date.now() / 1000);
    expect(() => stripe.webhooks.constructEvent(body, stripeSignatureHeader(body, secret, now), secret)).not.toThrow();
  });

  it('[VF:VT5] (phần c) GitHub: X-Hub-Signature-256 hub-sim BẰNG sign() của @octokit/webhooks-methods; verify() chấp nhận', async () => {
    const body = bodyOf(loadFixture('github/push')).toString('utf8');
    const secret = 'VERIFY_ONLY_github_webhook_secret';
    expect(githubSignature256(Buffer.from(body), secret)).toBe(await octokitSign(secret, body));
    expect(await octokitVerify(secret, body, githubSignature256(Buffer.from(body), secret))).toBe(true);
  });

  it('[VF:VT5] (phần d) Standard Webhooks: khớp vector mẫu của đặc tả (msg_p5jXN8AQM9LWM0D4loKWxJek); verify độc lập nhận/loại đúng', () => {
    const secret = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw';
    const body = Buffer.from('{"test": 2432232314}');
    const sig = swSign(secret, 'msg_p5jXN8AQM9LWM0D4loKWxJek', 1614265330, body);
    expect(sig).toBe('v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=');
    const h = { 'webhook-id': 'msg_p5jXN8AQM9LWM0D4loKWxJek', 'webhook-timestamp': '1614265330', 'webhook-signature': `v1,AAAA ${sig}` };
    expect(swVerify(secret, h, body, 1614265330)).toBe(true);
    expect(swVerify(secret, h, body, 1614265330 + 301)).toBe(false); // lệch > 5 phút
    expect(swVerify(secret, { ...h, 'webhook-signature': tamperOneChar(sig) }, body, 1614265330)).toBe(false);
  });
});

describe('hub-sim — fixture §5.4', () => {
  const ids = listFixtures();

  it('VF3: đủ danh mục tối thiểu §5.4 (5 provider) và mọi fixture nạp được, id khớp tên file, đều synthetic hoặc real', () => {
    for (const need of [
      'payos/paid-69000', 'payos/code-not-00', 'payos/bad-sig',
      'sepay/money-in', 'sepay/no-id', 'sepay/auth-no-prefix',
      'stripe/pi-succeeded', 'stripe/stale-timestamp', 'stripe/bad-v1',
      'github/push', 'github/pr-opened', 'github/ping',
      'generic/x-signature-ok', 'generic/x-sig-wrong-header',
    ]) {
      expect(ids).toContain(need);
    }
    for (const id of ids) expect(['synthetic', 'real']).toContain(loadFixture(id).origin);
  });

  it('VF3: mỗi provider có ít nhất một fixture "bytes lạ" và bytes ĐÚNG là khác JSON.stringify của chính nó', () => {
    const odd = new Set<string>();
    for (const id of ids) {
      const f = loadFixture(id);
      if (!f.oddBytes) continue;
      expect(isOddBytes(prepare(f, 'k', { nowS: 1 }).body)).toBe(true);
      odd.add(f.provider);
    }
    expect([...odd].sort()).toEqual(['generic', 'github', 'payos', 'sepay', 'stripe']);
  });

  it('VF3 (§14.3): body đã giải mã của mọi fixture không có dãy 9–14 chữ số (trừ epoch sau created/timestamp; trừ đúng dòng có ngoại lệ của gate fixture-account)', () => {
    // Ngoại lệ chỉ khai ở MỘT chỗ (verify/lib/gates.ts, file + regex theo dòng) — test này không tự nới.
    const ex = GATES.find((g) => g.id === 'fixture-account')?.exceptions ?? [];
    for (const id of ids) {
      const file = `tools/hub-sim/fixtures/${id}.json`;
      const hits = bodyOf(loadFixture(id))
        .toString('utf8')
        .split(/\r?\n/)
        .filter((ln) => findSuspiciousNumbers(ln).length > 0)
        .filter((ln) => !ex.some((e) => e.file === file && e.match && new RegExp(e.match).test(ln)));
      expect({ id, hits }).toEqual({ id, hits: [] });
    }
  });

  it('[KN:U16] (phần n) fixture payos/confirm-probe: đúng bộ mẫu tài liệu, dòng reference không chứa dãy số nào khác, mong 200 + payos.webhook_test + probe', () => {
    const f = loadFixture('payos/confirm-probe');
    expect(f.expect).toMatchObject({ status: 200, type: 'payos.webhook_test', normalized: false, probe: true });
    const body = bodyOf(f).toString('utf8');
    const d = JSON.parse(body.replace('__SIG__', 'x')).data;
    expect([d.orderCode, d.description, d.reference]).toEqual([123, 'VQRIO123', 'TF230204212323']);
    const refLine = body.split(/\r?\n/).filter((ln) => ln.includes('TF230204212323'));
    expect(refLine).toHaveLength(1);
    expect(refLine[0].replace('TF230204212323', '')).not.toMatch(/\d/);
    expect(body).not.toContain('__U__'); // khoá chống trùng cố định — không làm "mới" bằng --unique
  });

  it('VF3: ký lại lúc phát — PayOS thay đúng chỗ giữ, mọi byte khác giữ nguyên; tamper đổi đúng 1 ký tự', () => {
    const f = loadFixture('payos/paid-69000');
    const a = prepare(f, 'k1').body.toString('utf8');
    const raw = bodyOf(f).toString('utf8').split('__U__').join('0');
    const sig = JSON.parse(a).signature;
    expect(a).toBe(raw.replace('__SIG__', sig));
    const bad = JSON.parse(prepare({ ...f, signature: { ...f.signature, tamper: true } }, 'k1').body.toString('utf8')).signature;
    expect(bad).toHaveLength(sig.length);
    expect([...bad].filter((c: string, i: number) => c !== sig[i])).toHaveLength(1);
  });

  it('VF3: Stripe stale-timestamp giữ t cố định; ca thường ký t = now; --unique chỉ nhận chữ số', () => {
    const stale = prepare(loadFixture('stripe/stale-timestamp'), 's', { nowS: 1800000000 });
    expect(stale.headers['stripe-signature']).toMatch(/^t=1760000000,v1=/);
    const fresh = prepare(loadFixture('stripe/pi-succeeded'), 's', { nowS: 1800000000 });
    expect(fresh.headers['stripe-signature']).toMatch(/^t=1800000000,v1=/);
    expect(() => prepare(loadFixture('stripe/pi-succeeded'), 's', { unique: 'abc' })).toThrow('chữ số');
    expect(prepare(loadFixture('github/push'), 's', { unique: '42' }).headers['x-github-delivery']).toBe('sim-push-42');
  });

  it('VF3: generic sai header — chữ ký nằm ở x-sig, KHÔNG có x-signature', () => {
    const p = prepare(loadFixture('generic/x-sig-wrong-header'), 'sec');
    expect(p.headers['x-signature']).toBeUndefined();
    expect(p.headers['x-sig']).toBe(createHmac('sha256', 'sec').update(p.body).digest('hex'));
  });
});

describe('hub-sim — scrub (§5.2, §14.3)', () => {
  it('VF3: thay số tài khoản / tên / email cùng độ dài, giữ epoch `created`, giữ "bytes lạ", chạy hai lần như một', () => {
    const src = '{"accountNumber": "0123456789012", "counterAccountName": "NGUYEN VAN A", "email":"kien.nh@gmail.com", "created": 1760104957, "x": "\\u00e0"}';
    const out = scrubText(src);
    expect(out).toHaveLength(src.length - 'kien.nh@gmail.com'.length + 'uuuuuuu@example.test'.length);
    expect(out).not.toContain('0123456789012');
    expect(out).toContain('"counterAccountName": "XXXXXXXXXXXX"');
    expect(out).toContain('"created": 1760104957');
    expect(out).toContain('\\u00e0');
    expect(out).not.toContain('gmail.com');
    expect(findSuspiciousNumbers(out)).toEqual([]);
    expect(scrubText(out)).toBe(out);
  });
});
