/**
 * DX3b (`hub trigger`, SPEC-dev-experience §4.4): payload MẪU đúng khuôn catalog cho từng kiểu chuẩn — dev thử handler
 * mà không cần provider thật hay tài khoản ngân hàng. Mẫu vẫn đi đường ingest bình thường (`POST /events` ->
 * `validateCanonical`), không có lối tắt. Test khoá: mọi mẫu qua `validateCanonical` (UX16).
 * Không chứa khái niệm của Shop (BB-1): memo là chuỗi tự do, không có mã đơn.
 */
import { PAYMENT_TYPES } from './payment';

const REPO = { fullName: 'acme/demo', url: 'https://github.com/acme/demo' };
const ACTOR = { login: 'octocat' };

/** `id` duy nhất cho mỗi lần gọi -> providerTxnId/subject không trùng giữa các lần trigger. */
export function canonicalSample(type: string, now = new Date(), id = String(now.getTime())): Record<string, unknown> | null {
  const at = now.toISOString();
  if (PAYMENT_TYPES.includes(type)) {
    const core = {
      amount: 50000,
      currency: 'VND',
      method: 'bank_transfer',
      reference: `TRIGGER${id}`,
      memo: 'hub trigger sample',
      counterparty: { name: 'NGUYEN VAN A', accountNumber: null, bank: 'MBBank' },
      account: { number: null, bank: 'MBBank' },
      providerTxnId: `trigger-${id}`,
      raw: { sample: true },
    };
    if (type === 'payment.received') return { ...core, paidAt: at };
    if (type === 'payment.sent') return { ...core, sentAt: at };
    if (type === 'payment.failed') return { ...core, failedAt: at, reason: 'sample failure' };
    return { ...core, refundedAt: at };
  }
  if (type === 'repo.push') {
    return {
      repo: REPO,
      branch: 'main',
      tag: null,
      commits: [{ id: `c0ffee${id}`, message: 'hub trigger sample commit', author: 'octocat', url: `${REPO.url}/commit/c0ffee${id}`, timestamp: at }],
      commitCount: 1,
      actor: ACTOR,
      compareUrl: null,
      raw: { sample: true },
    };
  }
  if (/^repo\.pull_request\.[a-z_]+$/.test(type)) {
    return {
      repo: REPO, number: 1, title: 'hub trigger sample PR', state: type.endsWith('.closed') ? 'closed' : 'open',
      merged: false, url: `${REPO.url}/pull/1`, author: ACTOR, actor: ACTOR, baseBranch: 'main', headBranch: 'feature', raw: { sample: true },
    };
  }
  if (/^repo\.issue\.[a-z_]+$/.test(type)) {
    return {
      repo: REPO, number: 1, title: 'hub trigger sample issue', state: type.endsWith('.closed') ? 'closed' : 'open',
      url: `${REPO.url}/issues/1`, author: ACTOR, actor: ACTOR, labels: ['sample'], raw: { sample: true },
    };
  }
  return null;
}

/** Kiểu có mẫu sẵn (in ra trong `hub trigger --help`). */
export const SAMPLE_TYPES = [...PAYMENT_TYPES, 'repo.push', 'repo.pull_request.opened', 'repo.issue.opened'];
