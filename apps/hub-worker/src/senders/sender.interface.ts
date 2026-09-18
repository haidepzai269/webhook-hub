import { DestinationType, NormalizedEvent } from '@hub/common';

export interface SendResult {
  status: number;
  body?: string;
  error?: string;
  durationMs: number;
}

export interface DestinationSender {
  readonly type: DestinationType;
  send(
    config: Record<string, any>,
    renderedContent: string,
    event: NormalizedEvent,
    signingSecret?: string,
  ): Promise<SendResult>;
}
