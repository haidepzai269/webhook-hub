import { StripeAdapter } from '../src';
import { validateCanonical } from '@hub/common';
import { ctx, req, stripeChargeRefunded, stripeCustomerCreated, stripePiFailed, stripePiSucceeded } from './fixtures';

/** U38–U39 — Stripe ra kiểu chuẩn hoặc stripe.<type gốc>. */
describe('Stripe -> catalog', () => {
  const a = new StripeAdapter();

  it('U38 payment_intent.succeeded -> payment.received (cent, USD, card, paidAt = created)', () => {
    const body = stripePiSucceeded();
    const [e] = a.normalize(req('stripe', body), ctx);
    expect(e.type).toBe('payment.received');
    expect(e.normalized).toBe(true);
    expect(e.data).toMatchObject({
      amount: 1999,
      currency: 'USD',
      method: 'card',
      reference: 'pi_3MtwBwLkdIwHu7ix28a3tqPa',
      providerTxnId: 'pi_3MtwBwLkdIwHu7ix28a3tqPa',
      memo: 'Order DH1',
    });
    expect(e.data.paidAt).toBe(new Date(body.created * 1000).toISOString());
    expect(e.subject).toBe('payment:pi_3MtwBwLkdIwHu7ix28a3tqPa');
    expect(validateCanonical(e.type, e.data)).toEqual({ ok: true });
  });

  it('payment_failed -> payment.failed (reason); charge.refunded -> payment.refunded (amount_refunded)', () => {
    const [f] = a.normalize(req('stripe', stripePiFailed()), ctx);
    expect(f.type).toBe('payment.failed');
    expect(f.data.reason).toBe('Your card was declined.');
    expect(f.data.amount).toBe(1999);
    expect(validateCanonical(f.type, f.data)).toEqual({ ok: true });
    const [r] = a.normalize(req('stripe', stripeChargeRefunded()), ctx);
    expect(r.type).toBe('payment.refunded');
    expect(r.data.amount).toBe(500);
    expect(r.data.method).toBe('card');
    expect(validateCanonical(r.type, r.data)).toEqual({ ok: true });
  });

  it('U39 customer.created -> stripe.customer.created, normalized:false, data chỉ có raw', () => {
    const body = stripeCustomerCreated();
    const [e] = a.normalize(req('stripe', body), ctx);
    expect(e.type).toBe('stripe.customer.created');
    expect(e.normalized).toBe(false);
    expect(Object.keys(e.data)).toEqual(['raw']);
    expect(e.data.raw).toEqual(body);
  });
});
