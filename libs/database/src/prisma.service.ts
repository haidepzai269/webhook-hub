import { PrismaClient, Prisma, Source, SourceSecret } from '@prisma/client';
import { AlertRow, TenantScopedRepository } from './tenant-scoped.repository';
import { logger } from '@hub/common';
import { IdentityRepository } from './identity.repository';

/**
 * PrismaService — COMPOSITION, không `extends PrismaClient` (BB-5).
 *
 * Lý do đổi từ kế thừa sang bọc (wrap): `extends PrismaClient` khiến
 * `this.prisma.source/destination/subscription/event/delivery` public và gọi
 * thẳng được ở bất cứ đâu, bỏ qua `TenantScopedRepository` — 5 bảng nghiệp vụ
 * mang `tenant_id` (Source, Destination, Subscription, Event, Delivery) BẮT BUỘC
 * phải đi qua `forTenant(tenantId)`.
 *
 * Các bảng KHÔNG mang `tenant_id` (hạ tầng xuyên-tenant hoặc tenant CHƯA XÁC ĐỊNH)
 * vẫn được expose trực tiếp qua getter riêng để code ingest/relay/normalize hiện
 * tại không phải đổi tên gọi:
 *   - rawEvent          : bước ingest CHƯA biết tenant (đang đi tìm source).
 *   - outbox            : outbox relay đọc xuyên tenant (SKIP LOCKED).
 *   - processedMessage  : idempotency theo consumer, không có cột tenant_id.
 *   - deliveryAttempt   : log con của delivery (FK deliveryId), không tự mang tenant_id.
 */
export class PrismaService {
  private static instance: PrismaService;

  private readonly client: PrismaClient;

  constructor() {
    this.client = new PrismaClient({
      log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
    });
  }

  public static getInstance(): PrismaService {
    if (!PrismaService.instance) {
      PrismaService.instance = new PrismaService();
    }
    return PrismaService.instance;
  }

  // ================== Hạ tầng Prisma (uỷ quyền sang client gốc) ==================

  public $transaction<P extends Prisma.PrismaPromise<any>[]>(
    arg: [...P],
    options?: { isolationLevel?: Prisma.TransactionIsolationLevel },
  ): Promise<any>;
  public $transaction<R>(
    fn: (tx: Prisma.TransactionClient) => Promise<R>,
    options?: { maxWait?: number; timeout?: number; isolationLevel?: Prisma.TransactionIsolationLevel },
  ): Promise<R>;
  public $transaction(arg: any, options?: any): Promise<any> {
    return this.client.$transaction(arg, options);
  }

  public $queryRaw<T = unknown>(query: TemplateStringsArray | Prisma.Sql, ...values: any[]): Promise<T> {
    return (this.client.$queryRaw as any)(query, ...values);
  }

  public $queryRawUnsafe<T = unknown>(query: string, ...values: any[]): Promise<T> {
    return this.client.$queryRawUnsafe<T>(query, ...values);
  }

  public $executeRaw(query: TemplateStringsArray | Prisma.Sql, ...values: any[]): Promise<number> {
    return (this.client.$executeRaw as any)(query, ...values);
  }

  public $executeRawUnsafe(query: string, ...values: any[]): Promise<number> {
    return this.client.$executeRawUnsafe(query, ...values);
  }

  public $connect(): Promise<void> {
    return this.client.$connect();
  }

  public $disconnect(): Promise<void> {
    return this.client.$disconnect();
  }

  // ================== Models KHÔNG cần scope tenant ==================

  public get rawEvent() {
    return this.client.rawEvent;
  }

  public get outbox() {
    return this.client.outbox;
  }

  public get processedMessage() {
    return this.client.processedMessage;
  }

  public get deliveryAttempt() {
    return this.client.deliveryAttempt;
  }

  /**
   * Escape hatch DUY NHẤT cho bước ingest xác định tenant: tra `source` theo
   * `sourceKey` TRƯỚC khi biết tenant là ai — chính bước này tìm ra tenant, nên
   * không thể đi qua `TenantScopedRepository`. KHÔNG dùng hàm này ở nơi khác.
   */
  public async findSourceBySourceKeyForIngest(sourceKey: string): Promise<IngestSource | null> {
    // AU6: chưa biết tenant (chính bước này tìm ra tenant) -> đường hệ thống. Đường NÓNG của ingest: dùng batch
    // transaction (set_config + SELECT gửi một lượt) thay vì transaction tương tác — p95 ingest (ADR-108).
    // QT3 (E4, ADR-182): nấc dung lượng JOIN vào CHÍNH câu nạp source (LEFT JOIN project_usage) — +0 lượt DB, +0 câu SQL:
    // trước đây `findUnique + include secrets` = 2 câu (sources, source_secrets); nay = câu sources⋈project_usage + câu
    // secrets (lọc theo sourceKey), vẫn 2 câu trong cùng một lần gửi batch. Không có dòng usage -> level null (= OK).
    const [, rows, secrets] = await this.client.$transaction([
      this.client.$executeRaw`SELECT set_config('app.rls_system', 'on', true)`,
      this.client.$queryRaw<IngestSourceRow[]>`
        SELECT s.id, s.tenant_id AS "tenantId", s.provider::text AS provider, s.name, s.source_key AS "sourceKey",
               s.is_active AS "isActive", s.verification_config AS "verificationConfig", s.archived_at AS "archivedAt",
               s.keep_longer AS "keepLonger", s.created_at AS "createdAt", pu.level AS "storageLevel"
        FROM hub.sources s LEFT JOIN hub.project_usage pu ON pu.tenant_id = s.tenant_id
        WHERE s.source_key = ${sourceKey}`,
      this.client.sourceSecret.findMany({
        where: {
          source: { sourceKey },
          OR: [{ validUntil: null }, { validUntil: { gt: new Date() } }],
        },
      }),
    ]);
    const row = rows[0];
    if (!row) return null;
    return { ...row, secrets: secrets.filter((x) => x.sourceId === row.id) } as IngestSource;
  }

  /**
   * Escape hatch HẠ TẦNG cho retention (S7, DINH-CHINH §3, ADR-077): xoá MỘT lô `events` có `received_at` cũ
   * hơn `olderThanSeconds`, XUYÊN project (job cleanup không thuộc tenant nào). FK CASCADE kéo theo
   * `deliveries` -> `delivery_attempts`. KHÔNG đụng `raw_events` (ACCEPTED giữ vô hạn, ADR-045). Chỉ CleanupJob gọi.
   */
  public async deleteExpiredEventsBatch(olderThanSeconds: number, limit: number): Promise<number> {
    return (await this.deleteExpiredEventsBatchAccounted(olderThanSeconds, limit)).deleted;
  }

