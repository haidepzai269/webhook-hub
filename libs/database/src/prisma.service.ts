import { PrismaClient, Prisma } from '@prisma/client';
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
  public async findSourceBySourceKeyForIngest(sourceKey: string) {
    // AU6: chưa biết tenant (chính bước này tìm ra tenant) -> đường hệ thống. Đường NÓNG của ingest: dùng batch
    // transaction (set_config + SELECT gửi một lượt) thay vì transaction tương tác — p95 ingest (ADR-108).
    const [, source] = await this.client.$transaction([
      this.client.$executeRaw`SELECT set_config('app.rls_system', 'on', true)`,
      this.client.source.findUnique({
        where: { sourceKey },
        include: {
          secrets: {
            where: {
              OR: [{ validUntil: null }, { validUntil: { gt: new Date() } }],
            },
          },
        },
      }),
    ]);
    return source;
  }

  /**
   * Escape hatch HẠ TẦNG cho retention (S7, DINH-CHINH §3, ADR-077): xoá MỘT lô `events` có `received_at` cũ
   * hơn `olderThanSeconds`, XUYÊN project (job cleanup không thuộc tenant nào). FK CASCADE kéo theo
   * `deliveries` -> `delivery_attempts`. KHÔNG đụng `raw_events` (ACCEPTED giữ vô hạn, ADR-045). Chỉ CleanupJob gọi.
   */
  public deleteExpiredEventsBatch(olderThanSeconds: number, limit: number): Promise<number> {
    return this.systemTx('cleanup: retention events', (tx) => tx.$executeRaw`
      DELETE FROM "hub"."events" WHERE id IN (
        SELECT id FROM "hub"."events"
        WHERE received_at < now() - make_interval(secs => ${olderThanSeconds}::double precision)
        LIMIT ${limit})`);
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
   * Tóm tắt cho chuông: tổng OPEN theo mức + chưa xem tính trên TOÀN bảng (không trần), và chi tiết theo từng project
   * (chỉ project có cảnh báo OPEN, tối đa `limit` project — tổng không phụ thuộc trần này).
   */
  public operatorAlertSummaryAcrossTenants(limit = 500): Promise<OperatorAlertSummary> {
    return this.systemTx('operator: tóm tắt alerts xuyên project', async (tx) => {
      const [t] = await tx.$queryRaw<{ critical: bigint; warning: bigint; info: bigint; unacked: bigint }[]>(Prisma.sql`
        SELECT count(*) FILTER (WHERE severity = 'critical') AS critical,
               count(*) FILTER (WHERE severity = 'warning')  AS warning,
               count(*) FILTER (WHERE severity = 'info')     AS info,
               count(*) FILTER (WHERE acknowledged_at IS NULL) AS unacked
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
        totals: { critical: Number(t?.critical ?? 0), warning: Number(t?.warning ?? 0), info: Number(t?.info ?? 0), unacked: Number(t?.unacked ?? 0) },
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

  /** ack-all không chỉ định project: MỌI tenant còn cảnh báo OPEN chưa xem (mở trước `asOf` nếu có) — không trần. */
  public async operatorAlertsUnackedTenants(asOf?: Date): Promise<string[]> {
    const rows = await this.systemTx('operator: tenant còn alert chưa xem', (tx) =>
      tx.$queryRaw<{ tenantId: string }[]>(Prisma.sql`
        SELECT DISTINCT tenant_id AS "tenantId" FROM hub.alerts
        WHERE state = 'OPEN' AND acknowledged_at IS NULL ${asOf ? Prisma.sql`AND opened_at <= ${asOf}` : Prisma.empty}`),
    );
    return rows.map((r) => r.tenantId);
  }

  /** Bước XÁC ĐỊNH tenant của một cảnh báo (ack theo id từ chuông xuyên project). Không có -> null (route trả 404). */
  public async operatorFindAlertTenant(alertId: string): Promise<string | null> {
    const rows = await this.systemTx('operator: tra tenant của alert', (tx) =>
      tx.$queryRaw<{ tenantId: string }[]>(Prisma.sql`SELECT tenant_id AS "tenantId" FROM hub.alerts WHERE id = ${alertId}::uuid`),
    );
    return rows[0]?.tenantId ?? null;
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
  totals: { critical: number; warning: number; info: number; unacked: number };
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
