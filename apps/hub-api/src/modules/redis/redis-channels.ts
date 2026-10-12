import { EventEmitter } from 'events';

/**
 * ADR-180: registry kênh Redis pub/sub dùng CHUNG một connection subscriber của hub-api (connection do
 * RealtimeGateway mở). Upstash giới hạn số kết nối — mỗi module tự mở subscriber riêng là phí một kết nối.
 * Module đăng ký kênh + handler ở đây (kiểu `access-revocation.ts`: không inject gateway, không phụ thuộc vòng);
 * gateway subscribe mọi kênh đã đăng ký và chuyển tin tới handler. Kênh realtime của hub-worker
 * (`REALTIME_CHANNELS`) vẫn do gateway tự xử lý như cũ.
 */
type Handler = (message: string) => void;

const handlers = new Map<string, Set<Handler>>();
const bus = new EventEmitter();
bus.setMaxListeners(50);
const CHANNEL_ADDED = 'channel.added';

/** Đăng ký handler cho `channel`; trả hàm huỷ đăng ký. Kênh mới -> báo subscriber subscribe thêm. */
export function onRedisChannel(channel: string, fn: Handler): () => void {
  let set = handlers.get(channel);
  const isNew = !set;
  if (!set) handlers.set(channel, (set = new Set()));
  set.add(fn);
  if (isNew) bus.emit(CHANNEL_ADDED, channel);
  return () => {
    set!.delete(fn);
    if (set!.size === 0) handlers.delete(channel);
  };
}

/** Các kênh đang có handler (subscriber đọc lúc kết nối). */
export function registeredRedisChannels(): string[] {
  return [...handlers.keys()];
}

/** Subscriber gọi khi có tin. Trả false nếu kênh không có handler. Handler lỗi không làm hỏng handler khác. */
export function dispatchRedisMessage(channel: string, message: string): boolean {
  const set = handlers.get(channel);
  if (!set) return false;
  for (const fn of set) {
    try {
      fn(message);
    } catch {
      // handler tự log; một handler ném không được chặn các handler còn lại
    }
  }
  return true;
}

/** Subscriber nghe kênh được đăng ký SAU khi đã kết nối. */
export function onRedisChannelAdded(fn: (channel: string) => void): () => void {
  bus.on(CHANNEL_ADDED, fn);
  return () => bus.off(CHANNEL_ADDED, fn);
}
