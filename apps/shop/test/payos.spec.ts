import { createHmac } from 'crypto';
import { NodeCryptoProvider } from '@payos/node/lib/crypto/node-crypto';
import { createPaymentLink, payosConfig, signPaymentRequest, verifyResponse } from '../src/payos';
import { bankQrUrl, EXPIRE_AFTER_MS, newOrderCode, payosOrderNumber } from '../src/payment';

/**
 * P1 (ADR-141): Shop tạo link PayOS thật. KHÔNG gọi PayOS thật — chữ ký đối chiếu với SDK chính thức `@payos/node`
 * (đã có trong repo, libs/providers) làm "oracle", HTTP thay bằng fetch giả. Khoá test cố định, không phải khoá thật.
 */
const KEY = 'test_checksum_key_0123456789abcdef';
const input = {
  orderCode: 1234567,
  amount: 138000,
  description: 'DH1234567',
  returnUrl: 'https://shop.example/shop?order=DH1234567',
  cancelUrl: 'https://shop.example/shop?order=DH1234567&cancel=1',
  expiredAt: 1_800_000_000,
};

describe('PayOS — chữ ký request/response (P1)', () => {
  it('chữ ký request = SDK chính thức (amount&cancelUrl&description&orderCode&returnUrl, HMAC-SHA256 hex)', async () => {
    const sdk = await new NodeCryptoProvider().createSignatureOfPaymentRequest(input, KEY);
    expect(signPaymentRequest(input, KEY)).toBe(sdk);
    const manual = createHmac('sha256', KEY)
      .update('amount=138000&cancelUrl=https://shop.example/shop?order=DH1234567&cancel=1&description=DH1234567&orderCode=1234567&returnUrl=https://shop.example/shop?order=DH1234567')
      .digest('hex');
    expect(signPaymentRequest(input, KEY)).toBe(manual);
  });

  it('chữ ký response: khớp SDK (khoá a→z, null -> ""), sửa một trường thì sai', async () => {
    const data = { bin: '970422', accountNumber: '0123', accountName: 'NGUYEN VAN A', amount: 138000, description: 'CS1 DH1234567', orderCode: 1234567, currency: 'VND', paymentLinkId: 'plk_1', status: 'PENDING', expiredAt: null, checkoutUrl: 'https://pay.payos.vn/web/plk_1', qrCode: '000201010212...' };
    const sig = (await new NodeCryptoProvider().createSignatureFromObj(data, KEY))!;
    expect(verifyResponse(data, sig, KEY)).toBe(true);
    expect(verifyResponse({ ...data, amount: 1000 }, sig, KEY)).toBe(false);
    expect(verifyResponse(data, undefined, KEY)).toBe(false);
  });
});

describe('PayOS — createPaymentLink (fetch giả)', () => {
  const cfg = { clientId: 'cid', apiKey: 'akey', checksumKey: KEY, apiBase: 'https://payos.test' };
  const okData = { checkoutUrl: 'https://pay.payos.vn/web/plk_1', qrCode: '00020101021238570010A000000727', paymentLinkId: 'plk_1', amount: 138000 };

  it('POST /v2/payment-requests với x-client-id/x-api-key + signature; trả checkoutUrl/qrCode/paymentLinkId', async () => {
    const calls: any[] = [];
    const fake: any = async (url: string, init: any) => {
      calls.push({ url, init });
      const signature = await new NodeCryptoProvider().createSignatureFromObj(okData, KEY);
      return { ok: true, status: 200, json: async () => ({ code: '00', desc: 'success', data: okData, signature }) };
    };
    const link = await createPaymentLink(cfg, input, fake);
    expect(link).toEqual({ checkoutUrl: okData.checkoutUrl, qrCode: okData.qrCode, paymentLinkId: 'plk_1' });
    expect(calls[0].url).toBe('https://payos.test/v2/payment-requests');
    expect(calls[0].init.headers).toMatchObject({ 'x-client-id': 'cid', 'x-api-key': 'akey' });
    const sent = JSON.parse(calls[0].init.body);
    expect(sent).toMatchObject({ ...input, signature: signPaymentRequest(input, KEY) });
    expect(typeof sent.orderCode).toBe('number');
  });

  it('PayOS trả code khác "00" -> lỗi nêu code/desc; chữ ký phản hồi sai -> lỗi (không tin checkoutUrl)', async () => {
    const bad: any = async () => ({ ok: true, status: 200, json: async () => ({ code: '20', desc: 'description quá dài', data: null }) });
    await expect(createPaymentLink(cfg, input, bad)).rejects.toThrow(/20 description/);
    const forged: any = async () => ({ ok: true, status: 200, json: async () => ({ code: '00', data: okData, signature: 'deadbeef' }) });
    await expect(createPaymentLink(cfg, input, forged)).rejects.toThrow(/chữ ký/);
  });

  it('payosConfig: thiếu một khoá -> null (Shop không mời chọn PayOS); base mặc định là API chính thức', () => {
    expect(payosConfig({ PAYOS_CLIENT_ID: 'a', PAYOS_API_KEY: 'b' } as any)).toBeNull();
    expect(payosConfig({ PAYOS_CLIENT_ID: 'a', PAYOS_API_KEY: 'b', PAYOS_CHECKSUM_KEY: 'c' } as any)?.apiBase).toBe('https://api-merchant.payos.vn');
    expect(payosConfig({ PAYOS_CLIENT_ID: 'a', PAYOS_API_KEY: 'b', PAYOS_CHECKSUM_KEY: 'c', SHOP_PAYOS_API_BASE: 'https://x.test/' } as any)?.apiBase).toBe('https://x.test');
  });
});

describe('Mã đơn + QR ngân hàng (P1)', () => {
  it('mã đơn DH + 7 chữ số = 9 ký tự (giới hạn description PayOS), orderCode PayOS là SỐ', () => {
    for (let i = 0; i < 50; i++) {
      const c = newOrderCode();
      expect(c).toMatch(/^DH[1-9]\d{6}$/);
      expect(payosOrderNumber(c)).toBe(Number(c.slice(2)));
    }
  });

  it('SePay: VietQR thật từ SHOP_BANK_*; thiếu cấu hình -> null (không QR giả)', () => {
    const url = bankQrUrl({ SHOP_BANK_CODE: 'MB', SHOP_BANK_ACCOUNT: '0987654321', SHOP_BANK_ACCOUNT_NAME: 'NGUYEN VAN A' } as any, 138000, 'DH1234567')!;
    expect(url.startsWith('https://img.vietqr.io/image/MB-0987654321-compact2.png?')).toBe(true);
    const q = new URL(url).searchParams;
    expect(q.get('amount')).toBe('138000');
    expect(q.get('addInfo')).toBe('DH1234567');
    expect(q.get('accountName')).toBe('NGUYEN VAN A');
    expect(bankQrUrl({ SHOP_BANK_CODE: 'MB' } as any, 1, 'DH1')).toBeNull();
  });

  it('hạn đơn mặc định 30 phút', () => {
    expect(EXPIRE_AFTER_MS).toBe(30 * 60 * 1000);
  });
});
