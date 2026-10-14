import { DestinationSender, SendResult } from './sender.interface';
import { DestinationType, NormalizedEvent } from '@hub/common';
import { createSsrfSafeAxiosConfig } from '@hub/crypto';
import { describeSendError, httpErrorMessage, postLimited } from './http-limits';
import { withUnverifiedLabel } from './unverified-label';

export class TelegramSender implements DestinationSender {
  readonly type: DestinationType = 'telegram';

  async send(config: Record<string, any>, renderedContent: string, event: NormalizedEvent): Promise<SendResult> {
    const { botToken, chatId } = config;
    if (!botToken || !chatId) {
      return { status: 400, error: 'Thiếu cấu hình botToken hoặc chatId Telegram', durationMs: 0 };
    }

    // URL mock (nếu có) do seed ghi vào config.apiUrl — sender không tự đoán localhost
    const baseUrl = config.apiUrl || 'https://api.telegram.org';
    const url = `${baseUrl}/bot${botToken}/sendMessage`;

    // SSRF Guard: config.apiUrl có thể bị override tùy ý — bắt buộc qua guard
    // trước khi gọi HTTP thật, kể cả khi trỏ về base URL mặc định của Telegram.
    let ssrfConfig;
    try {
      ssrfConfig = await createSsrfSafeAxiosConfig(url);
    } catch (err: any) {
      return { status: 400, error: `SSRF Guard: ${err.message}`, durationMs: 0 };
    }

    // PK5 (E4): sự kiện chưa xác thực luôn mang tiền tố "[Chưa xác thực]" — kể cả khi template tự dựng nội dung.
    const text = withUnverifiedLabel(event, renderedContent || `[Webhook Hub] Sự kiện: ${event.type}\nID: ${event.id}\nNguồn: ${event.source}`);
    // Văn bản THUẦN (S1-7, ADR-042): không đặt parse_mode. Với Markdown, một dấu '_' hay '*' lẻ trong
    // dữ liệu (tên repo, nội dung chuyển khoản) làm Telegram trả 400 -> non-retryable -> DEAD.
    const payload = {
      chat_id: chatId,
      text,
    };

    const start = Date.now();
    try {
      // Phản hồi đọc tối đa 64KB; status từ dòng trạng thái — 2xx body lớn vẫn là thành công (ADR-054).
      const res = await postLimited(ssrfConfig.url, payload, {
        headers: { 'Content-Type': 'application/json' },
        httpAgent: ssrfConfig.httpAgent,
        httpsAgent: ssrfConfig.httpsAgent,
      });
      return {
        status: res.status,
        body: res.body.substring(0, 2048),
        error: httpErrorMessage(res.status),
        durationMs: Date.now() - start,
      };
    } catch (err: any) {
      // Không có phản hồi (lỗi mạng / timeout) -> 500 retryable, tính vào circuit.
      return {
        status: err.response?.status || 500,
        error: describeSendError(err),
        body: '',
        durationMs: Date.now() - start,
      };
    }
  }
}
