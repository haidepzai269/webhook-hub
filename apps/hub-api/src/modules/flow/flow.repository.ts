import { eventTypeCandidates } from '@hub/common';
import { TenantScopedRepository } from '@hub/database';
import { Prisma, PrismaClient } from '@prisma/client';

type PrismaClientOrTx = PrismaClient | Prisma.TransactionClient;

/**
 * Truy vấn CHỈ ĐỌC của Event Flow (SPEC-event-flow-ui §3).
 *
 * Là MỘT `TenantScopedRepository` (kế thừa: constructor đòi tenantId, BB-5) — viết ở module `flow`
 * thay vì sửa `libs/database/src/tenant-scoped.repository.ts` vì agent đa service đang sửa file đó
 * (ADR nháp EF-2). Mọi câu ở đây lọc `tenant_id = this.tenantId` (hoặc `sources.tenant_id` với
 * raw_events, bảng không có cột tenant). Lúc merge có thể chuyển nguyên các hàm này vào repo gốc.
 */
export class FlowScopedRepository extends TenantScopedRepository {
  constructor(
    private readonly db: PrismaClientOrTx,
    tenantId: string,
  ) {
    super(db, tenantId);
  }

  /** Raw event theo id, scope qua source.tenantId. KHÔNG nạp `body_raw` (chỉ độ dài). */
  async findRawEventForFlow(id: string): Promise<FlowRawRow | null> {
    const rows = await this.db.$queryRaw<FlowRawRow[]>(Prisma.sql`
      SELECT r.id, r.status::text AS status, r.signature_valid AS "signatureValid", r.received_at AS "receivedAt",
             r.content_type AS "contentType", r.idempotency_key AS "idempotencyKey", r.headers, r.body,
             octet_length(r.body_raw) AS "bodyBytes",
             s.id AS "sourceId", s.name AS "sourceName", s.provider::text AS provider,
             EXISTS (SELECT 1 FROM hub.processed_messages p
                     WHERE p.consumer = 'normalize' AND p.message_id = r.id::text) AS "normalizeProcessed"
      FROM hub.raw_events r JOIN hub.sources s ON s.id = r.source_id
      WHERE r.id = ${id}::uuid AND s.tenant_id = ${this.tenantId}::uuid
    `);
    return rows[0] ?? null;
  }

  /** Event + mọi delivery (mọi generation) + attempt + subscription + đích (chỉ trường an toàn). */
  async findEventForFlow(where: { id: string } | { rawEventId: string }) {
    return this.db.event.findFirst({
      where: { ...where, tenantId: this.tenantId },
      include: {
        deliveries: {
          where: { tenantId: this.tenantId },
          include: {
            attempts: { orderBy: { attemptNo: 'asc' } },
            subscription: {
              select: {
                id: true,
                name: true,
                eventTypes: true,
                // KHÔNG đọc configEncrypted / signingSecretEncrypted (SPEC §3: secret không bao giờ ra UI).
                destination: { select: { id: true, name: true, type: true, circuitState: true, rateLimitRps: true } },
              },
            },
          },
        },
      },
    });
  }

