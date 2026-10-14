import { DestinationSender, SendResult } from './sender.interface';
import { DestinationType, NormalizedEvent } from '@hub/common';
import { createSsrfSafeAxiosConfig } from '@hub/crypto';
import { describeSendError, httpErrorMessage, postLimited } from './http-limits';
import { withUnverifiedLabel } from './unverified-label';

export class DiscordSender implements DestinationSender {
  readonly type: DestinationType = 'discord';

  async send(config: Record<string, any>, renderedContent: string, event: NormalizedEvent): Promise<SendResult> {
    const url = config.webhookUrl;
    if (!url) {
      return { status: 400, error: 'Thiếu cấu hình webhookUrl của Discord', durationMs: 0 };
    }

    // SSRF Guard: kiểm tra + PIN đúng IP đã kiểm (chống DNS rebinding, ARCHITECTURE.md §7.3)
    let ssrfConfig;
    try {
      ssrfConfig = await createSsrfSafeAxiosConfig(url);
    } catch (err: any) {
      return { status: 400, error: `SSRF Guard: ${err.message}`, durationMs: 0 };
    }

    const payload = {
      // PK5 (E4): sự kiện chưa xác thực luôn mang tiền tố "[Chưa xác thực]" — kể cả khi template tự dựng nội dung.
      content: withUnverifiedLabel(event, renderedContent || `[Webhook Hub] Nhận sự kiện ${event.type} từ ${event.source}`),
      embeds: [
        {
          title: `Sự kiện: ${event.type}`,
          description: `ID: ${event.id}\nNguồn: ${event.source}\nChủ đề: ${event.subject || 'N/A'}`,
          color: 5814783,
          timestamp: event.occurredAt,
        },
      ],
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
