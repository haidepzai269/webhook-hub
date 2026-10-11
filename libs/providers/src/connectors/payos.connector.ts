import { ConnectorError, ProviderConnector } from '../provider.interface';
import { connectorFetch, providerSays } from './http';

const last4 = (v: unknown) => {
  const s = typeof v === 'string' ? v : String(v ?? '');
  return s.length >= 4 ? s.slice(-4) : s.padStart(4, '*');
};

/**
 * KN3 (SPEC-ket-noi §5.1, ADR-138): "Kết nối PayOS" — hub gọi `POST {base}/confirm-webhook` (đúng API mà SDK
 * `webhooks.confirm` gọi) với `x-client-id`/`x-api-key`. PayOS gọi THỬ URL ingest ngay trong lúc xử lý (request kiểm tra
 * có chữ ký) và chỉ lưu URL khi ingest trả 200 — nên source + checksumKey phải COMMIT trước (khung KN2 lo thứ tự).
 * Dùng `fetch` thay vì SDK: SDK nối path tuyệt đối vào baseURL (mất tiền tố fake `/_fake/payos`), tự đọc `PAYOS_*` từ
 * env, tự retry (mỗi lần retry PayOS lại bắn một request kiểm tra) và log debug có header — xem §11.
 * PayOS không có API đọc URL hiện tại (`status?` không làm) và không xoá được URL (`disconnect?` không có).
 */
export const payosConnector: ProviderConnector = {
  spec: {
    fields: [
      { name: 'clientId', label: 'Client ID', secret: false, help: 'Kênh thanh toán → Thông tin tích hợp (my.payos.vn).' },
      { name: 'apiKey', label: 'Api Key', secret: true, help: 'Cùng màn hình với Client ID.' },
      { name: 'checksumKey', label: 'Checksum Key', secret: true, help: 'Hub dùng key này để kiểm chữ ký mọi webhook PayOS gửi về.' },
    ],
    sourceSecretField: 'checksumKey',
    overwriteWarning:
      'Mỗi kênh PayOS chỉ có một webhook URL. Kết nối sẽ THAY URL hiện tại. Nếu backend của bạn đang nhận PayOS trực tiếp, nó sẽ ngừng nhận.',
    keyHint: 'PayOS không có key hạn chế quyền: Api Key này tạo được link thanh toán. Hub mã hoá (AES-256-GCM) và không bao giờ hiện lại.',
    manualDisconnect: 'PayOS không cho xoá webhook URL qua API — muốn ngắt hẳn thì đổi URL ở dashboard PayOS (my.payos.vn → Kênh thanh toán).',
    defaultBaseUrl: 'https://api-merchant.payos.vn',
    fakeBaseUrlEnv: 'PAYOS_FAKE_BASE_URL',
  },

  async connect({ ingestUrl, credentials, baseUrl }) {
    const r = await connectorFetch(`${baseUrl}/confirm-webhook`, {
      method: 'POST',
      headers: { 'x-client-id': credentials.clientId, 'x-api-key': credentials.apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({ webhookUrl: ingestUrl }),
    });
    const body = r.json ?? {};
    if (r.status >= 200 && r.status < 300 && body.code === '00' && body.data) {
      const d = body.data;
      const account = last4(d.accountNumber);
      const name = typeof d.accountName === 'string' && d.accountName.trim() ? d.accountName.trim() : 'PayOS';
      return { remoteRef: `****${account}`, display: `${name} · ****${account}` };
    }
    if (r.status === 401 || r.status === 403) {
      throw new ConnectorError('invalid_credentials', `PayOS từ chối Client ID / Api Key${providerSays(body.desc)}. Copy lại đúng hai ô ở màn hình kênh thanh toán.`);
    }
    throw new ConnectorError(
      'webhook_rejected',
      `PayOS không xác nhận được URL ingest${providerSays(body.desc)}. PayOS gọi thử URL và cần 200: kiểm HUB_PUBLIC_URL công khai, hub-api đang chạy, Checksum Key đúng của kênh này.`,
    );
  },
};
