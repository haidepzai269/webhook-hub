import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ORPHAN_MIN_AGE_SECONDS, PrismaService } from '@hub/database';
import { RETRY_TIERS } from '@hub/messaging';
import {
  buildEventFlow,
  classifySkippedSubscriptions,
  EventFlowInput,
  EXECUTION_STATUSES,
  FlowDeliveryInput,
  FlowTopology,
  providerLabel,
  TOPOLOGY_WINDOWS,
  TopologyWindow,
} from './flow-lib';
import { ExecutionFilter, flowRepoFor, FlowScopedRepository } from './flow.repository';
import { assembleTopology } from './topology.assemble';
import { assertFlatQuery, badParam, isRealUtcInstant, parseEnumParam, parseTimeRange } from '../api/list-params';

export const EXECUTIONS_DEFAULT_LIMIT = 50;
export const EXECUTIONS_MAX_LIMIT = 50;

export interface ExecutionQuery {
  status?: string;
  source?: string;
  destination?: string;
  type?: string;
  /** ADR-163: `payos`, `github`… (provider của source / `api`). */
  provider?: string;
  /** ADR-163: `hide` = bỏ request kiểm tra kết nối (events.probe, ADR-159). */
  probes?: string;
  from?: string;
  to?: string;
  /** ADR-163: tìm theo tiền tố event id (ULID) hoặc raw_event id (uuid), ≥ 4 ký tự. */
  q?: string;
  cursor?: string;
  limit?: string;
}

export function encodeCursor(at: string, key: string): string {
  return Buffer.from(JSON.stringify([at, key])).toString('base64url');
}

