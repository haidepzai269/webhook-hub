import { DestinationType, NormalizedEvent } from '@hub/common';

export interface SendResult {
  status: number;
  body?: string;
  error?: string;
  durationMs: number;
}

/** Ngữ cảnh quan sát của MỘT lần gửi (LOGGING.md §4) — KHÔNG bao giờ nằm trong chuỗi ký. */
export interface SendContext {
  /** W3C `traceparent` của lần thử này; sender webhook thêm vào header gửi đích (đích có OTel nối được trace). */
  traceparent?: string;
}

export interface DestinationSender {
  readonly type: DestinationType;
  send(
    config: Record<string, any>,
    renderedContent: string,
    event: NormalizedEvent,
    signingSecret?: string,
    ctx?: SendContext,
  ): Promise<SendResult>;
}
