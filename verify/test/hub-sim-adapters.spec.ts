import { RawWebhookRequest } from '@hub/common';
import { ProviderRegistry, validateGenericConfig } from '@hub/providers';
import { listFixtures, loadFixture, prepare, Fixture } from '../../tools/hub-sim/src/fixture';

/**
 * VF3 (SPEC-verification §5): fixture của hub-sim (ký ĐỘC LẬP, tools/hub-sim) đi qua ADAPTER THẬT của hub.
 * Hai phía viết riêng mà khớp nhau = bằng chứng cả hai hiểu đúng định dạng provider (không phải "hub tự đồng ý với
 * chính hub", §5.1). L0: chỉ verify + normalize, không HTTP; bản HTTP (401 thật qua ingest) là L2 (VF4).
 */
const SECRET = 'VERIFY_ONLY_sim_secret_for_adapter_check';
const ctx = { tenantId: '00000000-0000-0000-0000-000000000001', sourceId: 'src_sim', correlationId: 'c', rawEventId: 'r', receivedAt: '2026-10-10T07:02:37.000Z' };

function adapterCtx(f: Fixture) {
  if (!f.sourceConfig) return {};
  const r = validateGenericConfig(f.sourceConfig);
  if (!r.ok) throw new Error(`sourceConfig của ${f.case} sai: ${(r as any).field}`);
  return { verificationConfig: (r as any).config };
}

function toReq(f: Fixture, body: Buffer, headers: Record<string, string>): RawWebhookRequest {
  return { provider: f.provider as any, sourceKey: 'src_sim', headers, rawBody: body, body: JSON.parse(body.toString('utf8')), contentType: 'application/json' };
}

describe('hub-sim × adapter thật (VF3)', () => {
  const all = listFixtures().map((id) => [id, loadFixture(id)] as const);

  it.each(all)('VF3: %s — adapter.verify khớp expect.status, normalize ra đúng kiểu', async (_id, f) => {
    const p = prepare(f, SECRET);
    const adapter = ProviderRegistry.get(f.provider as any);
    const c = adapterCtx(f);
    const ok = await adapter.verify(toReq(f, p.body, p.headers), [SECRET], c as any);
    expect(ok).toBe(f.expect.status === 200);
    if (f.expect.status === 200 && f.expect.type) {
      const [e] = adapter.normalize(toReq(f, p.body, p.headers), { ...ctx, ...c } as any);
      expect({ type: e.type, normalized: e.normalized }).toEqual({ type: f.expect.type, normalized: f.expect.normalized });
    }
  });

  it('[VF:VT6] (phần a) Stripe t cũ (không ký lại thời gian): HMAC đúng nhưng adapter từ chối — chống phát lại', async () => {
    const f = loadFixture('stripe/stale-timestamp');
    const p = prepare(f, SECRET);
    expect(p.headers['stripe-signature']).toMatch(/^t=1760000000,/);
    expect(await ProviderRegistry.get('stripe').verify(toReq(f, p.body, p.headers), [SECRET])).toBe(false);
    // Cùng body, ký lại t = now -> chấp nhận: lý do từ chối đúng là thời gian, không phải chữ ký.
    const fresh = prepare({ ...f, signature: { ...f.signature, fixedAt: undefined } }, SECRET);
    expect(await ProviderRegistry.get('stripe').verify(toReq(f, fresh.body, fresh.headers), [SECRET])).toBe(true);
  });

  it('VF3 (§5.4, P-SIG-02): fixture "bytes lạ" — ai lỡ tính HMAC trên JSON đã parse thì ký KHÁC (Stripe/GitHub/AB Bank)', async () => {
    for (const id of ['stripe/pi-succeeded', 'github/push', 'generic/x-signature-ok']) {
      const f = loadFixture(id);
      const p = prepare(f, SECRET);
      const reparsed = Buffer.from(JSON.stringify(JSON.parse(p.body.toString('utf8'))));
      // Chữ ký tính trên bytes gốc, nhưng body đưa vào adapter là bản đã stringify lại -> phải từ chối.
      const adapter = ProviderRegistry.get(f.provider as any);
      expect(await adapter.verify(toReq(f, reparsed, p.headers), [SECRET], adapterCtx(f) as any)).toBe(false);
    }
  });
});
