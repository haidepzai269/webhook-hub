import pino from 'pino';
import { LOG_REDACT_OPTIONS, scrubSecrets } from './auth/redact';

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  formatters: {
    level: (label) => ({ level: label }),
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  // ADR-051 + SPEC-auth UA22: lưới an toàn — header nhạy cảm, khoá `password`/`token`… bị che theo TÊN KHOÁ;
  // chuỗi thông điệp được quét thêm (`hk_live_…`, cookie phiên, Bearer) vì bí mật có thể nằm giữa câu.
  redact: LOG_REDACT_OPTIONS,
  hooks: {
    logMethod(args, method) {
      return method.apply(this, args.map((a) => (typeof a === 'string' ? scrubSecrets(a) : a)) as Parameters<typeof method>);
    },
  },
});

export function createLoggerWithContext(context: Record<string, any>) {
  return logger.child(context);
}
