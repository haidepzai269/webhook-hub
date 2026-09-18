export type ProviderType = 'payos' | 'sepay' | 'github';

export type RawEventStatus = 'ACCEPTED' | 'REJECTED' | 'DUPLICATE';

export type EventOrigin = 'webhook' | 'reconciliation' | 'replay' | 'derived';

export type DestinationType = 'webhook' | 'telegram' | 'discord';

export type DeliveryStatus = 'PENDING' | 'DELIVERING' | 'RETRYING' | 'SUCCEEDED' | 'DEAD';

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface RawWebhookRequest {
  provider: ProviderType;
  sourceKey: string;
  headers: Record<string, string | string[] | undefined>;
  rawBody: Buffer;
  body: any;
  contentType?: string;
  ip?: string;
}

export interface IngestResult {
  accepted: boolean;
  status: number;
  message?: string;
  rawEventId?: string;
  idempotencyKey?: string;
  isDuplicate?: boolean;
}

export interface NormalizedEvent {
  id: string; // ULID
  tenantId: string;
  type: string; // vd: repo.push, payment.succeeded, bank.transfer.received
  source: ProviderType;
  sourceId: string;
  subject?: string;
  data: Record<string, any>;
  occurredAt: string; // ISO string
  receivedAt: string; // ISO string
  correlationId: string;
  rawEventId?: string;
  parentEventId?: string;
  origin: EventOrigin;
}

export interface DeliveryMessage {
  deliveryId: string;
  tenantId: string;
  eventId: string;
  subscriptionId: string;
  destinationId: string;
  destinationType: DestinationType;
  config: Record<string, any>;
  signingSecret?: string;
  event: NormalizedEvent;
  attemptCount: number;
  attemptGeneration: number;
  correlationId: string;
}

export interface OutboxPayload {
  rawEventId: string;
  sourceId: string;
  tenantId: string;
  provider: ProviderType;
  correlationId: string;
}
