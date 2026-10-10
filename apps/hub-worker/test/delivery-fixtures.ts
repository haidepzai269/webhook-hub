import { aesGcmEncrypt } from '@hub/crypto';

/** Fixture dùng chung cho các spec DeliveryConsumer (không phải spec — jest bỏ qua). */
export const TEST_MASTER_KEY = 'test-master-key-at-least-32-characters!!';
export const TENANT_ID = 'tenant-1';
export const DELIVERY_ID = 'delivery-1';
/** Config THẬT nằm trong DB (mã hoá). Message kiểu cũ có thể mang config khác — worker phải dùng cái này. */
export const DB_CONFIG = { url: 'https://db.example.com/hook' };
export const DB_SIGNING_SECRET = 'db-signing-secret';

export function ensureMasterKey() {
  process.env.MASTER_KEY = TEST_MASTER_KEY;
}

/** Message kiểu CŨ (trước S1-1): còn config/signingSecret/event — dùng để kiểm tương thích ngược. */
export function buildLegacyMsg(overrides: Record<string, any> = {}) {
  return {
    deliveryId: DELIVERY_ID,
    tenantId: TENANT_ID,
    eventId: 'evt-1',
    subscriptionId: 'sub-1',
    destinationId: 'dest-1',
    destinationType: 'webhook',
    config: { url: 'https://STALE-from-message.example.com/hook' },
    signingSecret: 'STALE-secret-from-message',
    event: { id: 'evt-1', type: 'payment.received' },
    attemptCount: 0,
    attemptGeneration: 1,
    correlationId: 'corr-1',
    rateLimitRps: 0,
    ...overrides,
  };
}

export function buildSlimMsg(overrides: Record<string, any> = {}) {
  return { deliveryId: DELIVERY_ID, tenantId: TENANT_ID, attemptGeneration: 1, attemptCount: 0, correlationId: 'corr-1', ...overrides };
}

export function toAmqpMsg(body: unknown) {
  return {
    content: Buffer.from(JSON.stringify(body)),
    properties: { headers: { 'x-correlation-id': 'corr-1' } },
  } as any;
}

export function buildChannel() {
  return { ack: jest.fn(), nack: jest.fn(), sendToQueue: jest.fn(), publish: jest.fn() } as any;
}

/** Dòng trả về từ `repo.findDeliveryForSend` (delivery + event + subscription + destination). */
export function buildDeliveryRow(dest: { rateLimitRps?: number; signingSecret?: string | null; circuitState?: string } = {}) {
  ensureMasterKey();
  const now = new Date();
  return {
    id: DELIVERY_ID,
    tenantId: TENANT_ID,
    attemptGeneration: 1,
    attemptCount: 0,
    status: 'PENDING',
    event: {
      id: 'evt-1',
      tenantId: TENANT_ID,
      type: 'payment.received',
      source: 'payos',
      subject: null,
      data: {},
      occurredAt: now,
      receivedAt: now,
      correlationId: 'corr-1',
      rawEventId: null,
      parentEventId: null,
      origin: 'webhook',
      rawEvent: null,
    },
    subscription: {
      id: 'sub-1',
      template: '',
      destination: {
        id: 'dest-1',
        type: 'webhook',
        configEncrypted: aesGcmEncrypt(JSON.stringify(DB_CONFIG), TEST_MASTER_KEY),
        signingSecretEncrypted:
          dest.signingSecret === null ? null : aesGcmEncrypt(dest.signingSecret ?? DB_SIGNING_SECRET, TEST_MASTER_KEY),
        rateLimitRps: dest.rateLimitRps ?? 0,
        circuitState: dest.circuitState ?? 'CLOSED',
      },
    },
  };
}

/** CircuitBreakerService giả theo API S2-1 (getState trả view, probe, record* nhận target + view). */
export function buildFakeCircuitBreaker(state: 'CLOSED' | 'OPEN' | 'HALF_OPEN' = 'CLOSED', opts: { probe?: boolean } = {}) {
  return {
    getState: jest.fn().mockResolvedValue({ state, failures: state === 'CLOSED' ? 0 : 5 }),
    syncObserved: jest.fn().mockResolvedValue(undefined),
    // Lua giành probe trả token (ADR-054) hoặc null.
    tryAcquireProbe: jest.fn().mockResolvedValue((opts.probe ?? true) ? 'probe-token' : null),
    releaseProbe: jest.fn().mockResolvedValue(undefined),
    checkThrottle: jest.fn().mockResolvedValue(true),
    recordSuccess: jest.fn().mockResolvedValue('CLOSED'),
    recordFailure: jest.fn().mockResolvedValue({ state: 'CLOSED', failures: 1 }),
  } as any;
}
