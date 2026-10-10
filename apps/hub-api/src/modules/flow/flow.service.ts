import { Injectable, NotFoundException } from '@nestjs/common';
import { ORPHAN_MIN_AGE_SECONDS, PrismaService } from '@hub/database';
import { RETRY_TIERS } from '@hub/messaging';
import { buildEventFlow, EventFlowInput, FlowDeliveryInput, providerLabel } from './flow-lib';
import { flowRepoFor, FlowScopedRepository } from './flow.repository';

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Event id là ULID (26 ký tự Crockford) — chặn chuỗi lạ trước khi chạm DB. */
const EVENT_ID_RE = /^[0-9A-Za-z_-]{1,36}$/;

export const RETRY_TIER_TTLS_MS = RETRY_TIERS.map((t) => t.ttlMs);

type EventRow = NonNullable<Awaited<ReturnType<FlowScopedRepository['findEventForFlow']>>>;

export function toDeliveryInputs(event: EventRow): FlowDeliveryInput[] {
  return event.deliveries.map((d) => ({
    id: d.id,
    attemptGeneration: d.attemptGeneration,
    status: d.status,
    attemptCount: d.attemptCount,
    nextAttemptAt: d.nextAttemptAt,
    lastError: d.lastError,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
    subscription: { id: d.subscription.id, name: d.subscription.name, eventTypes: d.subscription.eventTypes },
    destination: {
      id: d.subscription.destination.id,
      name: d.subscription.destination.name,
      type: d.subscription.destination.type,
      circuitState: d.subscription.destination.circuitState,
      rateLimitRps: d.subscription.destination.rateLimitRps,
    },
    attempts: d.attempts.map((a) => ({
      attemptNo: a.attemptNo,
      responseStatus: a.responseStatus,
      durationMs: a.durationMs,
      error: a.error,
      responseBody: a.responseBody,
      requestBody: a.requestBody ?? undefined,
      createdAt: a.createdAt,
    })),
  }));
}

/** PrismaService do AppModule sở hữu (một client/tiến trình) — module flow mượn lại, không tạo client thứ hai. */
export type PrismaRef = PrismaService | (() => PrismaService);

@Injectable()
export class FlowService {
  constructor(private readonly prismaRef: PrismaRef) {}

  get prisma(): PrismaService {
    return typeof this.prismaRef === 'function' ? this.prismaRef() : this.prismaRef;
  }

  repo(tenantId: string): FlowScopedRepository {
    return flowRepoFor(this.prisma, tenantId);
  }

  /**
   * `GET /flow/events/:id` — `:id` là event id HOẶC raw_event id. Raw REJECTED/mồ côi không có event:
   * hành trình dừng ở `verified`/`normalized`. Không thuộc tenant → 404 (không lộ sự tồn tại).
   */
  async getEventFlow(tenantId: string, id: string, now = new Date()) {
    const repo = this.repo(tenantId);
    let event: EventRow | null = null;
    let raw = null as Awaited<ReturnType<FlowScopedRepository['findRawEventForFlow']>>;

    if (UUID_RE.test(id)) {
      raw = await repo.findRawEventForFlow(id);
      if (raw) event = await repo.findEventForFlow({ rawEventId: raw.id });
    }
    if (!raw && EVENT_ID_RE.test(id)) {
      event = await repo.findEventForFlow({ id });
      if (event?.rawEventId) raw = await repo.findRawEventForFlow(event.rawEventId);
    }
    if (!raw && !event) throw new NotFoundException('Hành trình không tồn tại');

    const skipped = event ? await repo.findInactiveSubscriptionsMatching(event.type) : [];
    const input: EventFlowInput = {
      raw: raw
        ? {
            id: raw.id,
            status: raw.status,
            signatureValid: raw.signatureValid,
            receivedAt: raw.receivedAt,
            provider: raw.provider,
            sourceId: raw.sourceId,
            sourceName: raw.sourceName,
            contentType: raw.contentType,
            idempotencyKey: raw.idempotencyKey,
            headers: raw.headers,
            body: raw.body,
            bodyBytes: raw.bodyBytes,
            normalizeProcessed: raw.normalizeProcessed,
          }
        : null,
      event: event
        ? {
            id: event.id,
            type: event.type,
            source: event.source,
            subject: event.subject,
            normalized: event.normalized,
            origin: event.origin,
            correlationId: event.correlationId,
            receivedAt: event.receivedAt,
            occurredAt: event.occurredAt,
            data: event.data,
          }
        : null,
      deliveries: event ? toDeliveryInputs(event) : [],
      skippedSubscriptions: skipped.map((s) => ({ ...s, reason: 'subscription_inactive' as const })),
      now,
      retryTierTtlsMs: RETRY_TIER_TTLS_MS,
      orphanMinAgeSeconds: ORPHAN_MIN_AGE_SECONDS,
    };
    const flow = buildEventFlow(input);

    return {
      id,
      event: event
        ? {
            id: event.id,
            type: event.type,
            source: event.source,
            subject: event.subject,
            normalized: event.normalized,
            origin: event.origin,
            correlationId: event.correlationId,
            occurredAt: event.occurredAt,
            receivedAt: event.receivedAt,
          }
        : null,
      raw: raw
        ? {
            id: raw.id,
            status: raw.status,
            provider: raw.provider,
            providerLabel: providerLabel(raw.provider),
            sourceId: raw.sourceId,
            sourceName: raw.sourceName,
            receivedAt: raw.receivedAt,
          }
        : null,
      ...flow,
    };
  }
}