export function decodeCursor(c: string): { at: string; key: string } {
  try {
    const [at, key] = JSON.parse(Buffer.from(c, 'base64url').toString('utf8'));
    if (typeof at !== 'string' || typeof key !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}$/.test(at) || !isRealUtcInstant(at) || key.length > 64) throw new Error();
    return { at, key };
  } catch {
    throw badParam('cursor', 'cursor không hợp lệ — dùng đúng nextCursor của trang trước');
  }
}

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
      verification: d.subscription.destination.verification,
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

  /** `GET /flow/executions` — danh sách hành trình, cursor, tối đa 50; summary dựng bằng CÙNG `buildEventFlow`. */
  async listExecutions(tenantId: string, q: ExecutionQuery, now = new Date()) {
    assertFlatQuery(q); // ?a=1&a=2 / ?a[b]=1 -> 400, không 500
    const limit = Math.min(Math.max(parseInt(q.limit ?? '', 10) || EXECUTIONS_DEFAULT_LIMIT, 1), EXECUTIONS_MAX_LIMIT);
    if (q.status && !(EXECUTION_STATUSES as readonly string[]).includes(q.status)) {
      throw new BadRequestException(`status phải là một trong ${EXECUTION_STATUSES.join(', ')}`);
    }
    for (const [k, v] of [['source', q.source], ['destination', q.destination]] as const) {
      if (v && !UUID_RE.test(v)) throw new BadRequestException(`${k} phải là UUID`);
    }
    let typeLike: string | undefined;
    if (q.type && q.type !== '*') {
      if (!/^[a-z0-9_]+(\.[a-z0-9_]+)*(\.\*)?$/.test(q.type)) throw new BadRequestException('type: vd payment.received, payment.*');
      typeLike = q.type.replace(/_/g, '\\_').replace(/\.\*$/, '.%');
    }
    if (q.provider && !/^[a-z0-9_-]{1,32}$/.test(q.provider)) throw badParam('provider', 'provider: chữ thường/số, vd payos, github');
    const probes = parseEnumParam(q.probes, 'probes', ['hide', 'show'] as const);
    const range = parseTimeRange(q.from, q.to);
    const idPrefix = q.q?.trim() || undefined;
    if (idPrefix && !/^[0-9A-Za-z_-]{4,36}$/.test(idPrefix)) {
      throw badParam('q', 'q: id sự kiện (ULID) hoặc id request (uuid), ít nhất 4 ký tự');
    }
    const cursor = q.cursor ? decodeCursor(q.cursor) : undefined;
    const rows = await this.repo(tenantId).findExecutions({
      status: q.status as ExecutionFilter['status'],
      sourceId: q.source || undefined,
      destinationId: q.destination || undefined,
      typeLike,
      provider: q.provider || undefined,
      hideProbes: probes === 'hide',
      from: range.from,
      to: range.to,
      idPrefix,
      cursor,
      limit: limit + 1,
      orphanMinAgeSeconds: ORPHAN_MIN_AGE_SECONDS,
    });
    const page = rows.slice(0, limit);
    const items = page.map((r) => {
      const f = buildEventFlow({
        raw: r.rawId
          ? {
              id: r.rawId,
              status: r.rawStatus ?? 'ACCEPTED',
              signatureValid: r.signatureValid,
              receivedAt: r.at,
              provider: r.provider,
              sourceId: r.sourceId ?? '',
              sourceName: r.sourceName ?? '',
              normalizeProcessed: r.processed,
            }
          : null,
        event: r.eventId
          ? {
              id: r.eventId,
              type: r.type ?? '',
              source: r.provider,
              subject: r.subject,
              normalized: r.normalized ?? true,
              origin: r.origin ?? 'webhook',
              correlationId: '',
              receivedAt: r.eventAt ?? r.at,
              // Cờ chung ADR-159 — cùng lý do routed (provider_probe) như màn chi tiết.
              probe: r.probe === true,
            }
          : null,
        deliveries: r.deliveries as FlowDeliveryInput[],
        now,
        retryTierTtlsMs: RETRY_TIER_TTLS_MS,
        orphanMinAgeSeconds: ORPHAN_MIN_AGE_SECONDS,
      });
      return {
        id: r.eventId ?? r.rawId,
        eventId: r.eventId,
        rawEventId: r.rawId,
        receivedAt: r.at,
        provider: r.provider,
        providerLabel: providerLabel(r.provider),
        sourceId: r.sourceId,
        sourceName: r.sourceName,
        type: r.type,
        subject: r.subject,
        /** events.probe (ADR-159): request kiểm tra kết nối do ADAPTER đánh dấu — UI không phải đoán theo tên kiểu. */
        probe: r.probe === true,
        status: f.executionStatus,
        summary: f.summary,
        failedAt: f.failedAt,
      };
    });
    const last = page[page.length - 1];
    return { items, nextCursor: rows.length > limit && last ? encodeCursor(last.cursorAt, last.cursorKey) : null };
  }

  /** `GET /flow/topology` — bản đồ luồng; health của mọi node/cạnh tính bằng `healthOf` ở server. */
  async getTopology(tenantId: string, window: string | undefined): Promise<FlowTopology> {
    const w = (window ?? '15m') as TopologyWindow;
    if (!TOPOLOGY_WINDOWS[w]) throw new BadRequestException("window phải là '15m', '1h' hoặc '24h'");
    const since = new Date(Date.now() - TOPOLOGY_WINDOWS[w].seconds * 1000);
    const repo = this.repo(tenantId);
    const [cfg, raws, norm, bySub, attempts, backlog] = await Promise.all([
      repo.findTopologyConfig(),
      repo.countRawBySource(since),
      repo.normalizeStats(since, ORPHAN_MIN_AGE_SECONDS),
      repo.countDeliveriesBySubscription(since),
      repo.attemptStatsByDestination(since),
      repo.backlogByDestination(since),
    ]);
    return assembleTopology(w, cfg, raws, norm, bySub, attempts, backlog);
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

    // events.created_at = lúc INSERT (normalize + route cùng transaction) — mốc định tuyến thật (S7, R-6).
    const candidates = event ? await repo.findSubscriptionsMatching(event.type, event.createdAt ?? event.receivedAt) : [];
    const skipped = classifySkippedSubscriptions(
      // ADR-161: đích "Ngắt" = subscription không nhận (lý do hiển thị như subscription tắt).
      candidates.map((c) => ({ ...c, isActive: c.isActive && c.destination?.isActive !== false, destinationVerification: c.destination?.verification ?? null })),
      (event?.deliveries ?? []).map((d) => d.subscriptionId),
      // events.source_id (S5) — có cả với event không còn raw_event.
      raw?.sourceId ?? event?.sourceId ?? null,
    );
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
            // Cờ chung ADR-159 — lõi không biết provider nào (L-A1: lý do provider_probe thay no_subscription).
            probe: event.probe === true,
          }
        : null,
      deliveries: event ? toDeliveryInputs(event) : [],
      skippedSubscriptions: skipped,
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
