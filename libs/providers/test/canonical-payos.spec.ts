import { PayosAdapter } from '../src';
import { validateCanonical } from '@hub/common';
import { ctx, payosFailed, payosSuccess, req } from './fixtures';

/** U34–U35 — PayOS ra kiểu chuẩn. */
describe('PayOS -> catalog', () => {
  const a = new PayosAdapter();

  it('U34 code "00" -> payment.received, phần chung đúng, orderCode chỉ trong raw', () => {
    const [e] = a.normalize(req('payos', payosSuccess()), ctx);
    expect(e.type).toBe('payment.received');
    expect(e.normalized).toBe(true);
    expect(e.data.amount).toBe(50000);
    expect(e.data.currency).toBe('VND');
    expect(e.data.method).toBe('payment_link');
    expect(e.data.memo).toBe('DH123456 thanh toan');
    expect(e.data.reference).toBe('TF230204212323');
    expect(e.data.providerTxnId).toBe('124c33293c43417ab7879e14c8d9eb18');
    expect(e.data.paidAt).toBe('2026-10-10T07:02:37.000Z');
    expect(e.data.counterparty).toBeNull(); // mọi trường counter* rỗng -> null
    expect(e.data.account).toEqual({ number: '12345678', bank: null });
    expect(e.subject).toBe('payment:124c33293c43417ab7879e14c8d9eb18');
    const { raw, ...common } = e.data;
    expect(JSON.stringify(common)).not.toContain('orderCode');
    expect((raw as any).data.orderCode).toBe(123456);
    expect(validateCanonical(e.type, e.data)).toEqual({ ok: true });
  });

  it('U34b counterparty có dữ liệu -> object', () => {
    const [e] = a.normalize(
      req('payos', payosSuccess({ counterAccountName: 'NGUYEN VAN A', counterAccountNumber: '999', counterAccountBankName: 'VCB' })),
      ctx,
    );
    expect(e.data.counterparty).toEqual({ name: 'NGUYEN VAN A', accountNumber: '999', bank: 'VCB' });
  });

  it('U35 code "01" hoặc success:false -> payment.failed, reason = desc', () => {
    const [e] = a.normalize(req('payos', payosFailed()), ctx);
    expect(e.type).toBe('payment.failed');
    expect(e.data.reason).toBe('Giao dịch thất bại');
    expect(e.data.failedAt).toBe('2026-10-10T07:02:37.000Z');
    expect(validateCanonical(e.type, e.data)).toEqual({ ok: true });

    const [e2] = a.normalize(req('payos', { ...payosSuccess(), success: false }), ctx);
    expect(e2.type).toBe('payment.failed');
  });
});