  /**
   * QT5 (SPEC-han-muc-dung-luong E2, ADR-184): retention xoá events quá N ngày VÀ trừ byte giải phóng (công thức §2 —
   * `events.data` + deliveries + attempts; raw ACCEPTED KHÔNG bị retention xoá nên không tính) vào `project_usage` của từng
   * tenant trong CÙNG câu lệnh (cùng transaction). Trả số dòng xoá + byte theo tenant (người gọi tính lại nấc).
   */
  public async deleteExpiredEventsBatchAccounted(olderThanSeconds: number, limit: number): Promise<{ deleted: number; freed: { tenantId: string; bytes: number }[] }> {
    const [r] = await this.systemTx('cleanup: retention events', (tx) => tx.$queryRaw<{ n: number; freed: { t: string; b: number }[] | null }[]>`
      WITH v AS (
        SELECT id, tenant_id FROM "hub"."events"
        WHERE received_at < now() - make_interval(secs => ${olderThanSeconds}::double precision)
        LIMIT ${limit} FOR UPDATE SKIP LOCKED),
      sz AS (
        SELECT v.tenant_id, sum(COALESCE(pg_column_size(e.data), 0)
               + COALESCE((SELECT sum(COALESCE(pg_column_size(d.last_error), 0)
                                      + COALESCE((SELECT sum(COALESCE(pg_column_size(a.request_body), 0) + COALESCE(pg_column_size(a.response_body), 0)
                                                             + COALESCE(pg_column_size(a.error), 0)) FROM "hub"."delivery_attempts" a WHERE a.delivery_id = d.id), 0))
                           FROM "hub"."deliveries" d WHERE d.event_id = e.id), 0))::bigint AS b
        FROM v JOIN "hub"."events" e ON e.id = v.id GROUP BY v.tenant_id),
      del AS (DELETE FROM "hub"."events" e USING v WHERE e.id = v.id RETURNING e.id),
      acc AS (
        UPDATE "hub"."project_usage" pu SET freed_since_calibration = pu.freed_since_calibration + sz.b,
               used_bytes = GREATEST(0, pu.used_bytes - sz.b), measured_at = now()
        FROM sz WHERE pu.tenant_id = sz.tenant_id AND sz.b > 0 RETURNING pu.tenant_id)
      SELECT (SELECT count(*) FROM del)::int AS n,
             (SELECT json_agg(json_build_object('t', tenant_id, 'b', b)) FROM sz WHERE b > 0) AS freed`);
    return { deleted: Number(r?.n ?? 0), freed: (r?.freed ?? []).map((x) => ({ tenantId: x.t, bytes: Number(x.b) })) };
  }

  /**
   * QT5 (E2): retention xoá mẫu REJECTED quá N ngày (S1-4) VÀ trừ `octet_length(body_raw)` vào `project_usage` của tenant
   * sở hữu source — cùng câu lệnh. Mẫu của source "Giữ lâu" vẫn theo retention (retention là trần cứng của hub, không phải
   * dọn theo gợi ý).
   */
  public async deleteExpiredRejectedBatchAccounted(olderThanSeconds: number, limit: number): Promise<{ deleted: number; freed: { tenantId: string; bytes: number }[] }> {
    const [r] = await this.systemTx('cleanup: retention mẫu REJECTED', (tx) => tx.$queryRaw<{ n: number; freed: { t: string; b: number }[] | null }[]>`
      WITH v AS (
        SELECT r.id, s.tenant_id FROM "hub"."raw_events" r JOIN "hub"."sources" s ON s.id = r.source_id
        WHERE r.status = 'REJECTED' AND r.received_at < now() - make_interval(secs => ${olderThanSeconds}::double precision)
        LIMIT ${limit} FOR UPDATE OF r SKIP LOCKED),
      del AS (DELETE FROM "hub"."raw_events" r USING v WHERE r.id = v.id RETURNING v.tenant_id, octet_length(r.body_raw) AS b),
      sz AS (SELECT tenant_id, sum(b)::bigint AS b FROM del GROUP BY tenant_id),
      acc AS (
        UPDATE "hub"."project_usage" pu SET freed_since_calibration = pu.freed_since_calibration + sz.b,
               used_bytes = GREATEST(0, pu.used_bytes - sz.b), measured_at = now()
        FROM sz WHERE pu.tenant_id = sz.tenant_id AND sz.b > 0 RETURNING pu.tenant_id)
      SELECT (SELECT count(*) FROM del)::int AS n,
             (SELECT json_agg(json_build_object('t', tenant_id, 'b', b)) FROM sz WHERE b > 0) AS freed`);
    return { deleted: Number(r?.n ?? 0), freed: (r?.freed ?? []).map((x) => ({ tenantId: x.t, bytes: Number(x.b) })) };
  }

  // ================== Project + API key (S1, ADR-038) ==================
  // `projects` là bảng GỐC (id = tenant_id), không mang tenant_id -> không đi qua repo được.
  // `api_keys` có tenant_id: CRUD theo project đi qua `forTenant(...)`; riêng tra theo hash là bước
  // XÁC ĐỊNH project của request (chưa biết tenant) nên là escape hatch, như `findSourceBySourceKeyForIngest`.

  /** Console admin (operator, ADR-056): danh sách mọi project. */
  public listProjects() {
    return this.client.project.findMany({ orderBy: { createdAt: 'asc' } });
  }

  public findProjectById(id: string) {
    return this.client.project.findUnique({ where: { id } });
  }

  /** CB3 (review L6): id nào trong danh sách là project đang tồn tại — một truy vấn `id IN (…)`, không kéo mọi project. */
  public async findExistingProjectIds(ids: string[]): Promise<string[]> {
    if (ids.length === 0) return [];
    const rows = await this.client.project.findMany({ where: { id: { in: ids } }, select: { id: true } });
    return rows.map((r) => r.id);
  }

  /** Dùng ở `/v1/p/:project/*` — path mang slug. */
  public findProjectBySlug(slug: string) {
    return this.client.project.findUnique({ where: { slug } });
  }

