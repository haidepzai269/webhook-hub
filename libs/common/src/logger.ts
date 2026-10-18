import pino, { DestinationStream, Logger } from 'pino';
import { LOG_REDACT_OPTIONS, scrubSecrets } from './auth/redact';

/**
 * LOGGING.md §3.1: `svc` (`hub-api` | `hub-worker`) ở MỌI dòng. Đặt MỘT lần ở `main.ts` của từng tiến trình
 * (`setServiceName`) — `mixin` đọc lúc ghi nên không cần tạo lại logger (các module đã import `logger` ở top-level).
 * Lệch thiết kế: LOGGING.md ghi "base của logger"; `base` bị cố định lúc tạo pino nên dùng `mixin` (ADR-254).
 */
let serviceName: string | undefined;
export function setServiceName(name: 'hub-api' | 'hub-worker'): void {
  serviceName = name;
}

/** Cấu hình pino của hub — tách ra để test dựng logger ghi vào luồng bắt log (bãi mìn §5) với ĐÚNG redact/scrub. */
export function createLogger(destination?: DestinationStream): Logger {
  const opts = {
    level: process.env.LOG_LEVEL || 'info',
    formatters: {
      level: (label: string) => ({ level: label }),
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    // ADR-051 + SPEC-auth UA22: lưới an toàn — header nhạy cảm, khoá `password`/`token`… bị che theo TÊN KHOÁ;
    // chuỗi thông điệp được quét thêm (`hk_live_…`, cookie phiên, Bearer) vì bí mật có thể nằm giữa câu.
    redact: LOG_REDACT_OPTIONS,
    mixin: () => (serviceName ? { svc: serviceName } : {}),
    hooks: {
      logMethod(this: Logger, args: unknown[], method: (...a: unknown[]) => void) {
        return method.apply(this, args.map((a) => (typeof a === 'string' ? scrubSecrets(a) : a)));
      },
    },
  };
  return (destination ? pino(opts as any, destination) : pino(opts as any)) as Logger;
}

export const logger = createLogger();

export function createLoggerWithContext(context: Record<string, any>) {
  return logger.child(context);
}
