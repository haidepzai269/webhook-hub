import { PayOS } from '@payos/node';
import { signPayosBody, signPayosData } from '../../../apps/web/src/lib/hub/payos-sign';
import { PayosAdapter } from '../src/payos.adapter';

/**
 * S2-4: hàm ký của Playground (WebCrypto) phải ra ĐÚNG chữ ký của SDK chính chủ
 * `payos.crypto.createSignatureFromObj(data, key)`, và adapter của hub phải chấp nhận body đã ký.
 */
describe('Playground PayOS — ký chéo với @payos/node (S2-4)', () => {
  const KEY = 'checksum-key-for-test-1234567890';
  const payos = new PayOS({ clientId: 'x', apiKey: 'x', checksumKey: KEY });

  const cases: Record<string, Record<string, unknown>> = {
    'data mẫu Playground': { orderCode: 1760000000000, amount: 2000, description: 'Test tu Playground', reference: 'REF1' },
    'null / undefined / chuỗi "null"': {
      orderCode: 123,
      amount: 5000,
      counterAccountName: null,
      counterAccountBankId: 'null',
      virtualAccountName: undefined,
      description: 'có dấu: Đơn hàng #1 & a=b',
    },
    'mảng object (sắp khoá từng phần tử)': { orderCode: 1, items: [{ z: 1, a: 'x' }, { b: null, a: 2 }], amount: 0 },
    'webhook PayOS đầy đủ': {
      orderCode: 123,
      amount: 3000,
      description: 'VQRIO123',
      accountNumber: '12345678',
      reference: 'TF230204212323',
      transactionDateTime: '2023-02-04 18:25:00',
      currency: 'VND',
      paymentLinkId: '124c33293c43417ab7879e14c8d9eb18',
      code: '00',
      desc: 'Thành công',
      counterAccountBankId: '',
      counterAccountBankName: '',
      counterAccountName: '',
      counterAccountNumber: '',
      virtualAccountName: '',
      virtualAccountNumber: '',
    },
  };

  it.each(Object.entries(cases))('%s: chữ ký Playground == SDK', async (_name, data) => {
    const sdk = await payos.crypto.createSignatureFromObj(data, KEY);
    expect(await signPayosData(data, KEY)).toBe(sdk);
  });

  it('body đã ký bởi Playground được PayosAdapter (SDK verify) chấp nhận; sai key -> từ chối', async () => {
    const body = await signPayosBody(
      { code: '00', desc: 'success', success: true, data: cases['data mẫu Playground'], signature: 'cũ' },
      KEY,
    );
    const raw = JSON.stringify(body);
    const req: any = { provider: 'payos', sourceKey: 's', headers: {}, rawBody: Buffer.from(raw), body: JSON.parse(raw) };
    const adapter = new PayosAdapter();
    expect(await adapter.verify(req, [KEY])).toBe(true);
    expect(await adapter.verify(req, ['khoa-sai-khoa-sai-khoa-sai-123456'])).toBe(false);
  });

  it('body thiếu data -> ném lỗi rõ ràng', async () => {
    await expect(signPayosBody({ code: '00' }, KEY)).rejects.toThrow('data');
  });
});