  /** Trùng slug -> Prisma P2002 (controller trả 409). */
  public createProject(data: { id: string; slug: string; name: string; environment: 'test' | 'live' }) {
    return this.client.project.create({ data });
  }

  /**
   * Escape hatch DUY NHẤT tra API key không scope: `ApiKeyGuard` chỉ có key thô (-> sha256) và chưa biết
   * project. Kèm project để so slug trên path trong cùng một truy vấn. KHÔNG dùng ở nơi khác.
   */
  public findApiKeyByHash(keyHash: string) {
    return this.client.apiKey.findUnique({ where: { keyHash }, include: { project: true } });
  }

  /**
   * SPEC-auth §5.1: bảng danh tính (users, project_members, auth_sessions, email_tokens, auth_audit) chỉ qua
   * `IdentityRepository`. Truyền `tx` để chạy trong transaction của người gọi.
   */
  public identity(client: PrismaClient | Prisma.TransactionClient = this.client): IdentityRepository {
    return new IdentityRepository(client);
  }

  // ================== Cảnh báo: escape hatch của OPERATOR (CB3, SPEC-canh-bao-nhan-dinh §5.2, ADR-169) ==================
  // Chuông của operator nhìn MỌI project (Q1). `alerts` mang tenant_id + RLS -> đọc xuyên project chỉ qua BỐN hàm có tên
  // dưới đây (systemTx), CHỈ module alerts (sau OperatorGuard) gọi — gate `operator-alerts` giữ điều này. Ghi (ack) KHÔNG đi đường này: tra tenant của
  // cảnh báo rồi ghi bằng `forTenant(tenant)` như mọi chỗ khác — giống bước ingest tra source rồi mới scope.

  /**
   * Danh sách cảnh báo XUYÊN project, keyset `(opened_at, id)` (ADR-163: không OFFSET). `older` = giảm dần, sát sau
   * cursor; `newer` = TĂNG dần sát trước cursor (người gọi đảo lại). Kèm project {id, slug, name} của từng dòng.
   */
  public operatorAlertsAcrossTenants(f: OperatorAlertFilter): Promise<OperatorAlertRow[]> {
    const conds: Prisma.Sql[] = [];
    // review L4: so sánh trên kiểu enum (không ép ::text cột) để index (state, severity, opened_at) dùng được.
    if (f.state) conds.push(Prisma.sql`AND a.state = ${f.state}::"hub"."AlertState"`);
    if (f.severity) conds.push(Prisma.sql`AND a.severity = ${f.severity}::"hub"."AlertSeverity"`);
    if (f.rule) conds.push(Prisma.sql`AND a.rule = ${f.rule}`);
    if (f.projectId) conds.push(Prisma.sql`AND a.tenant_id = ${f.projectId}::uuid`);
    if (f.cursor) {
      const at = Prisma.sql`${f.cursor.at}::timestamp AT TIME ZONE 'UTC'`;
      conds.push(
        f.dir === 'newer'
          ? Prisma.sql`AND (a.opened_at, a.id) > (${at}, ${f.cursor.id}::uuid)`
          : Prisma.sql`AND (a.opened_at, a.id) < (${at}, ${f.cursor.id}::uuid)`,
      );
    }
    const order = f.dir === 'newer' ? Prisma.sql`a.opened_at ASC, a.id ASC` : Prisma.sql`a.opened_at DESC, a.id DESC`;
    return this.systemTx('operator: alerts xuyên project', async (tx) => {
      const rows = await tx.$queryRaw<(AlertRow & { cursorAt: string; projectSlug: string; projectName: string })[]>(Prisma.sql`
        SELECT a.id, a.tenant_id AS "tenantId", a.rule, a.severity::text AS severity, a.subject_type::text AS "subjectType",
               a.subject_id AS "subjectId", a.state::text AS state, a.opened_at AS "openedAt", a.last_seen_at AS "lastSeenAt",
               a.resolved_at AS "resolvedAt", a.facts, a.acknowledged_at AS "acknowledgedAt", a.acknowledged_by AS "acknowledgedBy",
               to_char(a.opened_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') AS "cursorAt",
               p.slug AS "projectSlug", p.name AS "projectName"
        FROM hub.alerts a JOIN hub.projects p ON p.id = a.tenant_id
        WHERE TRUE ${conds.length ? Prisma.join(conds, ' ') : Prisma.empty}
        ORDER BY ${order}
        LIMIT ${f.limit + 1}`);
      return rows.map(({ projectSlug, projectName, ...a }) => ({ ...a, project: { id: a.tenantId, slug: projectSlug, name: projectName } }));
    });
  }

  /**
   * Đồng hồ DB (`now()`) — mốc `asOf` của danh sách cảnh báo (ADR-188): console so "cảnh báo nào mới" theo đồng hồ
   * SERVER, không theo `Date.now()` của trình duyệt (máy người dùng lệch giờ). Không chạm bảng nào -> không cần scope.
   */
  public async dbNow(): Promise<Date> {
    const [r] = await this.client.$queryRaw<{ now: Date }[]>(Prisma.sql`SELECT now() AS now`);
    return r.now;
  }

