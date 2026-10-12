import { GithubAdapter, PayosAdapter, SepayAdapter, StripeAdapter } from '../src';
import { canonicalKeys, isReservedType, NormalizedEvent, validateCanonical, HUB_CLEANUP_SUGGESTED, HUB_SUGGESTION_KEYS, RuleAdvisor } from '@hub/common';
import * as f from './fixtures';

/**
 * U50 — hợp đồng catalog: chạy MỌI fixture của 4 adapter, tập khoá `data` phải khớp TUYỆT ĐỐI
 * với danh sách khoá khai báo của kiểu chuẩn. Thêm/bớt khoá mà không sửa catalog -> đỏ (luật 7).
 */
describe('[MS:U50] U50 hợp đồng catalog', () => {
  const gh = (event: string, body: unknown) =>
    new GithubAdapter().normalize(f.req('github', body, { 'x-github-event': event }), f.ctx);
  const all: [string, NormalizedEvent[]][] = [
    ['payos success', new PayosAdapter().normalize(f.req('payos', f.payosSuccess()), f.ctx)],
    ['payos failed', new PayosAdapter().normalize(f.req('payos', f.payosFailed()), f.ctx)],
    // Review #5: PayOS code≠00 gửi amount=0 -> vẫn là payment.failed hợp lệ
    ['payos failed amount 0', new PayosAdapter().normalize(f.req('payos', { ...f.payosFailed(), data: { ...f.payosFailed().data, amount: 0 } }), f.ctx)],
    ['sepay in', new SepayAdapter().normalize(f.req('sepay', f.sepayTx()), f.ctx)],
    ['sepay out', new SepayAdapter().normalize(f.req('sepay', f.sepayTx({ transferType: 'out' })), f.ctx)],
    ['stripe pi ok', new StripeAdapter().normalize(f.req('stripe', f.stripePiSucceeded()), f.ctx)],
    ['stripe pi fail', new StripeAdapter().normalize(f.req('stripe', f.stripePiFailed()), f.ctx)],
    ['stripe refund', new StripeAdapter().normalize(f.req('stripe', f.stripeChargeRefunded()), f.ctx)],
    ['stripe customer', new StripeAdapter().normalize(f.req('stripe', f.stripeCustomerCreated()), f.ctx)],
    ['gh push', gh('push', f.githubPush(3))],
    ['gh pr merged', gh('pull_request', f.githubPr('closed', true))],
    ['gh pr opened', gh('pull_request', f.githubPr('opened', false))],
    ['gh issue', gh('issues', f.githubIssue('labeled'))],
    ['gh ping', gh('ping', f.githubPing())],
    ['gh release', gh('release', f.githubRelease())],
  ];

  it.each(all)('%s', (_name, events) => {
    expect(events).toHaveLength(1);
    const e = events[0];
    expect(typeof e.normalized).toBe('boolean');
    if (e.normalized) {
      expect(isReservedType(e.type)).toBe(true);
      expect(Object.keys(e.data).sort()).toEqual([...(canonicalKeys(e.type) ?? ['<không có trong catalog>'])].sort());
      expect(validateCanonical(e.type, e.data)).toEqual({ ok: true });
    } else {
      // Kiểu chưa ánh xạ: không bao giờ chiếm không gian dành riêng; data chỉ có raw.
      expect(isReservedType(e.type)).toBe(false);
      expect(e.type.startsWith(`${e.source}.`)).toBe(true);
      expect(Object.keys(e.data)).toEqual(['raw']);
    }
    // `probe` (ADR-159/162): cờ tuỳ chọn của phong bì — chỉ có khi true, chỉ trên kiểu chưa ánh xạ (github.ping, payos.webhook_test).
    if ('probe' in e) {
      expect(e.probe).toBe(true);
      expect(e.normalized).toBe(false);
    }
    const { probe: _probe, ...envelopeOnly } = e;
    // Phong bì không đổi (luật 1)
    expect(Object.keys(envelopeOnly).sort()).toEqual(
      ['correlationId', 'data', 'id', 'normalized', 'occurredAt', 'origin', 'rawEventId', 'receivedAt', 'source', 'sourceId', 'subject', 'tenantId', 'type'].sort(),
    );
  });
});

/**
 * QT4b (ADR-187): miền `hub.*` — sự kiện do CHÍNH hub phát. Cùng luật hợp đồng với kiểu chuẩn của adapter: tập khoá `data`
 * khớp TUYỆT ĐỐI catalog, qua validator; phần tử `suggestions[]` cũng đủ khoá. Thêm/bớt khoá mà không sửa catalog -> đỏ.
 */
describe('[QT:T24] (phần e) U50 hợp đồng catalog — hub.project.cleanup_suggested', () => {
  it('data + suggestions[] khớp tuyệt đối khoá catalog; hub.* là không gian dành riêng', async () => {
    const suggestions = await new RuleAdvisor(() => 0).suggest({
      usedBytes: 0,
      quotaBytes: 1,
      level: 'OK',
      growthPerDay: 0,
      buckets: [{ sourceId: null, importance: 'low', ageDays: 9, events: 1, bytes: 10 }],
      policies: [],
      keepLongerSourceIds: [],
    });
    const data = { level: 'WARN_70', usedBytes: 1, quotaBytes: 2, forecastHours: 1.5, suggestions };
    expect(isReservedType(HUB_CLEANUP_SUGGESTED)).toBe(true);
    expect(Object.keys(data).sort()).toEqual([...(canonicalKeys(HUB_CLEANUP_SUGGESTED) ?? [])].sort());
    expect(Object.keys(suggestions[0]).sort()).toEqual([...HUB_SUGGESTION_KEYS].sort());
    expect(validateCanonical(HUB_CLEANUP_SUGGESTED, data)).toEqual({ ok: true });
  });
});

