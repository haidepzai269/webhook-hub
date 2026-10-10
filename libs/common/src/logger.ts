import pino from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  formatters: {
    level: (label) => ({ level: label }),
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  // ADR-051: lưới an toàn — hiện không log nào in headers, nhưng nếu sau này có ai log `headers`/`req`
  // thì key SePay (Authorization: Apikey ...) và cookie vẫn không ra log.
  redact: {
    paths: [
      'headers.authorization',
      'headers.cookie',
      'headers["x-api-key"]',
      'headers["proxy-authorization"]',
      'req.headers.authorization',
      'req.headers.cookie',
      'req.headers["x-api-key"]',
      'req.headers["proxy-authorization"]',
    ],
    censor: '***',
  },
});

export function createLoggerWithContext(context: Record<string, any>) {
  return logger.child(context);
}