  /**
   * Tóm tắt cho chuông: tổng OPEN theo mức + chưa xem tính trên TOÀN bảng (không trần), và chi tiết theo từng project
   * (chỉ project có cảnh báo OPEN, tối đa `limit` project — tổng không phụ thuộc trần này).
   */
  public operatorAlertSummaryAcrossTenants(limit = 500): Promise<OperatorAlertSummary> {
    return this.systemTx('operator: tóm tắt alerts xuyên project', async (tx) => {
      // CB4 review L1: chưa xem TÁCH theo mức (cùng một lượt quét) — màu badge chuông theo mức cao nhất CHƯA XEM.
      const [t] = await tx.$queryRaw<
        { critical: bigint; warning: bigint; info: bigint; unacked: bigint; unackedCritical: bigint; unackedWarning: bigint; unackedInfo: bigint }[]
      >(Prisma.sql`
        SELECT count(*) FILTER (WHERE severity = 'critical') AS critical,
               count(*) FILTER (WHERE severity = 'warning')  AS warning,
               count(*) FILTER (WHERE severity = 'info')     AS info,
               count(*) FILTER (WHERE acknowledged_at IS NULL) AS unacked,
               count(*) FILTER (WHERE acknowledged_at IS NULL AND severity = 'critical') AS "unackedCritical",
               count(*) FILTER (WHERE acknowledged_at IS NULL AND severity = 'warning')  AS "unackedWarning",
               count(*) FILTER (WHERE acknowledged_at IS NULL AND severity = 'info')     AS "unackedInfo"
        FROM hub.alerts WHERE state = 'OPEN'`);
      const rows = await tx.$queryRaw<{ id: string; slug: string; name: string; critical: bigint; warning: bigint; info: bigint; unacked: bigint }[]>(Prisma.sql`
        SELECT p.id, p.slug, p.name,
               count(*) FILTER (WHERE a.severity = 'critical') AS critical,
               count(*) FILTER (WHERE a.severity = 'warning')  AS warning,
               count(*) FILTER (WHERE a.severity = 'info')     AS info,
               count(*) FILTER (WHERE a.acknowledged_at IS NULL) AS unacked
        FROM hub.alerts a JOIN hub.projects p ON p.id = a.tenant_id
        WHERE a.state = 'OPEN'
        GROUP BY p.id, p.slug, p.name
        ORDER BY critical DESC, warning DESC, p.slug ASC
        LIMIT ${limit}`);
      return {
        totals: {
          critical: Number(t?.critical ?? 0),
          warning: Number(t?.warning ?? 0),
          info: Number(t?.info ?? 0),
          unacked: Number(t?.unacked ?? 0),
          unackedBySeverity: { critical: Number(t?.unackedCritical ?? 0), warning: Number(t?.unackedWarning ?? 0), info: Number(t?.unackedInfo ?? 0) },
        },
        perProject: rows.map((r) => ({
          project: { id: r.id, slug: r.slug, name: r.name },
          critical: Number(r.critical),
          warning: Number(r.warning),
          info: Number(r.info),
          unacked: Number(r.unacked),
        })),
      };
    });
  }

  /**
   * ack-all theo id (re-review CB4): tra tenant của TỪNG id trong một truy vấn — id không tồn tại thì vắng mặt. Chỉ ĐỌC;
   * ghi đi `tenantTx` + `forTenant` theo từng tenant như ack một dòng.
   */
  public async operatorFindAlertTenants(ids: string[]): Promise<{ id: string; tenantId: string }[]> {
    if (ids.length === 0) return [];
    return this.systemTx('operator: tra tenant của nhiều alert', (tx) =>
      tx.$queryRaw<{ id: string; tenantId: string }[]>(Prisma.sql`
        SELECT id, tenant_id AS "tenantId" FROM hub.alerts WHERE id = ANY(${ids}::uuid[]) ORDER BY id`),
    );
  }

  /** Bước XÁC ĐỊNH tenant của một cảnh báo (ack theo id từ chuông xuyên project). Không có -> null (route trả 404). */
  public async operatorFindAlertTenant(alertId: string): Promise<string | null> {
    const rows = await this.systemTx('operator: tra tenant của alert', (tx) =>
      tx.$queryRaw<{ tenantId: string }[]>(Prisma.sql`SELECT tenant_id AS "tenantId" FROM hub.alerts WHERE id = ${alertId}::uuid`),
    );
    return rows[0]?.tenantId ?? null;
  }

  // ================== Email cảnh báo: escape hatch của VÒNG GỬI (CB5, SPEC §6, DINH-CHINH D1/D2, ADR-173) ==================
  // `alert_emails` mang tenant_id + RLS. Vòng gửi trong hub-worker làm việc THEO NGƯỜI, xuyên project (trần 6/giờ/người,
  // dòng "…và k khác" gộp email của mọi project) -> đi qua ĐÚNG các hàm có tên dưới đây (systemTx), như `cleanup.job`.
  // Chỉ `apps/hub-worker/src/scheduler/alert-email.sender.ts` gọi — gate `alert-email-outbox` giữ điều này.
  // Mọi mốc thời gian là ĐỒNG HỒ DB (`now()`), không đồng hồ của worker (review CB5 T-1). Lease = giá trị `next_attempt_at`
  // (dạng text, đủ µs) — mọi lần ghi kết quả đều kèm token này (fencing, review CB5 TB-2).

