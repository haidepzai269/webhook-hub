import { DestinationSender, SendResult } from './sender.interface';
import { DestinationType, NormalizedEvent } from '@hub/common';
import { createSsrfSafeAxiosConfig, swHeaders } from '@hub/crypto';
import { describeSendError, httpErrorMessage, postLimited } from './http-limits';

export class WebhookSender implements DestinationSender {
  readonly type: DestinationType = 'webhook';

  async send(
    config: Record<string, any>,
    renderedContent: string,
    event: NormalizedEvent,
    signingSecret?: string,
  ): Promise<SendResult> {
    const rawUrl = config.url;
    if (!rawUrl) {
      return { status: 400, error: 'Thiếu cấu hình url đích webhook', durationMs: 0 };
    }

    const start = Date.now();
    try {
      // 1. SSRF Guard: kiểm tra + PIN đúng IP đã kiểm (chống DNS rebinding, §7.3).
      // httpAgent/httpsAgent bên dưới override `lookup` để axios connect thẳng
      // vào IP đã pin thay vì tự resolve DNS lại lúc gọi thật.
      const ssrfConfig = await createSsrfSafeAxiosConfig(rawUrl);

      const timestamp = Math.floor(Date.now() / 1000);
      const body = {
        id: event.id,
        type: event.type,
        source: event.source,
        // R-1 (ADR-094): id source CỤ THỂ — bên nhận so với sourceIds đã ghim (tên provider không phải danh tính).
        sourceId: event.sourceId || null,
        subject: event.subject,
        // S3-2 (ADR-053): true = `data` theo catalog kiểu chuẩn (docs/EVENT-CATALOG.md); false = `{ raw }`.
        normalized: event.normalized !== false,
        data: event.data,
        occurredAt: event.occurredAt,
        receivedAt: event.receivedAt,
        renderedContent: renderedContent || undefined,
      };

      const bodyString = JSON.stringify(body);
      // 2. Standard Webhooks (S6, ADR-040): `webhook-id` = event.id — GIỮ NGUYÊN qua mọi retry/replay để đích
      // chống trùng; chữ ký `v1,<base64>` trên `${id}.${ts}.${body}`. KHÔNG còn X-Hub-* (không gửi song song).
      const headers: Record<string, string> = signingSecret
        ? { 'Content-Type': 'application/json', ...swHeaders(signingSecret, event.id, bodyString, timestamp) }
        : { 'Content-Type': 'application/json', 'webhook-id': event.id, 'webhook-timestamp': String(timestamp) };

      // 3. Gọi HTTP: maxRedirects: 0 để chống SSRF Redirect; agent đã pin IP ở trên. Phản hồi đọc tối
      // đa 64KB, status từ dòng trạng thái — 2xx body lớn vẫn là thành công (ADR-054).
      const res = await postLimited(ssrfConfig.url, bodyString, {
        headers,
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
      return {
        status: err.response?.status || 500,
        error: describeSendError(err),
        body: typeof err.response?.data === 'string' ? err.response.data.substring(0, 2048) : JSON.stringify(err.response?.data || {}).substring(0, 2048),
        durationMs: Date.now() - start,
      };
    }
  }
}
