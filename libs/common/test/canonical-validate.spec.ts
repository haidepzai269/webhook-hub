import { canonicalKeys, isReservedType, validateCanonical } from '../src/canonical';

const good = () => ({
  amount: 50000,
  currency: 'VND',
  method: 'bank_transfer',
  reference: 'FT1',
  memo: 'DH1 thanh toan',
  counterparty: null,
  account: { number: '0123', bank: 'MBBank' },
  providerTxnId: '92704',
  paidAt: '2026-10-10T07:02:37.000Z',
  raw: { id: 92704 },
});

/** U44 — validator viết tay của catalog. */
describe('U44 validateCanonical payment.received', () => {
  it.each([
    ['amount 1.5', { amount: 1.5 }, 'amount'],
    ['amount 0', { amount: 0 }, 'amount'],
    ['amount "100"', { amount: '100' }, 'amount'],
    ['currency "vnd"', { currency: 'vnd' }, 'currency'],
  ])('%s -> field', (_n, over, field) => {
    expect(validateCanonical('payment.received', { ...good(), ...over })).toEqual({ ok: false, field });
  });

  it('thiếu khoá memo -> field memo', () => {
    const d: any = good();
    delete d.memo;
    expect(validateCanonical('payment.received', d)).toEqual({ ok: false, field: 'memo' });
  });

  it('dữ liệu đúng -> ok', () => {
    expect(validateCanonical('payment.received', good())).toEqual({ ok: true });
  });

  it('khoá lạ / thời gian không múi giờ / counterparty sai khuôn / thiếu providerTxnId', () => {
    expect(validateCanonical('payment.received', { ...good(), orderCode: '1' })).toEqual({ ok: false, field: 'orderCode' });
    expect(validateCanonical('payment.received', { ...good(), paidAt: '2026-10-10 14:00:00' })).toEqual({ ok: false, field: 'paidAt' });
    expect(validateCanonical('payment.received', { ...good(), counterparty: { name: 'A' } })).toEqual({ ok: false, field: 'counterparty.accountNumber' });
    expect(validateCanonical('payment.received', { ...good(), providerTxnId: '' })).toEqual({ ok: false, field: 'providerTxnId' });
  });

  it('payment.failed cần failedAt + reason', () => {
    const { paidAt, ...core } = good();
    expect(validateCanonical('payment.failed', { ...core, failedAt: paidAt, reason: null })).toEqual({ ok: true });
    expect(validateCanonical('payment.failed', { ...core, failedAt: paidAt })).toEqual({ ok: false, field: 'reason' });
  });

  it('kiểu dành riêng ngoài catalog -> field type; kiểu tự do -> ok', () => {
    expect(validateCanonical('payment.succeeded', good())).toEqual({ ok: false, field: 'type' });
    expect(validateCanonical('repo.release', {})).toEqual({ ok: false, field: 'type' });
    expect(validateCanonical('order.created', { anything: 1 })).toEqual({ ok: true });
  });

  it('isReservedType / canonicalKeys', () => {
    expect(isReservedType('payment.received')).toBe(true);
    expect(isReservedType('repo.push')).toBe(true);
    expect(isReservedType('payment')).toBe(true);
    expect(isReservedType('paymentx.y')).toBe(false);
    expect(isReservedType('github.ping')).toBe(false);
    expect(canonicalKeys('repo.pull_request.merged')).toContain('merged');
    expect(canonicalKeys('stripe.customer.created')).toBeNull();
  });
});