  /**
   * Lấy tối đa `limit` email PENDING đến hạn bằng `FOR UPDATE SKIP LOCKED` trong một transaction NGẮN: tăng `attempts`,
   * đặt lease `next_attempt_at = now() + leaseMs`, COMMIT — gửi diễn ra NGOÀI transaction. Trước đó, dòng hết lease mà đã
   * dùng hết `maxAttempts` (worker chết giữa chừng nhiều lần) -> FAILED luôn (review T-2). Trả kèm ngữ cảnh để kiểm lại điều
   * kiện + dựng thư (KHÔNG URL/cấu hình đích — CB:T9). `tenantIds`: CHỈ test dùng (DB kiểm chứng dùng chung) — production
   * không truyền.
   */
  public alertEmailOutboxClaim(o: { limit: number; leaseMs: number; maxAttempts: number; tenantIds?: string[] }): Promise<AlertEmailClaim[]> {
    const scope = o.tenantIds ? Prisma.sql`AND tenant_id = ANY(${o.tenantIds}::uuid[])` : Prisma.empty;
    return this.systemTx('alert email: lấy lô PENDING (SKIP LOCKED)', async (tx) => {
      await tx.$executeRaw(Prisma.sql`
        UPDATE hub.alert_emails SET state = 'FAILED', next_attempt_at = NULL,
               last_error = COALESCE(last_error, 'lease hết hạn sau lần thử cuối')
        WHERE state = 'PENDING' AND attempts >= ${o.maxAttempts} AND next_attempt_at <= now() ${scope}`);
      const picked = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
        WITH picked AS (
          SELECT id FROM hub.alert_emails
          WHERE state = 'PENDING' AND (next_attempt_at IS NULL OR next_attempt_at <= now()) ${scope}
          ORDER BY created_at, id
          LIMIT ${o.limit}
          FOR UPDATE SKIP LOCKED)
        UPDATE hub.alert_emails e
        SET attempts = e.attempts + 1, next_attempt_at = now() + make_interval(secs => ${o.leaseMs / 1000}::double precision)
        FROM picked WHERE e.id = picked.id
        RETURNING e.id`);
      if (picked.length === 0) return [];
      return tx.$queryRaw<AlertEmailClaim[]>(Prisma.sql`
        SELECT e.id, e.tenant_id AS "tenantId", e.alert_id AS "alertId", e.user_id AS "userId", e.kind::text AS kind,
               e.attempts, e.created_at AS "createdAt", e.next_attempt_at::text AS lease,
               a.rule, a.severity::text AS severity, a.subject_type::text AS "subjectType", a.subject_id AS "subjectId",
               a.state::text AS "alertState", a.facts, a.opened_at AS "openedAt", a.resolved_at AS "resolvedAt",
               p.slug AS "projectSlug", p.name AS "projectName",
               u.email, u.locale::text AS locale, u.is_operator AS "isOperator", (u.email_verified_at IS NOT NULL) AS "emailVerified",
               COALESCE(pr.email_enabled, false) AS "emailEnabled", COALESCE(pr.email_rules, ARRAY[]::text[]) AS "emailRules",
               COALESCE(pr.email_on_resolve, false) AS "emailOnResolve", COALESCE(pr.muted_projects, ARRAY[]::uuid[])::text[] AS "mutedProjects",
               COALESCE(d.name, s.name) AS "subjectName"
        FROM hub.alert_emails e
        JOIN hub.alerts a ON a.id = e.alert_id AND a.tenant_id = e.tenant_id
        JOIN hub.projects p ON p.id = e.tenant_id
        JOIN hub.users u ON u.id = e.user_id
        LEFT JOIN hub.alert_preferences pr ON pr.user_id = e.user_id
        LEFT JOIN hub.destinations d ON a.subject_type = 'destination' AND d.id = a.subject_id AND d.tenant_id = a.tenant_id
        LEFT JOIN hub.sources s ON a.subject_type = 'source' AND s.id = a.subject_id AND s.tenant_id = a.tenant_id
        WHERE e.id = ANY(${picked.map((r) => r.id)}::uuid[])
        ORDER BY e.user_id, e.created_at, e.id`);
    });
  }

  /**
   * Gia hạn lease NGAY TRƯỚC KHI GỬI một dòng — chỉ khi lease vẫn là của mình (`lease` khớp). 0 dòng = worker khác đã lấy
   * lại (lease cũ hết hạn) -> KHÔNG được gửi. Trả token mới + trạng thái email OPEN của cùng (cảnh báo, người) — thư
   * RESOLVED chỉ gửi khi thư OPEN đã xong (review T-3).
   */
  public alertEmailOutboxRenew(id: string, lease: string, leaseMs: number): Promise<{ lease: string; openState: string | null } | null> {
    return this.systemTx('alert email: gia hạn lease', async (tx) => {
      const rows = await tx.$queryRaw<{ lease: string; openState: string | null }[]>(Prisma.sql`
        UPDATE hub.alert_emails e SET next_attempt_at = now() + make_interval(secs => ${leaseMs / 1000}::double precision)
        WHERE e.id = ${id}::uuid AND e.state = 'PENDING' AND e.next_attempt_at = ${lease}::timestamptz
        RETURNING e.next_attempt_at::text AS lease,
          (SELECT o.state::text FROM hub.alert_emails o WHERE o.alert_id = e.alert_id AND o.user_id = e.user_id AND o.kind = 'OPEN') AS "openState"`);
      return rows[0] ?? null;
    });
  }

  /**
   * Trần 6/giờ/người: số email ĐÃ GỬI của người này trong `windowMs` theo đồng hồ DB (index một phần
   * `alert_emails_user_sent_idx`) + id các email bị trần chặn (`cap`) chưa gộp vào thư nào.
   */
  public alertEmailOutboxCapState(userId: string, windowMs: number, rollupLimit = 500): Promise<{ sentInWindow: number; rollupIds: string[] }> {
    return this.systemTx('alert email: trần theo người', async (tx) => {
      const [c] = await tx.$queryRaw<{ n: number }[]>(Prisma.sql`
        SELECT count(*)::int AS n FROM hub.alert_emails
        WHERE user_id = ${userId}::uuid AND state = 'SENT' AND sent_at > now() - make_interval(secs => ${windowMs / 1000}::double precision)`);
      const rows = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
        SELECT id FROM hub.alert_emails
        WHERE user_id = ${userId}::uuid AND state = 'SUPPRESSED' AND suppressed_reason = 'cap' AND rolled_into IS NULL
        ORDER BY created_at, id LIMIT ${rollupLimit}`);
      return { sentInWindow: c?.n ?? 0, rollupIds: rows.map((r) => r.id) };
    });
  }

  /** Đã gửi (chỉ khi lease còn của mình): SENT + `sent_at = now()`; các dòng `cap` đã nêu trong thư -> `rolled_into`. */
  public alertEmailOutboxMarkSent(id: string, lease: string, rolledIds: string[] = []): Promise<boolean> {
    return this.systemTx('alert email: đã gửi', async (tx) => {
      const n = await tx.$executeRaw(Prisma.sql`
        UPDATE hub.alert_emails SET state = 'SENT', sent_at = now(), next_attempt_at = NULL, last_error = NULL
        WHERE id = ${id}::uuid AND state = 'PENDING' AND next_attempt_at = ${lease}::timestamptz`);
      if (n === 1 && rolledIds.length > 0) {
        await tx.$executeRaw(Prisma.sql`
          UPDATE hub.alert_emails SET rolled_into = ${id}::uuid
          WHERE id = ANY(${rolledIds}::uuid[]) AND state = 'SUPPRESSED' AND rolled_into IS NULL`);
      }
      return n === 1;
    });
  }

  /** Không gửi: SUPPRESSED kèm lý do (`cap` | `ineligible:<…>`). Chỉ dòng còn PENDING và lease còn của mình. */
  public alertEmailOutboxMarkSuppressed(id: string, lease: string, reason: string): Promise<boolean> {
    return this.systemTx('alert email: không gửi', async (tx) => {
      const n = await tx.$executeRaw(Prisma.sql`
        UPDATE hub.alert_emails SET state = 'SUPPRESSED', suppressed_reason = ${reason.slice(0, 64)}, next_attempt_at = NULL
        WHERE id = ${id}::uuid AND state = 'PENDING' AND next_attempt_at = ${lease}::timestamptz`);
      return n === 1;
    });
  }

  /**
   * Gửi lỗi (lease còn của mình): `attempts` ≥ `maxAttempts` -> FAILED; còn lại PENDING, `next_attempt_at = now() + retryMs`.
   * `release` = trả dòng chưa gửi (shutdown, hết ngân sách lượt, hoãn thư RESOLVED): bớt lại lần thử đã tính lúc lấy,
   * đến hạn sau `delayMs` (mặc định ngay).
   */
  public alertEmailOutboxMarkFailure(
    id: string,
    lease: string,
    o: { error: string; maxAttempts: number; retryMs: number } | { release: true; delayMs?: number },
  ): Promise<'FAILED' | 'PENDING' | null> {
    return this.systemTx('alert email: gửi lỗi', async (tx) => {
      const rows =
        'release' in o
          ? await tx.$queryRaw<{ state: string }[]>(Prisma.sql`
              UPDATE hub.alert_emails
              SET attempts = GREATEST(attempts - 1, 0), next_attempt_at = now() + make_interval(secs => ${(o.delayMs ?? 0) / 1000}::double precision)
              WHERE id = ${id}::uuid AND state = 'PENDING' AND next_attempt_at = ${lease}::timestamptz RETURNING state::text AS state`)
          : await tx.$queryRaw<{ state: string }[]>(Prisma.sql`
              UPDATE hub.alert_emails
              SET last_error = ${o.error.slice(0, 200)},
                  state = CASE WHEN attempts >= ${o.maxAttempts} THEN 'FAILED'::"hub"."AlertEmailState" ELSE 'PENDING'::"hub"."AlertEmailState" END,
                  next_attempt_at = CASE WHEN attempts >= ${o.maxAttempts} THEN NULL
                                         ELSE now() + make_interval(secs => ${o.retryMs / 1000}::double precision) END
              WHERE id = ${id}::uuid AND state = 'PENDING' AND next_attempt_at = ${lease}::timestamptz RETURNING state::text AS state`);
      return (rows[0]?.state as 'FAILED' | 'PENDING' | undefined) ?? null;
    });
  }

  // ================== Hạn mức dung lượng: escape hatch của JOB ĐO (QT2, SPEC-han-muc-dung-luong E2, ADR-183) ==================
  // `project_usage` + `source_traffic_minutely` mang tenant_id + RLS. Job cập nhật nấc làm việc XUYÊN project (một truy vấn
  // gộp mỗi 60s) -> đi qua ĐÚNG các hàm có tên dưới đây (systemTx), tiền lệ `cleanup.job`. Chỉ
  // `apps/hub-worker/src/scheduler/storage.job.ts` gọi — gate `storage-cross-tenant` giữ điều này. GHI đi `forTenant`.

  /**
   * MỘT truy vấn gộp xuyên project: mỗi dòng `project_usage` kèm hạn mức ghi đè + Σ bytes traffic SAU mốc hiệu chỉnh
   * (`minute > date_trunc('minute', calibrated_at)` — phút chứa mốc thuộc về lần quét). Dùng tiền tố PK
   * `(tenant_id, …, minute)` của bảng traffic. `tenantIds`: CHỈ test (DB kiểm chứng dùng chung).
   */
  public storageLevelTickAcrossTenants(tenantIds?: string[]): Promise<StorageTickRow[]> {
    const scope = tenantIds ? Prisma.sql`WHERE pu.tenant_id = ANY(${tenantIds}::uuid[])` : Prisma.empty;
    return this.systemTx('storage: level tick', async (tx) => {
      const rows = await tx.$queryRaw<
        { tenantId: string; usedBytes: bigint; level: string; calibratedBytes: bigint; calibratedAt: Date | null; calibratedAtToken: string | null; freed: bigint; bloatFactor: number; quotaMb: number | null; trafficBytes: bigint }[]
      >(Prisma.sql`
        SELECT pu.tenant_id AS "tenantId", pu.used_bytes AS "usedBytes", pu.level, pu.calibrated_bytes AS "calibratedBytes",
               pu.calibrated_at AS "calibratedAt", pu.calibrated_at::text AS "calibratedAtToken", pu.freed_since_calibration AS freed, pu.bloat_factor::float8 AS "bloatFactor",
               p.storage_quota_mb AS "quotaMb",
               COALESCE((SELECT sum(t.bytes) FROM hub.source_traffic_minutely t
                         WHERE t.tenant_id = pu.tenant_id
                           AND t.minute > date_trunc('minute', COALESCE(pu.calibrated_at, '-infinity'::timestamptz))), 0)::bigint AS "trafficBytes"
        FROM hub.project_usage pu JOIN hub.projects p ON p.id = pu.tenant_id
        ${scope}
        ORDER BY pu.tenant_id`);
      return rows.map((r) => ({
        tenantId: r.tenantId,
        usedBytes: Number(r.usedBytes),
        level: r.level,
        calibratedBytes: Number(r.calibratedBytes),
        calibratedAt: r.calibratedAt,
        calibratedAtToken: r.calibratedAtToken,
        freedSinceCalibration: Number(r.freed),
        bloatFactor: Number(r.bloatFactor),
        quotaMb: r.quotaMb,
        trafficBytesSinceCalibration: Number(r.trafficBytes),
      }));
    });
  }

  /**
   * Project cần hiệu chỉnh ở lượt này: chưa có `project_usage`, chưa hiệu chỉnh lần nào, hoặc mốc cũ hơn `dueBefore`
   * (theo chu kỳ / sắp mất traffic sau mốc). Cũ nhất trước. `tenantIds`: CHỈ test.
   */
  public storageProjectsDueForCalibrationAcrossTenants(dueBefore: Date, limit: number, tenantIds?: string[]): Promise<string[]> {
    const scope = tenantIds ? Prisma.sql`AND p.id = ANY(${tenantIds}::uuid[])` : Prisma.empty;
    return this.systemTx('storage: project cần hiệu chỉnh', async (tx) => {
      const rows = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
        SELECT p.id FROM hub.projects p LEFT JOIN hub.project_usage pu ON pu.tenant_id = p.id
        WHERE (pu.tenant_id IS NULL OR pu.calibrated_at IS NULL OR pu.calibrated_at < ${dueBefore}) ${scope}
        ORDER BY pu.calibrated_at ASC NULLS FIRST, p.id
        LIMIT ${limit}`);
      return rows.map((r) => r.id);
    });
  }

  /**
   * QT4 (§5.5, ADR-184): worker NHẬN một lệnh dọn — PENDING, hoặc RUNNING đã hết lease (worker trước chết giữa chừng; lô
   * đã COMMIT giữ nguyên tiến độ, lô dở bị rollback, chạy tiếp từ chỗ còn lại). `FOR UPDATE SKIP LOCKED` -> nhiều instance
   * worker không nhận trùng (như outbox relay), không cần khoá Redis. Lệnh đã nhận quá `maxAttempts` lần -> FAILED (không
   * quay vòng mãi). Đọc xuyên project -> escape hatch có tên; THÂN lệnh được nạp lại và chạy qua `forTenant` (RLS).
   */
  public storageClaimCleanJobAcrossTenants(leaseMs: number, maxAttempts: number): Promise<{ id: string; tenantId: string } | null> {
    return this.systemTx('storage: nhận lệnh dọn (SKIP LOCKED)', async (tx) => {
      await tx.$executeRaw(Prisma.sql`
        UPDATE hub.storage_clean_jobs SET status = 'FAILED', error = 'Quá số lần thử (worker dừng giữa chừng nhiều lần)',
               finished_at = now(), lease_until = NULL
        WHERE status = 'RUNNING' AND lease_until < now() AND attempts >= ${maxAttempts}::int`);
      const rows = await tx.$queryRaw<{ id: string; tenantId: string }[]>(Prisma.sql`
        UPDATE hub.storage_clean_jobs j SET status = 'RUNNING', attempts = j.attempts + 1, started_at = COALESCE(j.started_at, now()),
               lease_until = now() + make_interval(secs => ${leaseMs / 1000}::double precision)
        WHERE j.id = (
          SELECT id FROM hub.storage_clean_jobs
          WHERE status = 'PENDING' OR (status = 'RUNNING' AND lease_until < now())
          ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
        RETURNING j.id, j.tenant_id AS "tenantId"`);
      return rows[0] ?? null;
    });
  }

  /**
   * QT5 (§5.4, ADR-186): project có policy dọn tự động đang bật (`action <> 'off'`) kèm số đo hiện tại — đọc XUYÊN project
   * cho lượt dọn tự động của cleanup job (cùng khoá Redis). Chỉ junk/low/medium tồn tại trong bảng (CHECK). Thân dọn chạy
   * qua `forTenant` (RLS). `tenantIds`: CHỈ test.
   */
  public storageAutoCleanTargetsAcrossTenants(tenantIds?: string[]): Promise<StorageAutoCleanTarget[]> {
    const scope = tenantIds ? Prisma.sql`AND sp.tenant_id = ANY(${tenantIds}::uuid[])` : Prisma.empty;
    return this.systemTx('storage: policy dọn tự động', async (tx) => {
      const rows = await tx.$queryRaw<{ tenantId: string; quotaMb: number | null; usedBytes: bigint | null; importance: string; action: string; afterDays: number; trigger: string }[]>(Prisma.sql`
        SELECT sp.tenant_id AS "tenantId", p.storage_quota_mb AS "quotaMb", pu.used_bytes AS "usedBytes",
               sp.importance, sp.action, sp.after_days AS "afterDays", sp.trigger
        FROM hub.storage_policies sp JOIN hub.projects p ON p.id = sp.tenant_id
        LEFT JOIN hub.project_usage pu ON pu.tenant_id = sp.tenant_id
        WHERE sp.action <> 'off' ${scope}
        ORDER BY sp.tenant_id, sp.importance`);
      const by = new Map<string, StorageAutoCleanTarget>();
      for (const r of rows) {
        const t = by.get(r.tenantId) ?? { tenantId: r.tenantId, quotaMb: r.quotaMb, usedBytes: Number(r.usedBytes ?? 0), policies: [] };
        t.policies.push({ importance: r.importance, action: r.action, afterDays: r.afterDays, trigger: r.trigger });
        by.set(r.tenantId, t);
      }
      return [...by.values()];
    });
  }

  /** §6 (ADR-185): kích thước cả database — không đọc dữ liệu tenant nào (catalog của Postgres). */
  public async databaseSizeBytes(): Promise<number> {
    const [r] = await this.client.$queryRaw<{ n: bigint }[]>`SELECT pg_database_size(current_database()) AS n`;
    return Number(r?.n ?? 0);
  }

  // ================== RLS (SPEC-auth §5.12, AU6) ==================

  /**
   * ĐƯỜNG HỆ THỐNG DUY NHẤT nhìn xuyên project: transaction đặt `app.rls_system = on` (LOCAL — chỉ sống trong
   * transaction, an toàn với pgbouncer của Neon). Dùng cho bước CHƯA biết tenant (tra source lúc ingest) hoặc việc
   * xuyên tenant có chủ đích (cleanup, sweeper). Ngay khi đọc ra tenant, phần còn lại phải chuyển sang
   * `forTenant`/`tenantTx`. Chỉ FILE NÀY được chứa chuỗi `app.rls_system` (gate rls-system + UA30).
   */
  public systemTx<T>(reason: string, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.client.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.rls_system', 'on', true)`;
      logger.debug({ reason }, 'RLS systemTx');
      return fn(tx);
    });
  }

  /**
   * Transaction đã đặt `app.project_id` NGAY ĐẦU — cho chỗ ghi thẳng bảng có RLS qua `tx` (vd `tx.rawEvent.create`,
   * `tx.deliveryAttempt.create`) trước/cùng với repo. Repo dựng trong `tx` này cũng tự đặt (cùng giá trị, vô hại).
   */
  public tenantTx<T>(tenantId: string, fn: (tx: Prisma.TransactionClient) => Promise<T>, options?: { timeout?: number; maxWait?: number }): Promise<T> {
    if (!tenantId) throw new Error('tenantTx: tenantId là bắt buộc (BB-5)');
    return this.client.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.project_id', ${tenantId}, true)`;
      return fn(tx);
    }, options);
  }

  /**
   * Tạo repository được bảo vệ theo Tenant (BB-5). `client` mặc định là
   * PrismaClient gốc, nhưng có thể truyền `tx` (Prisma.TransactionClient) khi
   * cần dùng repo BÊN TRONG một `$transaction` interactive đã biết tenant.
   */
  public forTenant(
    tenantId: string,
    client: PrismaClient | Prisma.TransactionClient = this.client,
  ): TenantScopedRepository {
    return new TenantScopedRepository(client, tenantId);
  }
}

