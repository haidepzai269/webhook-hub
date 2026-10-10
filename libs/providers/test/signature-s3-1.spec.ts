// require (không import *): spy phải đặt trên CHÍNH đối tượng module mà @hub/crypto gọi tới.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const nodeCrypto = require('crypto');
import { PayOS } from '@payos/node';
import { GithubAdapter, PayosAdapter, SepayAdapter, StripeAdapter } from '../src';
import { RawWebhookRequest } from '@hub/common';

/**
 * S3-1 (SPEC-3): chữ ký đúng câu chữ, khoá chống trùng không ngẫu nhiên, `extractSignature` theo adapter.
 */
describe('S3-1 — chữ ký + khoá chống trùng + extractSignature', () => {
  const KEY = 'payos-checksum-key-s31-0123456789';
  const sdk = new PayOS({ clientId: 'x', apiKey: 'x', checksumKey: KEY });
  const data = { orderCode: 123, amount: 50000, description: 'DH123 thanh toan', reference: 'FT1', accountNumber: '1' };

  async function payosReq(sig?: string, d: Record<string, unknown> = data): Promise<RawWebhookRequest> {
    const signature = sig ?? (await sdk.crypto.createSignatureFromObj(d, KEY))!;
    const body = { code: '00', desc: 'success', success: true, data: d, signature };
    const raw = JSON.stringify(body);
    return { provider: 'payos', sourceKey: 's', headers: {}, rawBody: Buffer.from(raw), body: JSON.parse(raw) };
  }

  describe('PayOS verify', () => {
    const adapter = new PayosAdapter();

    afterEach(() => jest.restoreAllMocks());

    it('chữ ký đúng -> true', async () => {
      expect(await adapter.verify(await payosReq(), [KEY])).toBe(true);
    });

    it('sai một ký tự -> false', async () => {
      const good = (await payosReq()).body.signature as string;
      const bad = good.slice(0, -1) + (good.endsWith('0') ? '1' : '0');
      expect(await adapter.verify(await payosReq(bad), [KEY])).toBe(false);
    });

    it('xoay secret: key cũ đứng sau vẫn khớp', async () => {
      expect(await adapter.verify(await payosReq(), ['khoa-moi-chua-dung-0000000000', KEY])).toBe(true);
    });

    it('[AF:#5] so sánh bằng crypto.timingSafeEqual (không phải !== của SDK)', async () => {
      const spy = jest.spyOn(nodeCrypto, 'timingSafeEqual');
      expect(await adapter.verify(await payosReq(), [KEY])).toBe(true);
      expect(spy).toHaveBeenCalled();
    });

    it('không gọi payos.webhooks.verify()', async () => {
      const src = require('fs').readFileSync(require('path').join(__dirname, '../src/payos.adapter.ts'), 'utf8');
      const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      expect(code).not.toMatch(/webhooks\.verify\s*\(/);
    });
  });

  describe('SePay verify', () => {
    const adapter = new SepayAdapter();
    const API = 'sepay_key_xyz';
    const req = (auth?: string): RawWebhookRequest => ({
      provider: 'sepay',
      sourceKey: 's',
      headers: auth === undefined ? {} : { authorization: auth },
      rawBody: Buffer.from('{}'),
      body: {},
    });

    it('`Apikey <key>` -> true; không phân biệt hoa thường ở chữ Apikey', async () => {
      expect(await adapter.verify(req(`Apikey ${API}`), [API])).toBe(true);
      expect(await adapter.verify(req(`APIKEY ${API}`), [API])).toBe(true);
    });

    it('[AF:#6] thiếu tiền tố -> false', async () => {
      expect(await adapter.verify(req(API), [API])).toBe(false);
      expect(await adapter.verify(req(`Bearer ${API}`), [API])).toBe(false);
      expect(await adapter.verify(req(), [API])).toBe(false);
    });
  });

  describe('Khoá chống trùng dự phòng = sha256(rawBody), không ngẫu nhiên', () => {
    it('[AF:#7] SePay thiếu id và referenceCode -> hai lần gọi cùng body ra cùng khoá, 32 hex', () => {
      const a = new SepayAdapter();
      const raw = JSON.stringify({ transferAmount: 1000, content: 'DH1' });
      const r = (): RawWebhookRequest => ({ provider: 'sepay', sourceKey: 's', headers: {}, rawBody: Buffer.from(raw), body: JSON.parse(raw) });
      const k1 = a.extractIdempotencyKey(r());
      expect(k1).toBe(a.extractIdempotencyKey(r()));
      expect(k1).toMatch(/^sepay:[0-9a-f]{32}$/);
      const other = JSON.stringify({ transferAmount: 1001, content: 'DH1' });
      expect(a.extractIdempotencyKey({ ...r(), rawBody: Buffer.from(other), body: JSON.parse(other) })).not.toBe(k1);
    });

    it('PayOS thiếu reference + paymentLinkId -> cùng khoá', async () => {
      const a = new PayosAdapter();
      const d = { orderCode: 9, amount: 1000, description: 'x' };
      const r1 = await payosReq(undefined, d);
      const r2 = await payosReq(undefined, d);
      const k = a.extractIdempotencyKey(r1);
      expect(k).toBe(a.extractIdempotencyKey(r2));
      expect(k).toMatch(/^payos:9:[0-9a-f]{32}$/);
    });

    it('GitHub thiếu delivery + commit -> cùng khoá', () => {
      const a = new GithubAdapter();
      const raw = '{"zen":"x"}';
      const r: RawWebhookRequest = { provider: 'github', sourceKey: 's', headers: {}, rawBody: Buffer.from(raw), body: JSON.parse(raw) };
      expect(a.extractIdempotencyKey(r)).toBe(a.extractIdempotencyKey({ ...r }));
      expect(a.extractIdempotencyKey(r)).toMatch(/^github:[0-9a-f]{32}$/);
    });

    it('không còn ulid() trong extractIdempotencyKey của các adapter', () => {
      const fs = require('fs');
      const path = require('path');
      for (const f of ['payos', 'sepay', 'github', 'stripe']) {
        const src: string = fs.readFileSync(path.join(__dirname, `../src/${f}.adapter.ts`), 'utf8');
        const m = src.match(/extractIdempotencyKey\([^)]*\)[^{]*\{([\s\S]*?)\n  \}/);
        expect(m).not.toBeNull();
        expect(m![1]).not.toMatch(/ulid\(/);
      }
    });
  });

  describe('extractSignature', () => {
    it('GitHub: x-hub-signature-256', () => {
      const r: RawWebhookRequest = { provider: 'github', sourceKey: 's', headers: { 'x-hub-signature-256': 'sha256=ab' }, rawBody: Buffer.from('{}'), body: {} };
      expect(new GithubAdapter().extractSignature(r)).toBe('sha256=ab');
      expect(new GithubAdapter().extractSignature({ ...r, headers: {} })).toBeNull();
    });

    it('Stripe: stripe-signature', () => {
      const r: RawWebhookRequest = { provider: 'stripe', sourceKey: 's', headers: { 'stripe-signature': 't=1,v1=ab' }, rawBody: Buffer.from('{}'), body: {} };
      expect(new StripeAdapter().extractSignature(r)).toBe('t=1,v1=ab');
    });

    it('PayOS: body.signature', async () => {
      const r = await payosReq('deadbeef');
      expect(new PayosAdapter().extractSignature(r)).toBe('deadbeef');
      expect(new PayosAdapter().extractSignature({ ...r, body: {} })).toBeNull();
    });

    it('[AF:#8] SePay: "Apikey ***" — không bao giờ chứa key thật', () => {
      const a = new SepayAdapter();
      const mk = (auth?: string): RawWebhookRequest => ({
        provider: 'sepay', sourceKey: 's', headers: auth ? { authorization: auth } : {}, rawBody: Buffer.from('{}'), body: {},
      });
      expect(a.extractSignature(mk('Apikey REAL_SECRET_KEY'))).toBe('Apikey ***');
      expect(a.extractSignature(mk('REAL_SECRET_KEY'))).toBe('***');
      expect(a.extractSignature(mk())).toBeNull();
      expect(String(a.extractSignature(mk('apikey REAL_SECRET_KEY')))).not.toContain('REAL_SECRET_KEY');
    });
  });
});
