import { SepayAdapter } from '../src';
import { validateCanonical } from '@hub/common';
import { ctx, req, sepayTx } from './fixtures';

/** U36 — SePay ra kiểu chuẩn. */
describe('SePay -> catalog', () => {
  const a = new SepayAdapter();
  const norm = (over: Record<string, unknown>) => a.normalize(req('sepay', sepayTx(over)), ctx)[0];

  it('transferType in / out / không có -> received / sent / received', () => {
    expect(norm({}).type).toBe('payment.received');
    expect(norm({ transferType: 'out' }).type).toBe('payment.sent');
    const noType: any = sepayTx();
    delete noType.transferType;
    expect(a.normalize(req('sepay', noType), ctx)[0].type).toBe('payment.received');
  });

  it('account.bank = gateway; counterparty = null; amount/memo/reference', () => {
    const e = norm({});
    expect(e.normalized).toBe(true);
    expect(e.data).toMatchObject({
      amount: 50000,
      currency: 'VND',
      method: 'bank_transfer',
      reference: 'MBVCB.3278907687',
      memo: 'DH123456 thanh toan',
      counterparty: null,
      account: { number: '0123499999', bank: 'Vietcombank' },
      providerTxnId: '92704',
      paidAt: '2026-10-10T07:02:37.000Z',
    });
    expect(e.subject).toBe('payment:92704');
    expect(validateCanonical(e.type, e.data)).toEqual({ ok: true });
    const out = norm({ transferType: 'out' });
    expect(out.data.sentAt).toBe('2026-10-10T07:02:37.000Z');
    expect(validateCanonical(out.type, out.data)).toEqual({ ok: true });
  });

  it('không còn transferAmount/content ở phần chung (vẫn có trong raw)', () => {
    const { raw, ...common } = norm({}).data;
    expect(Object.keys(common)).not.toContain('transferAmount');
    expect(Object.keys(common)).not.toContain('content');
    expect((raw as any).transferAmount).toBe(50000);
  });
});
