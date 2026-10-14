import { NormalizedEvent } from '@hub/common';

/** PK5 (E4, ADR-206): tiền tố tin nhắn Telegram/Discord của sự kiện chưa xác thực (nguồn `unverified`). */
export const UNVERIFIED_LABEL = '[Chưa xác thực]';

/** Gắn tiền tố khi `event.verified === false` (vắng = đã xác thực). Thuần. */
export function withUnverifiedLabel(event: Pick<NormalizedEvent, 'verified'>, text: string): string {
  return event.verified === false ? `${UNVERIFIED_LABEL} ${text}` : text;
}