export const prisma = PrismaService.getInstance();

/** CB5: một email cảnh báo vừa được vòng gửi lấy (kèm ngữ cảnh kiểm lại điều kiện + dựng thư). */
export interface AlertEmailClaim {
  id: string;
  tenantId: string;
  alertId: string;
  userId: string;
  kind: 'OPEN' | 'RESOLVED';
  attempts: number;
  createdAt: Date;
  /** Lease (= `next_attempt_at` dạng text, đủ µs) — token fencing cho mọi lần ghi kết quả. */
  lease: string;
  rule: string;
  severity: 'critical' | 'warning' | 'info';
  subjectType: 'destination' | 'source' | 'project';
  subjectId: string;
  alertState: 'OPEN' | 'RESOLVED';
  facts: Record<string, unknown> | null;
  openedAt: Date;
  resolvedAt: Date | null;
  projectSlug: string;
  projectName: string;
  email: string;
  locale: 'vi' | 'en';
  isOperator: boolean;
  emailVerified: boolean;
  emailEnabled: boolean;
  emailRules: string[];
  emailOnResolve: boolean;
  mutedProjects: string[];
  subjectName: string | null;
}

/** CB3: bộ lọc danh sách cảnh báo xuyên project của operator (giá trị đã kiểm ở route). */
export interface OperatorAlertFilter {
  state?: 'OPEN' | 'RESOLVED';
  severity?: 'critical' | 'warning' | 'info';
  rule?: string;
  projectId?: string;
  dir: 'older' | 'newer';
  /** `at` = UTC µs `YYYY-MM-DDTHH:MM:SS.ffffff` (list-params). */
  cursor?: { at: string; id: string };
  limit: number;
}