  /**
   * Danh sách hành trình (V2). MỘT câu SQL: raw_events (scope qua source) LEFT JOIN events, cộng event
   * không có raw; mỗi dòng kèm các delivery generation MỚI NHẤT (+ attempt cuối) qua LATERAL — để
   * `buildEventFlow` dựng đúng summary như màn chi tiết. Bộ lọc trạng thái viết bằng SQL theo ĐÚNG
   * định nghĩa của `deriveExecutionStatus` (test DB đối chiếu hai bên).
   */
  async findExecutions(f: ExecutionFilter): Promise<ExecutionRow[]> {
    const t = this.tenantId;
    const rawConds: Prisma.Sql[] = [];
    const evConds: Prisma.Sql[] = [];
    if (f.sourceId) {
      rawConds.push(Prisma.sql`AND source_id = ${f.sourceId}::uuid`);
      evConds.push(Prisma.sql`AND false`); // event không có raw thì không thuộc source nào
    }
    if (f.typeLike) {
      rawConds.push(Prisma.sql`AND type LIKE ${f.typeLike}`);
      evConds.push(Prisma.sql`AND type LIKE ${f.typeLike}`);
    }
    if (f.cursor) {
      const c = Prisma.sql`AND (x_at, x_key) < (${f.cursor.at}::timestamp AT TIME ZONE 'UTC', ${f.cursor.key})`;
      rawConds.push(c);
      evConds.push(c);
    }
    const orphanSecs = f.orphanMinAgeSeconds;
    const status: Record<string, Prisma.Sql> = {
      rejected: Prisma.sql`j.raw_status = 'REJECTED'`,
      failed: Prisma.sql`j.raw_status IS DISTINCT FROM 'REJECTED' AND (
          COALESCE(dl.n_dead, 0) > 0
          OR (j.event_id IS NULL AND j.raw_status = 'ACCEPTED' AND NOT j.processed
              AND j.x_at < now() - make_interval(secs => ${orphanSecs}::double precision)))`,
      in_progress: Prisma.sql`j.raw_status IS DISTINCT FROM 'REJECTED' AND COALESCE(dl.n_dead, 0) = 0 AND (
          COALESCE(dl.n_active, 0) > 0
          OR (j.event_id IS NULL AND j.raw_status = 'ACCEPTED' AND NOT j.processed
              AND j.x_at >= now() - make_interval(secs => ${orphanSecs}::double precision)))`,
      succeeded: Prisma.sql`j.raw_status IS DISTINCT FROM 'REJECTED' AND COALESCE(dl.n_dead, 0) = 0
          AND COALESCE(dl.n_active, 0) = 0 AND (j.event_id IS NOT NULL OR j.processed)`,
    };
    const statusCond = f.status ? Prisma.sql`AND ${status[f.status]}` : Prisma.empty;
    // Lọc sơ bộ RẺ (index deliveries(event_id, subscription_id, generation)) trước LATERAL — để trạng thái
    // hiếm (vd 'succeeded' khi một đích chết hẳn) không phải dựng JSON cho cả 10k dòng. Điều kiện chính
    // xác vẫn là statusCond ở ngoài.
    const latestDelivery = (statusSql: Prisma.Sql) => Prisma.sql`EXISTS (
        SELECT 1 FROM hub.deliveries d WHERE d.event_id = j.event_id AND d.tenant_id = ${t}::uuid AND ${statusSql}
          AND NOT EXISTS (SELECT 1 FROM hub.deliveries n WHERE n.event_id = d.event_id AND n.subscription_id = d.subscription_id
                          AND n.attempt_generation > d.attempt_generation))`;
    const pre: Record<string, Prisma.Sql> = {
      rejected: Prisma.sql`j.raw_status = 'REJECTED'`,
      failed: Prisma.sql`j.raw_status IS DISTINCT FROM 'REJECTED' AND (j.event_id IS NULL OR ${latestDelivery(Prisma.sql`d.status = 'DEAD'`)})`,
      in_progress: Prisma.sql`j.raw_status IS DISTINCT FROM 'REJECTED'`,
      succeeded: Prisma.sql`j.raw_status IS DISTINCT FROM 'REJECTED' AND NOT ${latestDelivery(Prisma.sql`d.status <> 'SUCCEEDED'`)}`,
    };
    const preCond = f.status ? pre[f.status] : Prisma.sql`true`;
    const destCond = f.destinationId
      ? Prisma.sql`AND EXISTS (SELECT 1 FROM hub.deliveries d2 JOIN hub.subscriptions s2 ON s2.id = d2.subscription_id
                              WHERE d2.event_id = j.event_id AND d2.tenant_id = ${t}::uuid AND s2.destination_id = ${f.destinationId}::uuid)`
      : Prisma.empty;

    return this.db.$queryRaw<ExecutionRow[]>(Prisma.sql`
      WITH j AS (
        SELECT * FROM (
          SELECT r.received_at AS x_at, r.id::text AS x_key, r.id AS raw_id, r.status::text AS raw_status,
                 r.signature_valid, s.id AS source_id, s.name AS source_name, s.provider::text AS provider,
                 EXISTS (SELECT 1 FROM hub.processed_messages p WHERE p.consumer = 'normalize' AND p.message_id = r.id::text) AS processed,
                 e.id AS event_id, e.type, e.subject, e.normalized, e.origin::text AS origin, e.received_at AS event_at
          FROM hub.raw_events r
          JOIN hub.sources s ON s.id = r.source_id AND s.tenant_id = ${t}::uuid
          LEFT JOIN hub.events e ON e.raw_event_id = r.id AND e.tenant_id = ${t}::uuid
        ) a WHERE true ${rawConds.length ? Prisma.join(rawConds, ' ') : Prisma.empty}
        UNION ALL
        SELECT * FROM (
          SELECT e.received_at AS x_at, e.id::text AS x_key, NULL::uuid AS raw_id, NULL::text AS raw_status, true AS signature_valid,
                 NULL::uuid AS source_id, NULL::varchar AS source_name, e.source::text AS provider,
                 true AS processed, e.id AS event_id, e.type, e.subject, e.normalized, e.origin::text AS origin, e.received_at AS event_at
          FROM hub.events e WHERE e.tenant_id = ${t}::uuid AND e.raw_event_id IS NULL
        ) e WHERE true ${evConds.length ? Prisma.join(evConds, ' ') : Prisma.empty}
      )
      SELECT to_char(j.x_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') AS "cursorAt", j.x_key AS "cursorKey",
             j.x_at AS "at", j.raw_id AS "rawId", j.raw_status AS "rawStatus", j.signature_valid AS "signatureValid",
             j.source_id AS "sourceId", j.source_name AS "sourceName", j.provider, j.processed,
             j.event_id AS "eventId", j.type, j.subject, j.normalized, j.origin, j.event_at AS "eventAt",
             COALESCE(dl.deliveries, '[]'::json) AS deliveries
      -- Sắp + đánh số TRƯỚC khi LATERAL: nested loop giữ thứ tự nên LIMIT dừng sớm, không tính
      -- LATERAL cho cả 10k dòng rồi mới sắp (đo: 800ms → xem ADR-DRAFT EF-6).
      FROM (SELECT * FROM j WHERE ${preCond} ORDER BY j.x_at DESC, j.x_key DESC) j
      LEFT JOIN LATERAL (
        SELECT json_agg(json_build_object(
                 'id', d.id, 'attemptGeneration', d.attempt_generation, 'status', d.status, 'attemptCount', d.attempt_count,
                 'nextAttemptAt', d.next_attempt_at, 'lastError', d.last_error, 'createdAt', d.created_at, 'updatedAt', d.updated_at,
                 'subscription', json_build_object('id', sub.id, 'name', sub.name, 'eventTypes', sub.event_types),
                 'destination', json_build_object('id', dst.id, 'name', dst.name, 'type', dst.type, 'circuitState', dst.circuit_state, 'rateLimitRps', dst.rate_limit_rps),
                 'attempts', CASE WHEN la.attempt_no IS NULL THEN '[]'::json ELSE json_build_array(json_build_object(
                    'attemptNo', la.attempt_no, 'responseStatus', la.response_status, 'durationMs', la.duration_ms,
                    'error', la.error, 'createdAt', la.created_at)) END
               )) AS deliveries,
               count(*) FILTER (WHERE d.status = 'DEAD') AS n_dead,
               count(*) FILTER (WHERE d.status IN ('PENDING', 'DELIVERING', 'RETRYING')) AS n_active
        FROM (SELECT DISTINCT ON (dd.subscription_id) dd.*
              FROM hub.deliveries dd WHERE dd.event_id = j.event_id AND dd.tenant_id = ${t}::uuid
              ORDER BY dd.subscription_id, dd.attempt_generation DESC) d
        JOIN hub.subscriptions sub ON sub.id = d.subscription_id AND sub.tenant_id = ${t}::uuid
        JOIN hub.destinations dst ON dst.id = sub.destination_id AND dst.tenant_id = ${t}::uuid
        LEFT JOIN LATERAL (SELECT a.* FROM hub.delivery_attempts a WHERE a.delivery_id = d.id ORDER BY a.attempt_no DESC LIMIT 1) la ON true
      ) dl ON j.event_id IS NOT NULL
      WHERE true ${statusCond} ${destCond}
      ORDER BY j.x_at DESC, j.x_key DESC
      LIMIT ${f.limit}
    `);
  }

