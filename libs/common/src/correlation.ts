import { randomUUID } from 'crypto';

export function generateCorrelationId(): string {
  return randomUUID();
}

export const CORRELATION_HEADER = 'x-correlation-id';