export interface OperatorAlertProject {
  id: string;
  slug: string;
  name: string;
}

export interface OperatorAlertRow extends AlertRow {
  cursorAt: string;
  project: OperatorAlertProject;
}

export interface OperatorAlertSummary {
  totals: {
    critical: number;
    warning: number;
    info: number;
    unacked: number;
    /** CB4 review L1: chưa xem theo mức — màu badge chuông. */
    unackedBySeverity: { critical: number; warning: number; info: number };
  };
  perProject: OperatorAlertProjectSummary[];
}

export interface OperatorAlertProjectSummary {
  project: OperatorAlertProject;
  critical: number;
  warning: number;
  info: number;
  unacked: number;
}

/**
 * SPEC-auth §5.12.2: runtime (hub-api, hub-worker) KHÔNG được chạy bằng superuser hay role BYPASSRLS — chúng luôn
 * bỏ qua RLS (kể cả FORCE) và mọi policy chỉ là trang trí. Gặp -> `process.exit(1)` với thông báo rõ.
 * Ngoại lệ DUY NHẤT: `RLS_ALLOW_PRIVILEGED=1` khi `NODE_ENV=test`.
 */
export async function assertAppRoleNotPrivileged(
  db: { $queryRaw<T = unknown>(query: TemplateStringsArray | Prisma.Sql, ...values: any[]): Promise<T> },
  env: Record<string, string | undefined> = process.env,
  exit: (code: number) => void = (c) => process.exit(c),
): Promise<void> {
  const [row] = await db.$queryRaw<{ current_user: string; rolsuper: boolean; rolbypassrls: boolean }[]>`
    SELECT current_user, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`;
  if (!row || (!row.rolsuper && !row.rolbypassrls)) return;
  if (env.RLS_ALLOW_PRIVILEGED === '1' && env.NODE_ENV === 'test') {
    logger.warn({ role: row.current_user }, 'RLS_ALLOW_PRIVILEGED=1 (chỉ test): chạy bằng role đặc quyền, RLS bị bỏ qua');
    return;
  }
  logger.error(
    { role: row.current_user, rolsuper: row.rolsuper, rolbypassrls: row.rolbypassrls },
    'FATAL: DATABASE_URL đang dùng role superuser/BYPASSRLS — RLS sẽ bị bỏ qua hoàn toàn. Đổi DATABASE_URL sang role hub_app ' +
      '(không superuser, không BYPASSRLS; xem docs/DEPLOYMENT.md). DIRECT_URL (owner) chỉ dành cho migrate/seed.',
  );
  exit(1);
}