  // --- Topology (V3): vài câu GROUP BY có index, không N+1, không Redis ---

  async countRawBySource(since: Date) {
    return this.db.$queryRaw<{ sourceId: string; status: string; n: number }[]>(Prisma.sql`
      SELECT r.source_id AS "sourceId", r.status::text AS status, count(*)::int AS n
      FROM hub.raw_events r JOIN hub.sources s ON s.id = r.source_id
      WHERE s.tenant_id = ${this.tenantId}::uuid AND r.received_at >= ${since}
      GROUP BY 1, 2`);
  }

  async normalizeStats(since: Date, orphanMinAgeSeconds: number) {
    const [ev] = await this.db.$queryRaw<{ events: number; unmapped: number; p50: number | null; p95: number | null }[]>(Prisma.sql`
      SELECT count(*)::int AS events, count(*) FILTER (WHERE NOT e.normalized)::int AS unmapped,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM fd.at - r.received_at) * 1000) AS p50,
             percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM fd.at - r.received_at) * 1000) AS p95
      -- events.received_at là bản sao giờ nhận raw → độ trễ normalize đo tới delivery đầu (cùng tx normalize+route).
      FROM hub.events e LEFT JOIN hub.raw_events r ON r.id = e.raw_event_id
      LEFT JOIN LATERAL (SELECT min(d.created_at) AS at FROM hub.deliveries d WHERE d.event_id = e.id AND d.tenant_id = e.tenant_id) fd ON true
      WHERE e.tenant_id = ${this.tenantId}::uuid AND e.received_at >= ${since}`);
    const [orph] = await this.db.$queryRaw<{ orphans: number; pending: number }[]>(Prisma.sql`
      SELECT count(*) FILTER (WHERE r.received_at < now() - make_interval(secs => ${orphanMinAgeSeconds}::double precision))::int AS orphans,
             count(*) FILTER (WHERE r.received_at >= now() - make_interval(secs => ${orphanMinAgeSeconds}::double precision))::int AS pending
      FROM hub.raw_events r JOIN hub.sources s ON s.id = r.source_id
      WHERE s.tenant_id = ${this.tenantId}::uuid AND r.status = 'ACCEPTED' AND r.received_at >= ${since}
        AND NOT EXISTS (SELECT 1 FROM hub.events e WHERE e.raw_event_id = r.id)
        AND NOT EXISTS (SELECT 1 FROM hub.processed_messages p WHERE p.consumer = 'normalize' AND p.message_id = r.id::text)`);
    return { ...ev, ...orph };
  }

