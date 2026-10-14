import { ConnectorError, ProviderConnector } from '../provider.interface';
import { connectorFetch, providerSays } from './http';
import { STRIPE_PAYMENT_TYPES } from '../stripe-types';

/** Chỉ đăng ký các event mà StripeAdapter.normalize hiểu (ra kiểu chuẩn payment.*) — không rác vào raw_events. */
export const STRIPE_ENABLED_EVENTS = Object.keys(STRIPE_PAYMENT_TYPES);

function auth(credentials: Record<string, string>) {
  return { authorization: `Bearer ${credentials.secretKey}` };
}

function fail(status: number, body: any): never {
  const says = providerSays(body?.error?.message);
  if (status === 401) throw new ConnectorError('invalid_credentials', `Stripe từ chối key${says}. Dán lại restricted key (rk_…) của đúng tài khoản/chế độ.`);
  if (status === 403) throw new ConnectorError('insufficient_permissions', `Key thiếu quyền${says}. Tạo restricted key có quyền "Webhook Endpoints: Write".`);
  throw new ConnectorError('stripe_rejected', `Stripe không tạo được webhook endpoint${says}. Kiểm URL ingest (HUB_INGEST_PUBLIC_URL, thiếu thì HUB_PUBLIC_URL) là https công khai.`);
}

/**
 * KN4 (SPEC-ket-noi §5.2, ADR-138): "Kết nối Stripe" — `POST {base}/v1/webhook_endpoints` (form-encoded, `fetch`, không
 * thêm SDK). Stripe SINH signing secret và chỉ trả MỘT lần lúc tạo -> `sourceSecret` (khung KN2 lưu thành SourceSecret
 * version mới). Dev không nhập secret ký. Kết nối lại = tạo endpoint mới; khung KN2 gỡ `we_` cũ và giữ secret cũ 24 giờ.
 */
export const stripeConnector: ProviderConnector = {
  spec: {
    fields: [
      {
        name: 'secretKey',
        label: 'Restricted key (rk_…)',
        secret: true,
        help: 'Stripe Dashboard → Developers → API keys → Create restricted key, chỉ bật "Webhook Endpoints: Write".',
      },
    ],
    keyHint: 'Dùng restricted key CHỈ có quyền webhook_endpoints: write (không dùng secret key sk_ đầy đủ quyền). Hub mã hoá và không bao giờ hiện lại.',
    defaultBaseUrl: 'https://api.stripe.com',
    fakeBaseUrlEnv: 'STRIPE_FAKE_BASE_URL',
  },

  async connect({ ingestUrl, credentials, baseUrl }) {
    const form = new URLSearchParams({ url: ingestUrl, description: 'Webhook Hub' });
    for (const e of STRIPE_ENABLED_EVENTS) form.append('enabled_events[]', e);
    const r = await connectorFetch(`${baseUrl}/v1/webhook_endpoints`, {
      method: 'POST',
      headers: { ...auth(credentials), 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    const b = r.json ?? {};
    if (r.status < 200 || r.status >= 300 || typeof b.id !== 'string' || typeof b.secret !== 'string') fail(r.status, b);
    const mode = /^(sk|rk)_test_/.test(credentials.secretKey) ? 'test' : 'live';
    return { remoteRef: b.id, display: `Stripe (${mode}) · ${b.id}`, sourceSecret: b.secret };
  },

  async status({ credentials, remoteRef, ingestUrl, baseUrl }) {
    const r = await connectorFetch(`${baseUrl}/v1/webhook_endpoints/${encodeURIComponent(remoteRef)}`, { method: 'GET', headers: auth(credentials) });
    if (r.status === 404) return 'gone';
    if (r.status < 200 || r.status >= 300) fail(r.status, r.json);
    return r.json?.url === ingestUrl ? 'ok' : 'drifted';
  },

  async disconnect({ credentials, remoteRef, baseUrl }) {
    const r = await connectorFetch(`${baseUrl}/v1/webhook_endpoints/${encodeURIComponent(remoteRef)}`, { method: 'DELETE', headers: auth(credentials) });
    if (r.status === 404) return; // đã không còn — coi như ngắt xong
    if (r.status < 200 || r.status >= 300) fail(r.status, r.json);
  },
};
