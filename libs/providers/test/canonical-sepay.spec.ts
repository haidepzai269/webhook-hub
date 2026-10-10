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

/** Review SPEC-3 #1: body thiếu cả id lẫn referenceCode vẫn ra event hợp lệ, providerTxnId ổn định theo body. */
describe('SePay thiếu id + referenceCode', () => {
  const a = new SepayAdapter();
  const body = () => {
    const b: any = sepayTx();
    delete b.id;
    delete b.referenceCode;
    return b;
  };

  it('hai lần cùng body -> cùng providerTxnId (sha:…), cùng khoá chống trùng, qua validator', () => {
    const r1 = req('sepay', body());
    const r2 = req('sepay', body());
    const [e1] = a.normalize(r1, ctx);
    const [e2] = a.normalize(r2, ctx);
    expect(e1.data.providerTxnId).toMatch(/^sha:[0-9a-f]{32}$/);
    expect(e2.data.providerTxnId).toBe(e1.data.providerTxnId);
    expect(e1.subject).toBe(`payment:${e1.data.providerTxnId}`);
    expect(a.extractIdempotencyKey(r1)).toBe(a.extractIdempotencyKey(r2));
    expect(validateCanonical(e1.type, e1.data)).toEqual({ ok: true });
  });
});

/** Review SPEC-3 #4: thiếu thời gian giao dịch -> dùng receivedAt của raw event; renormalize ra cùng giá trị. */
describe('Thời gian dự phòng ổn định', () => {
  const RECEIVED = '2026-10-10T03:04:05.000Z';
  it('SePay/PayOS/Stripe thiếu thời gian -> paidAt = receivedAt (2 lần normalize giống hệt)', () => {
    const { PayosAdapter, StripeAdapter } = require('../src');
    const { payosSuccess, stripePiSucceeded } = require('./fixtures');
    const c = { ...ctx, receivedAt: RECEIVED };
    const s: any = sepayTx();
    delete s.transactionDate;
    const p: any = payosSuccess();
    delete p.data.transactionDateTime;
    const st: any = stripePiSucceeded();
    delete st.created;
    for (const [adapter, provider, body] of [
      [new SepayAdapter(), 'sepay', s],
      [new PayosAdapter(), 'payos', p],
      [new StripeAdapter(), 'stripe', st],
    ] as const) {
      const [e1] = (adapter as any).normalize(req(provider as any, body), c);
      const [e2] = (adapter as any).normalize(req(provider as any, body), c);
      expect(e1.data.paidAt).toBe(RECEIVED);
      expect(e1.occurredAt).toBe(RECEIVED);
      expect(e1.receivedAt).toBe(RECEIVED);
      expect(e2.data.paidAt).toBe(e1.data.paidAt);
    }
  });
});
