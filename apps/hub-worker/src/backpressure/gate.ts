import * as amqp from 'amqplib';
import { logger } from '@hub/common';
import { backpressureHeld, backpressureSpilled } from '../metrics';
import { InFlightTracker } from '../consumers/in-flight';
import { FailureRateController } from './failure-rate.controller';

export type GatedConsumer = 'normalize' | 'delivery';

export interface GatedHandler {
  handleMessage(msg: amqp.ConsumeMessage, channel: amqp.Channel): Promise<void>;
  /** Republish sang hàng hoãn KHÔNG đốt lượt rồi ack (giữ quá trần chờ permit, §7.3). */
  spill(msg: amqp.ConsumeMessage, channel: amqp.Channel): void;
}

/**
 * BP5 §7.3 + C5 (ADR-200): chạy MỘT message qua bộ điều khiển áp lực ngược.
 * - Chờ permit TRƯỚC khi xử lý; trong lúc chờ message vẫn unacked (worker chết -> RabbitMQ giao lại).
 * - Quá `holdMaxMs` -> `spill` (republish không đốt lượt + ack).
 * - Đang tắt máy -> trả về ngay, KHÔNG xử lý, KHÔNG republish (sẽ trùng với bản RabbitMQ giao lại), KHÔNG ack.
 * - CHỈ message đã có permit mới được tính vào `inFlight` (graceful shutdown chỉ chờ những message này).
 */
export async function runGated(
  controller: FailureRateController | null,
  consumer: GatedConsumer,
  handler: GatedHandler,
  msg: amqp.ConsumeMessage,
  channel: amqp.Channel,
  inFlight: InFlightTracker,
): Promise<'done' | 'spilled' | 'shutdown'> {
  if (!controller) {
    const p = handler.handleMessage(msg, channel);
    inFlight.track(p);
    await p.catch(() => {});
    return 'done';
  }
  backpressureHeld.inc({ consumer });
  let r;
  try {
    r = await controller.acquire(consumer); // semaphore RIÊNG mỗi consumer, chung một factor (review BP5 TB-1)
  } finally {
    backpressureHeld.dec({ consumer });
  }
  if (r.kind === 'shutdown') return 'shutdown';
  if (r.kind === 'timeout') {
    backpressureSpilled.inc({ consumer });
    try {
      handler.spill(msg, channel);
    } catch (err: any) {
      // channel đóng: không ack được -> RabbitMQ giao lại; không phải vòng lặp nóng
      logger.warn({ err: err?.message, consumer }, 'Áp lực ngược: không spill được message (channel đóng?) -> để RabbitMQ giao lại');
    }
    return 'spilled';
  }
  const release = r.release;
  const p = handler.handleMessage(msg, channel).finally(release);
  inFlight.track(p);
  await p.catch(() => {});
  return 'done';
}
