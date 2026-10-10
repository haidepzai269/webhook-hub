/**
 * Payload mẫu theo tài liệu chính thức của từng provider (rút gọn, giữ đúng TÊN TRƯỜNG) —
 * dùng cho test catalog kiểu chuẩn (U34–U42, U50). Nguồn:
 * - PayOS: https://payos.vn/docs/du-lieu-tra-ve/webhook/
 * - SePay: https://docs.sepay.vn/tich-hop-webhooks.html
 * - Stripe: https://docs.stripe.com/api/events/object (payment_intent / charge)
 * - GitHub: https://docs.github.com/webhooks/webhook-events-and-payloads
 */
import { RawWebhookRequest, ProviderType } from '@hub/common';

export function req(provider: ProviderType, body: unknown, headers: Record<string, string> = {}): RawWebhookRequest {
  const raw = JSON.stringify(body);
  return { provider, sourceKey: 'fixture', headers, rawBody: Buffer.from(raw), body: JSON.parse(raw) };
}

export const ctx = {
  tenantId: '00000000-0000-0000-0000-000000000001',
  sourceId: 'src_fixture',
  correlationId: '11111111-1111-1111-1111-111111111111',
  rawEventId: '22222222-2222-2222-2222-222222222222',
};

// ---------------- PayOS ----------------
export const payosData = (over: Record<string, unknown> = {}) => ({
  orderCode: 123456,
  amount: 50000,
  description: 'DH123456 thanh toan',
  accountNumber: '12345678',
  reference: 'TF230204212323',
  transactionDateTime: '2026-10-10 14:02:37',
  currency: 'VND',
  paymentLinkId: '124c33293c43417ab7879e14c8d9eb18',
  code: '00',
  desc: 'success',
  counterAccountBankId: '',
  counterAccountBankName: '',
  counterAccountName: '',
  counterAccountNumber: '',
  virtualAccountName: '',
  virtualAccountNumber: '',
  ...over,
});
export const payosSuccess = (over: Record<string, unknown> = {}) => ({
  code: '00', desc: 'success', success: true, data: payosData(over), signature: 'sig-not-checked-here',
});
export const payosFailed = () => ({
  code: '01', desc: 'Giao dịch thất bại', success: false, data: payosData({ code: '01', desc: 'Giao dịch thất bại' }), signature: 'x',
});

// ---------------- SePay ----------------
export const sepayTx = (over: Record<string, unknown> = {}) => ({
  id: 92704,
  gateway: 'Vietcombank',
  transactionDate: '2026-10-10 14:02:37',
  accountNumber: '0123499999',
  code: null,
  content: 'DH123456 thanh toan',
  transferType: 'in',
  transferAmount: 50000,
  accumulated: 19077000,
  subAccount: null,
  referenceCode: 'MBVCB.3278907687',
  description: 'BankAPINotify DH123456 thanh toan',
  ...over,
});

// ---------------- Stripe ----------------
export const stripeEvent = (type: string, object: Record<string, unknown>) => ({
  id: 'evt_1NG8Du2eZvKYlo2CUI79vXWy',
  object: 'event',
  api_version: '2024-06-20',
  created: 1760104957,
  data: { object },
  livemode: false,
  pending_webhooks: 1,
  type,
});
export const stripePiSucceeded = () =>
  stripeEvent('payment_intent.succeeded', {
    id: 'pi_3MtwBwLkdIwHu7ix28a3tqPa', object: 'payment_intent', amount: 1999, amount_received: 1999,
    currency: 'usd', description: 'Order DH1', payment_method_types: ['card'], status: 'succeeded',
    last_payment_error: null, created: 1760104950,
  });
export const stripePiFailed = () =>
  stripeEvent('payment_intent.payment_failed', {
    id: 'pi_3MtwBwLkdIwHu7ix28a3tqPb', object: 'payment_intent', amount: 1999, amount_received: 0,
    currency: 'usd', description: null, payment_method_types: ['card'], status: 'requires_payment_method',
    last_payment_error: { code: 'card_declined', message: 'Your card was declined.' },
  });
export const stripeChargeRefunded = () =>
  stripeEvent('charge.refunded', {
    id: 'ch_3MmlLrLkdIwHu7ix0snN0B15', object: 'charge', amount: 1999, amount_refunded: 500,
    currency: 'usd', description: null, payment_method_details: { type: 'card' }, refunded: false,
  });
export const stripeCustomerCreated = () =>
  stripeEvent('customer.created', { id: 'cus_NffrFeUfNV2Hib', object: 'customer', email: 'a@example.com' });

// ---------------- GitHub ----------------
const repository = { id: 1, name: 'webhook-hub', full_name: 'kien/webhook-hub', html_url: 'https://github.com/kien/webhook-hub' };
const sender = { login: 'kien', id: 9 };
export const githubPush = (n = 2, ref = 'refs/heads/main') => {
  const commits = Array.from({ length: n }, (_, i) => ({
    id: `c${String(i).padStart(39, '0')}`,
    message: `commit ${i}`,
    timestamp: '2026-10-10T14:02:37+07:00',
    url: `https://github.com/kien/webhook-hub/commit/c${i}`,
    author: { name: 'Kien', email: 'kien@example.com', username: 'kien' },
    committer: { name: 'Kien', email: 'kien@example.com', username: 'kien' },
  }));
  return {
    ref, before: '0'.repeat(40), after: 'a'.repeat(40), repository, pusher: { name: 'kien', email: 'kien@example.com' },
    sender, created: false, deleted: false, forced: false,
    compare: 'https://github.com/kien/webhook-hub/compare/000...aaa',
    commits, head_commit: commits[commits.length - 1] ?? null,
  };
};
export const githubPr = (action: string, merged: boolean) => ({
  action,
  number: 7,
  pull_request: {
    number: 7, title: 'Add canonical catalog', state: action === 'closed' ? 'closed' : 'open', merged,
    html_url: 'https://github.com/kien/webhook-hub/pull/7', user: { login: 'amelia' },
    base: { ref: 'main' }, head: { ref: 'feat/s14' },
  },
  repository, sender,
});
export const githubIssue = (action: string) => ({
  action,
  issue: {
    number: 3, title: 'Bug', state: 'open', html_url: 'https://github.com/kien/webhook-hub/issues/3',
    user: { login: 'mary' }, labels: [{ name: 'bug' }, { name: 'p1' }],
  },
  repository, sender,
});
export const githubPing = () => ({ zen: 'Keep it logically awesome.', hook_id: 1, hook: { type: 'Repository' }, repository, sender });
export const githubRelease = () => ({ action: 'published', release: { tag_name: 'v1.0.0' }, repository, sender });