  /** Delivery tạo trong cửa sổ, theo subscription + trạng thái HIỆN TẠI (index tenant_id, created_at). */
  async countDeliveriesBySubscription(since: Date) {
    return this.db.$queryRaw<{ subscriptionId: string; total: number; succeeded: number; dead: number; retrying: number; active: number }[]>(Prisma.sql`
      SELECT d.subscription_id AS "subscriptionId", count(*)::int AS total,
             count(*) FILTER (WHERE d.status = 'SUCCEEDED')::int AS succeeded,
             count(*) FILTER (WHERE d.status = 'DEAD')::int AS dead,
             count(*) FILTER (WHERE d.status = 'RETRYING')::int AS retrying,
             count(*) FILTER (WHERE d.status IN ('PENDING', 'DELIVERING'))::int AS active
      FROM hub.deliveries d
      WHERE d.tenant_id = ${this.tenantId}::uuid AND d.created_at >= ${since}
      GROUP BY 1`);
  }

  /** p95 thời gian gửi theo đích, từ attempt trong cửa sổ. */
  async attemptStatsByDestination(since: Date) {
    return this.db.$queryRaw<{ destinationId: string; attempts: number; p95: number | null }[]>(Prisma.sql`
      SELECT sub.destination_id AS "destinationId", count(*)::int AS attempts,
             percentile_cont(0.95) WITHIN GROUP (ORDER BY a.duration_ms) AS p95
      FROM hub.delivery_attempts a
      JOIN hub.deliveries d ON d.id = a.delivery_id
      JOIN hub.subscriptions sub ON sub.id = d.subscription_id
      WHERE d.tenant_id = ${this.tenantId}::uuid AND a.created_at >= ${since}
      GROUP BY 1`);
  }

