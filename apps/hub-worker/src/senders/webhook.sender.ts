import { DestinationSender, SendResult } from './sender.interface';
import { DestinationType, NormalizedEvent } from '@hub/common';
import { hmacSha256, validateAndPinUrl } from '@hub/crypto';
import axios from 'axios';

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
      // 1. SSRF Guard kiểm tra và pin IP (ARCHITECTURE.md §7.3)
      await validateAndPinUrl(rawUrl);

      const timestamp = Math.floor(Date.now() / 1000);
      const body = {
        id: event.id,
        type: event.type,
        source: event.source,
        subject: event.subject,
        data: event.data,
        occurredAt: event.occurredAt,
        receivedAt: event.receivedAt,
        renderedContent: renderedContent || undefined,
      };

      const bodyString = JSON.stringify(body);
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'X-Hub-Event-Id': event.id,
        'X-Hub-Timestamp': String(timestamp),
      };

      // 2. Ký HMAC theo chuẩn Standard Webhooks
      if (signingSecret) {
        const payloadToSign = `${event.id}.${timestamp}.${bodyString}`;
        const signature = hmacSha256(signingSecret, payloadToSign);
        headers['X-Hub-Signature'] = `v1=${signature}`;
      }

      // 3. Gọi HTTP: maxRedirects: 0 để chống SSRF Redirect
      const res = await axios.post(rawUrl, bodyString, {
        timeout: 5000,
        maxRedirects: 0,
        headers,
      });

      return {
        status: res.status,
        body: typeof res.data === 'string' ? res.data.substring(0, 2048) : JSON.stringify(res.data || {}).substring(0, 2048),
        durationMs: Date.now() - start,
      };
    } catch (err: any) {
      return {
        status: err.response?.status || 500,
        error: err.message,
        body: typeof err.response?.data === 'string' ? err.response.data.substring(0, 2048) : JSON.stringify(err.response?.data || {}).substring(0, 2048),
        durationMs: Date.now() - start,
      };
    }
  }
}