/**
 * Seed / công cụ vận hành chạy bằng OWNER trên Neon (owner KHÔNG phải superuser -> FORCE RLS chặn cả owner): mở phiên
 * với `app.rls_system=on` qua tham số khởi động `options=-c …`. CHỈ dùng với DIRECT_URL (pgbouncer không nhận options).
 */
export function withSystemRlsUrl(url: string): string {
  const u = new URL(url);
  const existing = u.searchParams.get('options');
  u.searchParams.set('options', `${existing ? existing + ' ' : ''}-c app.rls_system=on`);
  return u.toString();
}

/** QT2 (ADR-183): một dòng của truy vấn gộp job cập nhật nấc. */
export interface StorageTickRow {
  tenantId: string;
  usedBytes: number;
  level: string;
  calibratedBytes: number;
  calibratedAt: Date | null;
  /** `calibrated_at::text` (đủ µs) — khoá compare-and-set khi ghi nấc (review QT-S1 L1). */
  calibratedAtToken: string | null;
  freedSinceCalibration: number;
  bloatFactor: number;
  quotaMb: number | null;
  trafficBytesSinceCalibration: number;
}

interface IngestSourceRow {
  id: string;
  tenantId: string;
  provider: string;
  name: string;
  sourceKey: string;
  isActive: boolean;
  verificationConfig: Prisma.JsonValue | null;
  archivedAt: Date | null;
  keepLonger: boolean;
  createdAt: Date;
  storageLevel: string | null;
}

/**
 * Source nạp ở bước 2 của ingest (cùng hình dạng `Source` của Prisma + secrets còn hiệu lực) kèm `storageLevel` (QT3, E4):
 * nấc dung lượng của project, JOIN trong cùng câu. null = chưa đo (coi như OK).
 */
export type IngestSource = Source & { secrets: SourceSecret[]; storageLevel: string | null };

/** QT5: một project có policy dọn tự động đang bật (đọc xuyên project cho cleanup job). */
export interface StorageAutoCleanTarget {
  tenantId: string;
  quotaMb: number | null;
  usedBytes: number;
  policies: { importance: string; action: string; afterDays: number; trigger: string }[];
}