  /** Hiện tại: RETRYING, DEAD trong DLQ (chưa bị replay) và DEAD mới trong cửa sổ, theo đích. */
  async backlogByDestination(since: Date) {
    return this.db.$queryRaw<{ destinationId: string; retrying: number; dead: number; deadInWindow: number }[]>(Prisma.sql`
      SELECT sub.destination_id AS "destinationId",
             count(*) FILTER (WHERE d.status = 'RETRYING')::int AS retrying,
             count(*) FILTER (WHERE d.status = 'DEAD')::int AS dead,
             count(*) FILTER (WHERE d.status = 'DEAD' AND d.updated_at >= ${since})::int AS "deadInWindow"
      FROM hub.deliveries d JOIN hub.subscriptions sub ON sub.id = d.subscription_id
      WHERE d.tenant_id = ${this.tenantId}::uuid AND d.status IN ('RETRYING', 'DEAD')
        AND NOT EXISTS (SELECT 1 FROM hub.deliveries n WHERE n.tenant_id = d.tenant_id AND n.event_id = d.event_id
                        AND n.subscription_id = d.subscription_id AND n.attempt_generation > d.attempt_generation)
      GROUP BY 1`);
  }

  /** Cấu hình (không secret): source, subscription, đích. */
  async findTopologyConfig() {
    const [sources, subscriptions, destinations] = await Promise.all([
      this.db.source.findMany({
        where: { tenantId: this.tenantId },
        select: { id: true, name: true, provider: true, sourceKey: true, isActive: true },
        orderBy: { createdAt: 'asc' },
      }),
      this.db.subscription.findMany({
        where: { tenantId: this.tenantId },
        select: { id: true, name: true, eventTypes: true, isActive: true, destinationId: true },
        orderBy: { createdAt: 'asc' },
      }),
      this.db.destination.findMany({
        where: { tenantId: this.tenantId },
        select: { id: true, name: true, type: true, circuitState: true, rateLimitRps: true },
        orderBy: { createdAt: 'asc' },
      }),
    ]);
    return { sources, subscriptions, destinations };
  }

  /**
   * MỌI subscription khớp kiểu (bật lẫn tắt) — `classifySkippedSubscriptions` quyết định cái nào bị bỏ
   * qua và vì sao. CHỖ DUY NHẤT phải sửa khi đa service thêm `source_ids` / `destinations.verification`
   * (F7): thêm hai trường đó vào select dưới đây.
   */
  async findSubscriptionsMatching(eventType: string) {
    return this.db.subscription.findMany({
      where: { tenantId: this.tenantId, eventTypes: { hasSome: eventTypeCandidates(eventType) } },
      select: { id: true, name: true, eventTypes: true, isActive: true },
    });
  }
}

/**
 * Dựng repo flow từ `PrismaService`. `PrismaService.client` là private (BB-5: không ai gọi model trần),
 * nên lấy client mà `forTenant()` đã bọc — đúng client đó, không mở kết nối mới. Hết cần khi các hàm
 * trên được chuyển vào `TenantScopedRepository` lúc merge (ADR nháp EF-2).
 */
export function flowRepoFor(svc: { forTenant(tenantId: string): TenantScopedRepository }, tenantId: string): FlowScopedRepository {
  const base = svc.forTenant(tenantId) as unknown as { prisma: PrismaClientOrTx };
  return new FlowScopedRepository(base.prisma, tenantId);
}

export interface ExecutionFilter {
  status?: 'failed' | 'in_progress' | 'succeeded' | 'rejected';
  sourceId?: string;
  destinationId?: string;
  /** Mẫu LIKE đã thoát ký tự (vd `payment.%`). */
  typeLike?: string;
  cursor?: { at: string; key: string };
  limit: number;
  orphanMinAgeSeconds: number;
}

export interface ExecutionRow {
  cursorAt: string;
  cursorKey: string;
  at: Date;
  rawId: string | null;
  rawStatus: 'ACCEPTED' | 'REJECTED' | 'DUPLICATE' | null;
  signatureValid: boolean;
  sourceId: string | null;
  sourceName: string | null;
  provider: string;
  processed: boolean;
  eventId: string | null;
  type: string | null;
  subject: string | null;
  normalized: boolean | null;
  origin: string | null;
  eventAt: Date | null;
  deliveries: any[];
}

export interface FlowRawRow {
  id: string;
  status: 'ACCEPTED' | 'REJECTED' | 'DUPLICATE';
  signatureValid: boolean;
  receivedAt: Date;
  contentType: string | null;
  idempotencyKey: string;
  headers: Record<string, unknown> | null;
  body: unknown;
  bodyBytes: number | null;
  sourceId: string;
  sourceName: string;
  provider: string;
  normalizeProcessed: boolean;
}
