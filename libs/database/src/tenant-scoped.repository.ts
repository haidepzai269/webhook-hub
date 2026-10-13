import { BUCKET_MAX_AGE_DAYS, DEFAULT_STORAGE_POLICIES, eventTypeCandidates, levelFor, parseStorageLevel } from '@hub/common';
import { PrismaClient, Destination, Delivery, Prisma, CircuitState, Source, SourceSecret } from '@prisma/client';

/**
 * `PrismaClient` gốc HOẶC `Prisma.TransactionClient` (bên trong một `$transaction`
 * interactive) — cho phép dựng `TenantScopedRepository` ngay trong `tx` callback khi
 * tenant đã biết (ví dụ NormalizeConsumer), thay vì gọi thẳng `tx.subscription...`.
 */
type PrismaClientOrTx = PrismaClient | Prisma.TransactionClient;

/** Phương thức đồng bộ — KHÔNG bọc transaction (trả về ngay). Mọi phương thức khác của repo là async. */
const SYNC_METHODS = new Set(['constructor', 'extend']);
/**
 * R2-M1 (review DX-A vòng 2): phương thức ĐIỀU PHỐI — proxy KHÔNG bọc chúng trong một transaction; chúng chạy với
 * `this` = proxy nên MỖI lời gọi repo bên trong là một transaction riêng (có `app.project_id`, RLS, advisory lock riêng).
 * Chỉ được gọi phương thức repo khác, KHÔNG đụng `this.prisma` trực tiếp (sẽ là client trần, không scope).
 */
const ORCHESTRATED_METHODS = new Set(['latestPollCursor']);

/**
 * R3-M1 (review DX-A vòng 3): `this` của phương thức điều phối — gọi phương thức repo đi qua proxy như thường, nhưng ĐỌC
 * `this.prisma` thì NÉM (client gốc ở đó chưa đặt `app.project_id`: dưới hub_app RLS trả rỗng -> cursor 0 / dội lịch sử
 * mà không ai biết). Chỉ áp cho ORCHESTRATED_METHODS; phương thức khác không đổi.
 */
function orchestratorView<T extends object>(repoProxy: T, method: string): T {
  return new Proxy(repoProxy, {
    get(target, prop, receiver) {
      if (prop === 'prisma') {
        throw new Error(
          `TenantScopedRepository.${method} is an ORCHESTRATED method: it must not touch this.prisma (unscoped root client) — call other repository methods instead`,
        );
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

/**
 * R-4 (review AU, ADR-119): phương thức NÓNG của đường giao, mỗi cái là MỘT câu truy vấn trả `PrismaPromise` (lười, KHÔNG
 * `async`). Trên client gốc chạy bằng batch transaction `[set_config, truy vấn]` — một lần gửi thay vì transaction tương
 * tác (BEGIN, set_config, truy vấn, COMMIT là 4 lượt) — giống tra source lúc ingest (ADR-108).
 */
const BATCH_METHODS = new Set(['findDeliveryForSend', 'claimForSend', 'getDeliveryLeaseState']);
const batchEnabled = () => process.env.RLS_HOT_BATCH !== '0';

/** Transaction nào đã đặt `app.project_id` cho tenant nào (đặt lại nếu cùng tx đổi tenant — vô hại, set_config ghi đè). */
const txTenant = new WeakMap<object, string>();

function isRootClient(c: PrismaClientOrTx): c is PrismaClient {
  return typeof (c as { $transaction?: unknown }).$transaction === 'function';
}

/** Đặt app.project_id (LOCAL). Client không có `$executeRaw` chỉ là test double (Prisma thật luôn có) -> bỏ qua. */
async function setProject(c: PrismaClientOrTx, tenantId: string): Promise<void> {
  if (typeof (c as { $executeRaw?: unknown }).$executeRaw !== 'function') return;
  await c.$executeRaw`SELECT set_config('app.project_id', ${tenantId}, true)`;
}

/**
 * AU6 (SPEC-auth §5.12.5, ADR-108): MỌI phương thức của repo chạy với `app.project_id = tenantId` đặt LOCAL —
 * RLS của Postgres là lớp thứ ba, bắt được cả khi một câu SQL trong repo quên `tenant_id` (BB-5).
 * - client gốc: mỗi lời gọi phương thức = MỘT transaction tương tác `set_config` + thân phương thức; lời gọi lồng
 *   bên trong (`this.x()`) chạy trên CÙNG transaction (bản sao repo có `prisma = tx`, không qua proxy);
 * - trong `tx` có sẵn: đặt một lần cho tx đó trước truy vấn đầu tiên của repo (không lồng transaction).
 * Áp cho cả lớp con (FlowScopedRepository) vì proxy bọc theo prototype của chính đối tượng.
 */
function scopeToTenant<T extends TenantScopedRepository>(repo: T): T {
  return new Proxy(repo, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function' || typeof prop !== 'string' || SYNC_METHODS.has(prop) || Object.prototype.hasOwnProperty.call(Object.prototype, prop)) {
        return value;
      }
      if (ORCHESTRATED_METHODS.has(prop)) return (value as (...a: unknown[]) => unknown).bind(orchestratorView(receiver as T, prop));
      const client = (target as unknown as { prisma: PrismaClientOrTx }).prisma;
      const tenantId = target.tenantId;
      if (isRootClient(client) && BATCH_METHODS.has(prop) && batchEnabled() && typeof client.$executeRaw === 'function') {
        return (...args: unknown[]) => {
          const query = (value as (...a: unknown[]) => Prisma.PrismaPromise<unknown>).apply(target, args);
          return client
            .$transaction([client.$executeRaw`SELECT set_config('app.project_id', ${tenantId}, true)`, query])
            .then((r) => r[1]);
        };
      }
      if (isRootClient(client)) {
        return (...args: unknown[]) =>
          client.$transaction(async (tx) => {
            await setProject(tx, tenantId);
            txTenant.set(tx, tenantId);
            const inner = Object.create(Object.getPrototypeOf(target), Object.getOwnPropertyDescriptors(target));
            Object.defineProperty(inner, 'prisma', { value: tx });
            return (value as (...a: unknown[]) => unknown).apply(inner, args);
          });
      }
      return async (...args: unknown[]) => {
        if (txTenant.get(client) !== tenantId) {
          await setProject(client, tenantId);
          txTenant.set(client, tenantId);
        }
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}

export class TenantScopedRepository {
  constructor(
    // protected (không public): chỉ lớp con — vẫn bị ràng buộc tenantId ở constructor — dùng được (R-9).
    protected readonly prisma: PrismaClientOrTx,
    public readonly tenantId: string,
  ) {
    if (!tenantId) {
      throw new Error('TenantScopedRepository: tenantId là bắt buộc (BB-5 vi phạm)');
    }
    // AU6: trả về proxy — mọi phương thức chạy với app.project_id đã đặt (RLS).
    return scopeToTenant(this);
  }

  /**
   * R-9 (review MS-UI): dựng một repo CON (lớp kế thừa TenantScopedRepository, vd FlowScopedRepository của
   * module flow) trên CÙNG client và CÙNG tenant của repo này. Lối duy nhất có tên để mở rộng repo mà không
   * chạm client gốc — thay cho ép kiểu vào field private. Tenant không đổi được (BB-5).
   */
  extend<T extends TenantScopedRepository>(Sub: new (prisma: PrismaClientOrTx, tenantId: string) => T): T {
    return new Sub(this.prisma, this.tenantId);
  }

  // --- Sources ---
  async findSources(where: Prisma.SourceWhereInput = {}) {
    return this.prisma.source.findMany({
      where: { ...where, tenantId: this.tenantId },
      include: { secrets: true },
    });
  }

  /**
   * ADR-161: mặc định BỎ QUA source đã lưu trữ (coi như không tồn tại -> 404 / từ chối). Chỉ màn lịch sử thật sự cần
   * mới truyền `{ includeArchived: true }`.
   */
  /**
   * QT3 (E4, ADR-182): `{ withStorageLevel: true }` (đường publish `/v1/p`) — MỘT câu `sources LEFT JOIN project_usage`
   * trả source (không secrets — publish không verify) kèm `storageLevel` (null = chưa đo = OK). Ít câu hơn đường mặc định.
   */
  findSourceById(id: string, opts: ArchivedOpt & { withStorageLevel: true }): Promise<SourceWithStorageLevel | null>;
  findSourceById(id: string, opts?: ArchivedOpt): Promise<(Source & { secrets: SourceSecret[] }) | null>;
  async findSourceById(id: string, opts: ArchivedOpt & { withStorageLevel?: boolean } = {}): Promise<unknown> {
    if (opts.withStorageLevel) {
      const archived = opts.includeArchived ? Prisma.empty : Prisma.sql`AND s.archived_at IS NULL`;
      const rows = await this.prisma.$queryRaw<SourceWithStorageLevel[]>(Prisma.sql`
        SELECT s.id, s.tenant_id AS "tenantId", s.provider::text AS provider, s.name, s.source_key AS "sourceKey",
               s.is_active AS "isActive", s.verification_config AS "verificationConfig", s.archived_at AS "archivedAt",
               s.keep_longer AS "keepLonger", s.created_at AS "createdAt", pu.level AS "storageLevel"
        FROM hub.sources s LEFT JOIN hub.project_usage pu ON pu.tenant_id = s.tenant_id
        WHERE s.id = ${id}::uuid AND s.tenant_id = ${this.tenantId}::uuid ${archived}`);
      return rows[0] ?? null;
    }
    return this.prisma.source.findFirst({
      where: { id, tenantId: this.tenantId, ...notArchived(opts) },
      include: { secrets: true },
    });
  }

  async createSource(data: Omit<Prisma.SourceUncheckedCreateInput, 'tenantId'>) {
    return this.prisma.source.create({
      data: { ...data, tenantId: this.tenantId },
      include: { secrets: true },
    });
  }

  /** ADR-161: source đã lưu trữ coi như không còn — không sửa/bật lại được (trả null -> 404). */
  async updateSource(id: string, data: Pick<Prisma.SourceUncheckedUpdateInput, 'name' | 'isActive' | 'keepLonger'>) {
    const result = await this.prisma.source.updateMany({ where: { id, tenantId: this.tenantId, archivedAt: null }, data });
    if (result.count !== 1) return null;
    return this.findSourceById(id);
  }

  /**
   * QT9 (§10, Q11): đếm source CHƯA lưu trữ sau khi khoá theo project trong transaction HIỆN TẠI (advisory xact lock, như
   * `lockAndCountOwnedProjects`) — hai request tạo source song song không vượt trần. PHẢI gọi trên repo dựng trong `tx`
   * (`forTenant(id, tx)`): trên client gốc mỗi lời gọi là một transaction riêng nên khoá nhả ngay.
   */
  async lockAndCountActiveSources(): Promise<number> {
    await this.prisma.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'source-create:' + this.tenantId}, 0))`;
    return this.prisma.source.count({ where: { tenantId: this.tenantId, archivedAt: null } });
  }

  async countSources(where: Prisma.SourceWhereInput = {}) {
    return this.prisma.source.count({
      where: { ...where, tenantId: this.tenantId },
    });
  }

  /**
   * KN2 (ADR-138): thêm SourceSecret version mới (max+1) cho source CỦA tenant này. `retireOthersAt` -> các version đang
   * hiệu lực hết hạn lúc đó (thời gian chồng: cả hai cùng verify trong lúc chuyển). Source khác tenant -> null.
   */
  async addSourceSecret(sourceId: string, secretEncrypted: string, retireOthersAt?: Date) {
    const source = await this.prisma.source.findFirst({ where: { id: sourceId, tenantId: this.tenantId }, include: { secrets: true } });
    if (!source) return null;
    if (retireOthersAt) {
      await this.prisma.sourceSecret.updateMany({
        where: { sourceId, OR: [{ validUntil: null }, { validUntil: { gt: retireOthersAt } }] },
        data: { validUntil: retireOthersAt },
      });
    }
    const version = Math.max(0, ...source.secrets.map((x) => x.version)) + 1;
    return this.prisma.sourceSecret.create({ data: { sourceId, secretEncrypted, version } });
  }

  /**
   * H-R2-1 (ADR-152): hẹn hết hạn ĐÚNG các version liệt kê (đang hiện hành) của source CỦA tenant này — dùng khi đã có
   * bằng chứng (webhook thật verify bằng secret khác). Source khác tenant -> 0.
   */
  async retireSourceSecretVersions(sourceId: string, versions: number[], at: Date) {
    if (versions.length === 0) return 0;
    const source = await this.prisma.source.findFirst({ where: { id: sourceId, tenantId: this.tenantId }, select: { id: true } });
    if (!source) return 0;
    const r = await this.prisma.sourceSecret.updateMany({ where: { sourceId, version: { in: versions }, validUntil: null }, data: { validUntil: at } });
    return r.count;
  }

  // --- Source connections (KN2, ADR-138) — credentials_encrypted chỉ đọc ở service, không bao giờ ra API ---
  async findSourceConnection(sourceId: string) {
    return this.prisma.sourceConnection.findFirst({ where: { sourceId, tenantId: this.tenantId } });
  }

  async createSourceConnection(data: Omit<Prisma.SourceConnectionUncheckedCreateInput, 'tenantId'>) {
    return this.prisma.sourceConnection.create({ data: { ...data, tenantId: this.tenantId } });
  }

  async updateSourceConnection(sourceId: string, data: Prisma.SourceConnectionUncheckedUpdateInput) {
    const r = await this.prisma.sourceConnection.updateMany({ where: { sourceId, tenantId: this.tenantId }, data });
    if (r.count !== 1) return null;
    return this.findSourceConnection(sourceId);
  }

  /**
   * L-R3-1: cập nhật kiểu compare-and-set — chỉ khi dòng vẫn đúng `status` + `updatedAt` đã đọc (không có lượt
   * connect/retry nào ghi xen giữa). Thua -> null (người gọi đọc lại bản mới nhất, không ghi đè).
   */
  async updateSourceConnectionIf(sourceId: string, expected: { status: any; updatedAt: Date }, data: Prisma.SourceConnectionUncheckedUpdateInput) {
    const r = await this.prisma.sourceConnection.updateMany({
      where: { sourceId, tenantId: this.tenantId, status: expected.status, updatedAt: expected.updatedAt },
      data,
    });
    if (r.count !== 1) return null;
    return this.findSourceConnection(sourceId);
  }

  /**
   * L-3 (REVIEW-KN): "giành" kết nối để gọi provider — chỉ cập nhật khi KHÔNG có lượt khác đang PENDING (PENDING cập nhật
   * trước `staleBefore` coi là kẹt, cho chạy lại). Một câu UPDATE có điều kiện = nguyên tử, hai lượt bấm cùng lúc chỉ một
   * lượt thắng. Không giành được (đang PENDING, hoặc source không thuộc tenant) -> null.
   */
  async claimSourceConnection(sourceId: string, staleBefore: Date, data: Prisma.SourceConnectionUncheckedUpdateInput) {
    const r = await this.prisma.sourceConnection.updateMany({
      where: { sourceId, tenantId: this.tenantId, OR: [{ status: { not: 'PENDING' } }, { updatedAt: { lt: staleBefore } }] },
      data: { ...data, status: 'PENDING' },
    });
    if (r.count !== 1) return null;
    return this.findSourceConnection(sourceId);
  }

  // --- Destinations ---
  async findDestinations(where: Prisma.DestinationWhereInput = {}) {
    return this.prisma.destination.findMany({
      where: { ...where, tenantId: this.tenantId },
    });
  }

  /** ADR-161: mặc định bỏ qua đích đã lưu trữ — xem `findSourceById`. */
  async findDestinationById(id: string, opts: ArchivedOpt = {}) {
    return this.prisma.destination.findFirst({
      where: { id, tenantId: this.tenantId, ...notArchived(opts) },
    });
  }

  async createDestination(data: Omit<Prisma.DestinationUncheckedCreateInput, 'tenantId'>) {
    return this.prisma.destination.create({
      data: { ...data, tenantId: this.tenantId },
    });
  }

  /**
   * Update có scope tenant, atomic ở tầng SQL: `updateMany({ where: { id, tenantId } })`
   * thay vì "findFirst scoped rồi update theo id" (2 câu lệnh rời có khe hở TOCTOU lý
   * thuyết). `updateMany` không trả về bản ghi — đọc lại bằng `findFirst` sau khi xác
   * nhận `count === 1` để giữ nguyên interface trả về (Destination | null).
   */
  async updateDestination(id: string, data: Prisma.DestinationUncheckedUpdateInput): Promise<Destination | null> {
    const result = await this.prisma.destination.updateMany({
      // ADR-161: đích đã lưu trữ không sửa/bật lại được (null -> 404).
      where: { id, tenantId: this.tenantId, archivedAt: null },
      data,
    });
    if (result.count !== 1) return null;
    return this.findDestinationById(id);
  }

  /**
   * S2-1: ghi `circuit_state` CHỈ khi khác giá trị mới (`circuit_state <> to`). Nhiều worker cùng
   * thấy một lần đổi trạng thái thì chỉ một bên đổi được dòng (trả 1) — bên đó mới phát realtime.
   * Cột này chỉ để hiển thị; Redis là nguồn chạy.
   */
  async updateDestinationCircuitState(id: string, state: CircuitState): Promise<number> {
    const result = await this.prisma.destination.updateMany({
      where: { id, tenantId: this.tenantId, circuitState: { not: state } },
      data: { circuitState: state },
    });
    return result.count;
  }

  /** Xoá đích. FK RESTRICT (ADR-054): còn subscription thì DB ném P2003. Trả số dòng đã xoá (0 = không thuộc tenant). */
  async deleteDestination(id: string): Promise<number> {
    const result = await this.prisma.destination.deleteMany({ where: { id, tenantId: this.tenantId } });
    return result.count;
  }

  async countDestinations(where: Prisma.DestinationWhereInput = {}) {
    return this.prisma.destination.count({
      where: { ...where, tenantId: this.tenantId },
    });
  }

  // --- Subscriptions ---
  async findSubscriptions(where: Prisma.SubscriptionWhereInput = {}) {
    return this.prisma.subscription.findMany({
      where: { ...where, tenantId: this.tenantId },
      include: { destination: true },
    });
  }

  /** ADR-161: mặc định bỏ qua subscription đã lưu trữ — xem `findSourceById`. */
  async findSubscriptionById(id: string, opts: ArchivedOpt = {}) {
    return this.prisma.subscription.findFirst({
      where: { id, tenantId: this.tenantId, ...notArchived(opts) },
      include: { destination: true },
    });
  }

  /**
   * Lọc thêm `destination.tenantId` (S1-5): phòng thủ chiều sâu — dữ liệu cũ có thể đã có
   * subscription trỏ sang đích của tenant khác (trước khi API kiểm). Không `include` đích:
   * normalize chỉ cần id subscription, cấu hình đích do worker nạp lúc gửi (S1-1).
   */
  /**
   * S3-3: khớp chính xác HOẶC theo mẫu (`payment.*`, `*`). Sinh danh sách ứng viên từ kiểu của event
   * (`a.b.c` -> `a.b.c, a.b.*, a.*, *`) rồi hỏi `eventTypes && candidates` — một truy vấn, không quét
   * mọi subscription trong bộ nhớ.
   */
  async findActiveSubscriptionsForEventType(eventType: string) {
    return this.prisma.subscription.findMany({
      where: {
        tenantId: this.tenantId,
        isActive: true,
        archivedAt: null,
        eventTypes: { hasSome: eventTypeCandidates(eventType) },
        // ADR-161: đích đã "Ngắt" (is_active=false) hoặc lưu trữ không nhận delivery mới.
        destination: { tenantId: this.tenantId, isActive: true, archivedAt: null },
      },
      // Chỉ id/name/type để realtime `event.received` vẽ được N nhánh (S2-2) — KHÔNG đọc cấu hình mã hoá.
      include: { destination: { select: { id: true, name: true, type: true } } },
    });
  }

  /**
   * S5 (SPEC §4.6): như `findActiveSubscriptionsForEventType` + lọc nguồn — `sourceIds` rỗng = mọi source của
   * project, có giá trị = chỉ event từ các source đó. Event không rõ source (dữ liệu cũ) chỉ khớp sub không lọc.
   * Hàm cũ GIỮ NGUYÊN cho module flow của nhánh UI (X16/X17); normalize dùng hàm này.
   */
  async findActiveSubscriptionsForEvent(eventType: string, sourceId: string | null) {
    const anySource: Prisma.SubscriptionWhereInput = { sourceIds: { isEmpty: true } };
    return this.prisma.subscription.findMany({
      where: {
        tenantId: this.tenantId,
        isActive: true,
        archivedAt: null,
        eventTypes: { hasSome: eventTypeCandidates(eventType) },
        // ADR-161: đích đã "Ngắt" (is_active=false) hoặc lưu trữ không nhận delivery mới.
        destination: { tenantId: this.tenantId, isActive: true, archivedAt: null },
        OR: sourceId ? [anySource, { sourceIds: { has: sourceId } }] : [anySource],
      },
      include: { destination: { select: { id: true, name: true, type: true, verification: true } } },
    });
  }

  /** S5: id nào trong danh sách KHÔNG phải source của project này (kiểm `sourceIds` của subscription). */
  async findForeignSourceIds(ids: string[]): Promise<string[]> {
    if (ids.length === 0) return [];
    // ADR-161: source đã lưu trữ coi như không thuộc project nữa (không ghim subscription mới vào nó).
    const own = await this.prisma.source.findMany({ where: { id: { in: ids }, tenantId: this.tenantId, archivedAt: null }, select: { id: true } });
    const ok = new Set(own.map((s) => s.id));
    return ids.filter((id) => !ok.has(id));
  }

  async updateSubscription(id: string, data: Prisma.SubscriptionUncheckedUpdateInput) {
    // ADR-161: subscription đã lưu trữ không sửa/bật lại được (null -> 404).
    const result = await this.prisma.subscription.updateMany({ where: { id, tenantId: this.tenantId, archivedAt: null }, data });
    if (result.count !== 1) return null;
    return this.findSubscriptionById(id);
  }

  /**
   * ADR-161: "Xoá" trên bản đồ luồng = LƯU TRỮ — đặt `archived_at` + `is_active=false`, KHÔNG DELETE (deliveries /
   * attempts / raw_events là bằng chứng đối soát, ADR-054). Chỉ dòng chưa lưu trữ; trả số dòng đổi (0 = không có /
   * đã lưu trữ / tenant khác).
   */
  async archiveSource(id: string, at: Date): Promise<number> {
    return (await this.prisma.source.updateMany({ where: { id, tenantId: this.tenantId, archivedAt: null }, data: { archivedAt: at, isActive: false } })).count;
  }

  async archiveDestination(id: string, at: Date): Promise<number> {
    return (await this.prisma.destination.updateMany({ where: { id, tenantId: this.tenantId, archivedAt: null }, data: { archivedAt: at, isActive: false } })).count;
  }

  /**
   * ADR-161 (T2): khoá cấu hình luồng của tenant đến hết transaction hiện tại (`pg_advisory_xact_lock`, xact-level —
   * an toàn với pgbouncer transaction mode). Lưu trữ source/đích và tạo/sửa subscription đều lấy khoá này trước khi
   * đọc-kiểm-ghi, nên cascade lưu trữ thấy một tập subscription nhất quán và không subscription nào gắn vào mục vừa bị
   * lưu trữ. CHỈ có nghĩa khi gọi trên repo của một transaction (`withAudit`).
   */
  async lockFlowConfig(): Promise<void> {
    if (typeof (this.prisma as { $executeRaw?: unknown }).$executeRaw !== 'function') return; // test double
    await this.prisma.$executeRaw`SELECT pg_advisory_xact_lock(4243, hashtext(${this.tenantId}))`;
  }

  /** ADR-161 (T4): gỡ source đã lưu trữ khỏi `sourceIds` của các subscription còn sống (array_remove), scope tenant. */
  async removeSourceFromSubscriptions(sourceId: string): Promise<number> {
    return this.prisma.$executeRaw`
      UPDATE "hub"."subscriptions" SET source_ids = array_remove(source_ids, ${sourceId}::uuid)
      WHERE tenant_id = ${this.tenantId}::uuid AND archived_at IS NULL AND ${sourceId}::uuid = ANY(source_ids)`;
  }

  async archiveSubscriptions(ids: string[], at: Date): Promise<number> {
    if (ids.length === 0) return 0;
    return (
      await this.prisma.subscription.updateMany({ where: { id: { in: ids }, tenantId: this.tenantId, archivedAt: null }, data: { archivedAt: at, isActive: false } })
    ).count;
  }

  /**
   * ADR-161: subscription còn sống sẽ thành cạnh treo khi lưu trữ `ref`: mọi sub của đích đó; với source — sub có lọc
   * nguồn mà SAU khi bỏ source này không còn source sống nào trong `sourceIds` (sub `sourceIds` rỗng = mọi source,
   * không bị ảnh hưởng; sub lọc nhiều nguồn còn nguồn khác sống thì giữ).
   */
  async findSubscriptionIdsOrphanedBy(ref: { destinationId: string } | { sourceId: string }): Promise<string[]> {
    if ('destinationId' in ref) {
      const rows = await this.prisma.subscription.findMany({ where: { tenantId: this.tenantId, destinationId: ref.destinationId, archivedAt: null }, select: { id: true } });
      return rows.map((r) => r.id);
    }
    const subs = await this.prisma.subscription.findMany({
      where: { tenantId: this.tenantId, archivedAt: null, sourceIds: { has: ref.sourceId } },
      select: { id: true, sourceIds: true },
    });
    const others = [...new Set(subs.flatMap((s) => s.sourceIds.filter((x) => x !== ref.sourceId)))];
    const live = others.length
      ? new Set(
          (await this.prisma.source.findMany({ where: { id: { in: others }, tenantId: this.tenantId, archivedAt: null }, select: { id: true } })).map((s) => s.id),
        )
      : new Set<string>();
    return subs.filter((s) => !s.sourceIds.some((x) => x !== ref.sourceId && live.has(x))).map((s) => s.id);
  }

  async deleteSubscription(id: string): Promise<number> {
    const result = await this.prisma.subscription.deleteMany({ where: { id, tenantId: this.tenantId } });
    return result.count;
  }

  async createSubscription(data: Omit<Prisma.SubscriptionUncheckedCreateInput, 'tenantId'>) {
    return this.prisma.subscription.create({
      data: { ...data, tenantId: this.tenantId },
      include: { destination: true },
    });
  }

  async countSubscriptions(where: Prisma.SubscriptionWhereInput = {}) {
    return this.prisma.subscription.count({
      where: { ...where, tenantId: this.tenantId },
    });
  }

  // --- Events ---
  async findEvents(where: Prisma.EventWhereInput = {}, take = 50, cursor?: string) {
    return this.prisma.event.findMany({
      where: { ...where, tenantId: this.tenantId },
      take,
      skip: cursor ? 1 : 0,
      cursor: cursor ? { id: cursor } : undefined,
      orderBy: { receivedAt: 'desc' },
      include: { deliveries: true },
    });
  }

  /**
   * R-3 (ADR-095, thay cửa sổ lắng ADR-077): cursor = `poll_seq`, cấp theo THỨ TỰ COMMIT. Bước 1 (`assignPollSeq`):
   * một transaction ngắn giữ `pg_advisory_xact_lock` theo tenant, UPDATE gán `poll_seq` cho các dòng ĐÃ COMMIT còn
   * NULL (READ COMMITTED: dòng của transaction đang mở không thấy -> chưa được gán). Các lần gán nối tiếp nhau nên giá
   * trị gán sau luôn lớn hơn mọi giá trị đã thấy: transaction commit muộn nhận poll_seq MỚI, không bao giờ bị cursor
   * vượt qua. Bước 2: đọc `poll_seq > after`. Không có độ trễ 2s, 0 lệnh Redis. API gọi trường này là `cursor` (R2-3).
   * `types` và `readTypes` (mẫu wildcard) là hai điều kiện AND. `failedOnly`: có delivery DEAD/RETRYING ở generation
   * MỚI NHẤT của cặp (event, subscription) [tới `endpointId` nếu có]. KQ1: event `probe` (request kiểm tra của provider)
   * không bao giờ trả — vẫn được cấp poll_seq (cursor chỉ là vị trí, không lộ nội dung).
   */
  async pollEvents(o: PollEventsOptions): Promise<PolledEvent[]> {
    await this.assignPollSeq();
    const failed = o.failedOnly
      ? Prisma.sql`AND EXISTS (
          SELECT 1 FROM "hub"."deliveries" d JOIN "hub"."subscriptions" s ON s.id = d.subscription_id
          WHERE d.event_id = e.id AND d.tenant_id = e.tenant_id AND d.status IN ('DEAD', 'RETRYING')
          ${o.endpointId ? Prisma.sql`AND s.destination_id = ${o.endpointId}::uuid` : Prisma.empty}
          AND NOT EXISTS (SELECT 1 FROM "hub"."deliveries" d2 WHERE d2.event_id = d.event_id
                          AND d2.subscription_id = d.subscription_id AND d2.attempt_generation > d.attempt_generation))`
      : Prisma.empty;
    return this.prisma.$queryRaw<PolledEvent[]>`
      SELECT e.id, e.poll_seq AS cursor, e.type, e.source, e.source_id AS "sourceId", e.subject,
             -- QT:T20 (ADR-184): event đã "Dọn" -> data null + trimmed true (dòng gầy vẫn trả: cursor không có lỗ).
             CASE WHEN e.trimmed_at IS NULL THEN e.data ELSE NULL END AS data, (e.trimmed_at IS NOT NULL) AS trimmed, e.normalized,
             e.correlation_id AS "correlationId", e.occurred_at AS "occurredAt", e.received_at AS "receivedAt"
      FROM "hub"."events" e
      WHERE e.tenant_id = ${this.tenantId}::uuid
        AND e.poll_seq > ${o.after}
        AND NOT e.probe
        AND ${typeFilterSql(o.types)} AND ${typeFilterSql(o.readTypes)}
        ${failed}
      ORDER BY e.poll_seq ASC
      LIMIT ${o.limit}`;
  }

  /**
   * DX3 (`?after=latest`, SPEC-dev-experience §4.5): cursor lớn nhất ĐÃ CẤP của tenant, sau khi cấp cho mọi event đã
   * COMMIT (cùng `assignPollSeq` với pollEvents) -> event commit SAU lần gọi này luôn có cursor lớn hơn, không bị bỏ
   * sót. Chưa có event nào -> 0n. Không lọc theo types/readTypes: cursor chỉ là vị trí, không lộ nội dung.
   *
   * M-1 (review DX-A): project chỉ dùng push (vd Shop) tích luỹ event `poll_seq IS NULL` (chỉ cấp khi có người poll).
   * Trần `maxRounds` lô × `batch` dòng mỗi request (mặc định 10 × 1000): còn tồn sau trần -> `null` (CHƯA xong — controller
   * trả 503 + retryAfter, client gọi lại và tiến tiếp). KHÔNG trả max tạm: event tồn cấp sau sẽ có cursor lớn hơn và bị coi
   * là "mới" (dội lịch sử).
   * R2-M1: phương thức ĐIỀU PHỐI (ORCHESTRATED_METHODS) — mỗi `assignPollSeq` là MỘT transaction riêng qua proxy (đặt
   * `app.project_id`, advisory lock theo tenant chỉ giữ trong lô đó, commit ngay) -> không có tx dài 10 lô chạm timeout
   * 5 s của Prisma, poller cùng tenant chỉ chờ một lô. Gọi trong tx có sẵn thì vẫn chạy trong tx đó (không tránh được).
   */
  async latestPollCursor(opts: { maxRounds?: number; batch?: number } = {}): Promise<bigint | null> {
    const maxRounds = opts.maxRounds ?? 10;
    const batch = opts.batch ?? 1000;
    let rounds = 0;
    let n: number;
    do {
      n = await this.assignPollSeq(batch);
      rounds++;
    } while (n >= batch && rounds < maxRounds);
    // Lô cuối đầy: có thể còn tồn -> kiểm rẻ (index một phần poll_seq IS NULL).
    if (n >= batch && (await this.hasUnassignedPollSeq())) return null;
    return this.maxPollCursor();
  }

  /** Còn event đã commit chưa có `poll_seq` (index một phần) — một câu, chạy trong tx có scope của proxy. */
  async hasUnassignedPollSeq(): Promise<boolean> {
    const [{ pending }] = await this.prisma.$queryRaw<{ pending: boolean }[]>`
      SELECT EXISTS (SELECT 1 FROM "hub"."events" WHERE tenant_id = ${this.tenantId}::uuid AND poll_seq IS NULL) AS pending`;
    return pending;
  }

  /** Cursor lớn nhất đã cấp của tenant (index `(tenant_id, poll_seq)`); chưa có -> 0n. */
  async maxPollCursor(): Promise<bigint> {
    const [{ max }] = await this.prisma.$queryRaw<{ max: bigint | null }[]>`
      SELECT max(poll_seq) AS max FROM "hub"."events" WHERE tenant_id = ${this.tenantId}::uuid`;
    return max ?? 0n;
  }

  /** R-3: gán `poll_seq` cho event đã commit của tenant (≤ 1000/lần), nối tiếp nhau nhờ advisory lock theo tenant. */
  async assignPollSeq(batch = 1000): Promise<number> {
    // R2-4: đa số lần poll (nhất là mỗi giây của long-poll) không có dòng mới -> một SELECT rẻ trên index một phần
    // (poll_seq IS NULL), không mở transaction ghi + advisory lock.
    const [{ pending }] = await this.prisma.$queryRaw<{ pending: boolean }[]>`
      SELECT EXISTS (SELECT 1 FROM "hub"."events" WHERE tenant_id = ${this.tenantId}::uuid AND poll_seq IS NULL) AS pending`;
    if (!pending) return 0;
    const lock = Prisma.sql`SELECT pg_advisory_xact_lock(4242, hashtext(${this.tenantId}))::text AS locked`;
    // nextval trong PHÉP CHIẾU trên subquery đã sắp theo seq -> trong cùng một lô, poll_seq giữ thứ tự seq.
    const assign = Prisma.sql`
      UPDATE "hub"."events" e SET poll_seq = t.ps
      FROM (SELECT o.id, nextval('"hub"."events_poll_seq"') AS ps
            FROM (SELECT id FROM "hub"."events" WHERE tenant_id = ${this.tenantId}::uuid AND poll_seq IS NULL
                  ORDER BY seq LIMIT ${batch}) o) t
      WHERE e.id = t.id`;
    const client = this.prisma as any;
    if (typeof client.$transaction === 'function') {
      const [, n] = await client.$transaction([client.$queryRaw(lock), client.$executeRaw(assign)]);
      return n as number;
    }
    // Đang ở trong một transaction có sẵn: lock xact giữ tới khi transaction đó kết thúc.
    await client.$queryRaw(lock);
    return client.$executeRaw(assign);
  }

  /** S7 (ADR-077): dashboard `?after=<seq>` — tăng dần theo seq (cùng nghĩa với polling, không cửa sổ lắng). */
  async findEventsAfterSeq(after: bigint, take = 50) {
    return this.prisma.event.findMany({
      where: { tenantId: this.tenantId, seq: { gt: after } },
      take,
      orderBy: { seq: 'asc' },
      include: { deliveries: true },
    });
  }

  async findEventById(id: string) {
    return this.prisma.event.findFirst({
      where: { id, tenantId: this.tenantId },
      include: {
        rawEvent: true,
        deliveries: {
          include: {
            attempts: { orderBy: { attemptNo: 'asc' } },
            subscription: { include: { destination: true } },
          },
        },
      },
    });
  }

  async createEvent(data: Omit<Prisma.EventUncheckedCreateInput, 'tenantId'>) {
    return this.prisma.event.create({
      data: { ...data, tenantId: this.tenantId },
    });
  }

  async countEvents(where: Prisma.EventWhereInput = {}) {
    return this.prisma.event.count({
      where: { ...where, tenantId: this.tenantId },
    });
  }

  // --- Deliveries ---
  async findDeliveries(where: Prisma.DeliveryWhereInput = {}, take = 50) {
    return this.prisma.delivery.findMany({
      where: { ...where, tenantId: this.tenantId },
      take,
      orderBy: { createdAt: 'desc' },
      include: {
        event: true,
        subscription: { include: { destination: true } },
        attempts: true,
      },
    });
  }

  /**
   * Lookup một delivery THEO SCOPE TENANT — dùng cho replay để chặn cross-tenant
   * (tenant A không thể đọc/replay delivery của tenant B chỉ bằng cách biết UUID).
   */
  async findDeliveryById(id: string) {
    return this.prisma.delivery.findFirst({
      where: { id, tenantId: this.tenantId },
      include: {
        event: true,
        subscription: { include: { destination: true } },
      },
    });
  }

  /**
   * DLQ = delivery DEAD **chưa bị replay**. Replay không sửa bản ghi cũ (giữ lịch sử thất bại)
   * mà tạo generation mới cho cùng (event, subscription) — nên bản DEAD nào đã có generation
   * cao hơn thì không còn "nằm trong DLQ" nữa. Self-join `NOT EXISTS` Prisma không diễn đạt
   * được → raw SQL lấy id (scope tenant), rồi đọc kèm quan hệ qua `findMany` như thường.
   */
  async findDeadDeliveries(take = 50) {
    const rows = await this.findDeadDeliveryRefs({}, take);
    if (rows.length === 0) return [];
    return this.findDeliveries({ id: { in: rows.map((r) => r.id) } }, take);
  }

  /**
   * Tập chọn của replay hàng loạt (S2-3): ĐÚNG điều kiện DLQ của ADR-031 (`DEAD` + `notSuperseded`,
   * dùng chung với `findDeadDeliveries`/`countDeadDeliveries`) cộng bộ lọc tuỳ chọn.
   * Trả tham chiếu đủ để dựng delivery mới, không trả cấu hình đích.
   */
  async findDeadDeliveryRefs(filter: DeadDeliveryFilter, take: number): Promise<DeadDeliveryRef[]> {
    const conds: Prisma.Sql[] = [];
    if (filter.destinationId) conds.push(Prisma.sql`AND s.destination_id = ${filter.destinationId}::uuid`);
    if (filter.from) conds.push(Prisma.sql`AND d.created_at >= ${filter.from}`);
    if (filter.to) conds.push(Prisma.sql`AND d.created_at <= ${filter.to}`);
    if (filter.errorContains) conds.push(Prisma.sql`AND d.last_error ILIKE ${'%' + escapeLike(filter.errorContains) + '%'}`);
    // ADR-163: CÙNG điều kiện "loại lỗi" với bảng DLQ (findDeliveryPage) — xem trước replay đếm đúng tập đang lọc.
    if (filter.errorKind) conds.push(Prisma.sql`AND ${errorKindSql(filter.errorKind)}`);
    // ADR-163 (M1): chạy thật replay hàng loạt = ĐÚNG tập id đã xem trước (kiểm lại DEAD/chưa bị thay/còn nơi nhận).
    if (filter.ids) conds.push(Prisma.sql`AND d.id = ANY(${filter.ids}::uuid[])`);
    // ADR-161 (T3): replay hàng loạt (xem trước + chạy thật dùng CÙNG điều kiện) bỏ subscription đã lưu trữ và đích
    // đã lưu trữ / đang "Ngắt" — replay tới đó vô nghĩa. Bảng DLQ (không cờ này) vẫn liệt kê để đối soát.
    if (filter.replayableOnly) {
      // ADR-163: + subscription đang bật — subscription tắt thì replay tới đó cũng vô nghĩa.
      conds.push(Prisma.sql`AND s.archived_at IS NULL AND s.is_active AND EXISTS (SELECT 1 FROM hub.destinations dst WHERE dst.id = s.destination_id
                            AND dst.tenant_id = s.tenant_id AND dst.archived_at IS NULL AND dst.is_active)`);
      // QT:T20 (ADR-184): event đã "Dọn" không còn nội dung — không replay được (409 `event_trimmed` ở replay đơn).
      conds.push(Prisma.sql`AND e.trimmed_at IS NULL`);
    }
    return this.prisma.$queryRaw<DeadDeliveryRef[]>(Prisma.sql`
      SELECT d.id, d.event_id AS "eventId", d.subscription_id AS "subscriptionId",
             d.attempt_generation AS "attemptGeneration", d.last_error AS "lastError",
             d.created_at AS "createdAt", e.correlation_id AS "correlationId", e.type AS "eventType",
             s.destination_id AS "destinationId"
      FROM hub.deliveries d
      JOIN hub.events e ON e.id = d.event_id AND e.tenant_id = d.tenant_id
      JOIN hub.subscriptions s ON s.id = d.subscription_id AND s.tenant_id = d.tenant_id
      WHERE d.tenant_id = ${this.tenantId}::uuid AND d.status = 'DEAD' AND ${notSuperseded}
      ${conds.length ? Prisma.join(conds, ' ') : Prisma.empty}
      ORDER BY d.created_at DESC
      LIMIT ${take}
    `);
  }

  /**
   * ADR-163 (M1): lý do từng id (đã xem trước) bị loại khỏi lượt chạy thật — theo đúng thứ tự kiểm của
   * `findDeadDeliveryRefs` + `replayableOnly`. Id không thuộc tenant này = `not_found` (không lộ sự tồn tại).
   */
  async findReplaySkipReasons(ids: string[]): Promise<{ id: string; reason: ReplaySkipReason }[]> {
    if (ids.length === 0) return [];
    const rows = await this.prisma.$queryRaw<{ id: string; dead: boolean; superseded: boolean; replayable: boolean; trimmed: boolean }[]>(Prisma.sql`
      SELECT d.id, d.status = 'DEAD' AS dead, NOT ${notSuperseded} AS superseded,
             (s.archived_at IS NULL AND s.is_active AND EXISTS (SELECT 1 FROM hub.destinations dst WHERE dst.id = s.destination_id
                AND dst.tenant_id = s.tenant_id AND dst.archived_at IS NULL AND dst.is_active)) AS replayable,
             EXISTS (SELECT 1 FROM hub.events e WHERE e.id = d.event_id AND e.tenant_id = d.tenant_id AND e.trimmed_at IS NOT NULL) AS trimmed
      FROM hub.deliveries d
      JOIN hub.subscriptions s ON s.id = d.subscription_id AND s.tenant_id = d.tenant_id
      WHERE d.tenant_id = ${this.tenantId}::uuid AND d.id = ANY(${ids}::uuid[])
    `);
    const byId = new Map(rows.map((r) => [r.id, r]));
    return ids.map((id) => {
      const r = byId.get(id);
      const reason: ReplaySkipReason = !r
        ? 'not_found'
        : !r.dead
          ? 'not_dead'
          : r.superseded
            ? 'already_replayed'
            : !r.replayable
              ? 'destination_unavailable'
              : r.trimmed
                ? 'event_trimmed'
                : 'already_replayed';
      return { id, reason };
    });
  }

  /**
   * ADR-163: MỘT trang deliveries (hoặc DLQ khi `dlq: true`) theo KEYSET `(created_at, id)` — không OFFSET.
   * Bước 1 (raw SQL, scope tenant): lọc + so sánh BỘ `(d.created_at, d.id) < / > cursor` (thế hoà cùng µs phân
   * định bằng id) + `LIMIT limit+1` -> id + mốc µs làm cursor. Bước 2: nạp quan hệ cho đúng các id đó, giữ thứ tự
   * bước 1. `dir: 'newer'` trả TĂNG dần sát cursor (gọi bên ngoài đảo lại) — đó là trang "Trước".
   */
  async findDeliveryPage(f: DeliveryPageFilter): Promise<{ rows: DeliveryPageRow[] }> {
    const conds: Prisma.Sql[] = [];
    if (f.dlq) conds.push(Prisma.sql`AND d.status = 'DEAD' AND ${notSuperseded}`);
    else if (f.status) conds.push(Prisma.sql`AND d.status::text = ${f.status}`);
    if (f.destinationId) {
      conds.push(Prisma.sql`AND EXISTS (SELECT 1 FROM hub.subscriptions s WHERE s.id = d.subscription_id
                            AND s.tenant_id = d.tenant_id AND s.destination_id = ${f.destinationId}::uuid)`);
    }
    if (f.from) conds.push(Prisma.sql`AND d.created_at >= ${f.from}`);
    if (f.to) conds.push(Prisma.sql`AND d.created_at <= ${f.to}`);
    if (f.httpCode) conds.push(Prisma.sql`AND ${httpCodeSql(f.httpCode)}`);
    if (f.errorKind) conds.push(Prisma.sql`AND ${errorKindSql(f.errorKind)}`);
    if (f.cursor) {
      const at = Prisma.sql`${f.cursor.at}::timestamp AT TIME ZONE 'UTC'`;
      conds.push(
        f.dir === 'newer'
          ? Prisma.sql`AND (d.created_at, d.id) > (${at}, ${f.cursor.id}::uuid)`
          : Prisma.sql`AND (d.created_at, d.id) < (${at}, ${f.cursor.id}::uuid)`,
      );
    }
    const order = f.dir === 'newer' ? Prisma.sql`d.created_at ASC, d.id ASC` : Prisma.sql`d.created_at DESC, d.id DESC`;
    const keys = await this.prisma.$queryRaw<{ id: string; cursorAt: string }[]>(Prisma.sql`
      SELECT d.id, to_char(d.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') AS "cursorAt"
      FROM hub.deliveries d
      WHERE d.tenant_id = ${this.tenantId}::uuid ${conds.length ? Prisma.join(conds, ' ') : Prisma.empty}
      ORDER BY ${order}
      LIMIT ${f.limit + 1}
    `);
    if (keys.length === 0) return { rows: [] };
    const full = await this.prisma.delivery.findMany({
      where: { id: { in: keys.map((k) => k.id) }, tenantId: this.tenantId },
      include: { event: true, subscription: { include: { destination: true } }, attempts: true },
    });
    const byId = new Map(full.map((d) => [d.id, d]));
    const rows: DeliveryPageRow[] = [];
    for (const k of keys) {
      const d = byId.get(k.id);
      if (d) rows.push({ ...d, cursorAt: k.cursorAt });
    }
    return { rows };
  }

  /** Đếm cùng điều kiện với `findDeadDeliveries` — để KPI "DLQ" khớp đúng số dòng trong bảng DLQ. */
  async countDeadDeliveries(): Promise<number> {
    const [row] = await this.prisma.$queryRaw<{ n: bigint }[]>(Prisma.sql`
      SELECT count(*) AS n FROM hub.deliveries d
      WHERE d.tenant_id = ${this.tenantId}::uuid AND d.status = 'DEAD' AND ${notSuperseded}
    `);
    return Number(row?.n ?? 0);
  }

  /** Đã có generation mới hơn cho cùng (event, subscription) chưa — replay chỉ hợp lệ trên bản mới nhất. */
  async hasNewerGeneration(delivery: { eventId: string; subscriptionId: string; attemptGeneration: number }) {
    const newer = await this.prisma.delivery.findFirst({
      where: {
        tenantId: this.tenantId,
        eventId: delivery.eventId,
        subscriptionId: delivery.subscriptionId,
        attemptGeneration: { gt: delivery.attemptGeneration },
      },
      select: { id: true },
    });
    return newer !== null;
  }

  /**
   * MỘT truy vấn nạp đủ những gì worker cần để gửi (S1-1): delivery + event + subscription
   * (template) + destination (cấu hình mã hoá). Cả subscription lẫn destination đều lọc theo
   * tenant — không bao giờ gửi tới đích của tenant khác dù dữ liệu có lẫn.
   */
  findDeliveryForSend(id: string) {
    return this.prisma.delivery.findFirst({
      where: {
        id,
        tenantId: this.tenantId,
        subscription: { tenantId: this.tenantId, destination: { tenantId: this.tenantId } },
      },
      include: {
        event: { include: { rawEvent: { select: { sourceId: true } } } },
        subscription: { include: { destination: true } },
      },
    });
  }

  /**
   * Lease khi bắt đầu gửi (S1-2): chỉ MỘT worker chuyển được delivery sang DELIVERING cho đúng
   * (generation, attemptCount). Nhận lại được khi DELIVERING đã treo quá `leaseSeconds`
   * (worker trước chết giữa chừng). Lease phải > timeout gửi (5s) + thời gian ghi DB.
   * Trả số dòng đã nhận: 0 = worker khác đang/đã xử lý lần gửi này.
   */
  claimForSend(
    id: string,
    attemptGeneration: number,
    attemptCount: number,
    leaseSeconds = DELIVERY_LEASE_SECONDS,
  ): Prisma.PrismaPromise<number> {
    return this.prisma.$executeRaw(Prisma.sql`
      UPDATE hub.deliveries SET status = 'DELIVERING', updated_at = now()
      WHERE id = ${id}::uuid AND tenant_id = ${this.tenantId}::uuid
        AND attempt_generation = ${attemptGeneration} AND attempt_count = ${attemptCount}
        AND (status IN ('PENDING', 'RETRYING')
             OR (status = 'DELIVERING' AND updated_at < now() - make_interval(secs => ${leaseSeconds}::double precision)))
    `);
  }

  /**
   * Circuit hoãn gửi (S2-1/S2-2): ghi `next_attempt_at` để UI hiện "thử lại lúc" và để sweeper
   * không coi delivery đang bị hoãn hợp lệ là kẹt. Không đổi status/attemptCount (hoãn ≠ một lần thử).
   */
  /**
   * ADR-161 (T3): delivery chưa xong tới đích đã LƯU TRỮ -> DEAD kèm lý do rõ, KHÔNG gửi. Chỉ dòng còn đang chờ
   * (PENDING / RETRYING) — KHÔNG đụng DELIVERING (worker giữ lease có thể đang gửi dở); trả số dòng đổi.
   */
  async abandonDelivery(id: string, reason: string): Promise<number> {
    const result = await this.prisma.delivery.updateMany({
      where: { id, tenantId: this.tenantId, status: { in: ['PENDING', 'RETRYING'] } },
      data: { status: 'DEAD', lastError: reason, nextAttemptAt: null },
    });
    return result.count;
  }

  async deferDelivery(id: string, nextAttemptAt: Date): Promise<number> {
    const result = await this.prisma.delivery.updateMany({
      where: { id, tenantId: this.tenantId, status: { in: ['PENDING', 'RETRYING'] } },
      data: { nextAttemptAt },
    });
    return result.count;
  }

  /** Trạng thái lease hiện tại (sau khi claim thua) — để phân biệt "đang có worker gửi" với "đã xong". */
  getDeliveryLeaseState(id: string) {
    return this.prisma.delivery.findFirst({
      where: { id, tenantId: this.tenantId },
      select: { status: true, attemptGeneration: true, attemptCount: true },
    });
  }

  /** Replay hàng loạt (S2-3): một câu INSERT cho N delivery, gọi bằng repo dựng trên `tx`. */
  async createDeliveries(data: Omit<Prisma.DeliveryCreateManyInput, 'tenantId'>[]): Promise<number> {
    if (data.length === 0) return 0;
    const result = await this.prisma.delivery.createMany({ data: data.map((d) => ({ ...d, tenantId: this.tenantId })) });
    return result.count;
  }

  async createDelivery(data: Omit<Prisma.DeliveryUncheckedCreateInput, 'tenantId'>) {
    return this.prisma.delivery.create({
      data: { ...data, tenantId: this.tenantId },
    });
  }

  /**
   * Atomic ở tầng SQL — xem ghi chú tại `updateDestination`. `updateMany` với
   * `where: { id, tenantId }` chặn cross-tenant write trong một câu lệnh duy nhất.
   */
  async updateDeliveryStatus(id: string, data: Prisma.DeliveryUncheckedUpdateInput): Promise<Delivery | null> {
    const result = await this.prisma.delivery.updateMany({
      where: { id, tenantId: this.tenantId },
      data,
    });
    if (result.count !== 1) return null;
    return this.prisma.delivery.findFirst({ where: { id, tenantId: this.tenantId } });
  }

  async countDeliveries(where: Prisma.DeliveryWhereInput = {}) {
    return this.prisma.delivery.count({
      where: { ...where, tenantId: this.tenantId },
    });
  }

  // --- Raw events (không có cột tenant_id: scope qua source.tenantId) ---

  /** Normalize đọc raw event của ĐÚNG tenant trong message (S1-5) — không `prisma.rawEvent` trần. */
  async findRawEventById(id: string) {
    return this.prisma.rawEvent.findFirst({
      where: { id, source: { tenantId: this.tenantId } },
      // S8: cấu hình GenericAdapter đi CÙNG truy vấn (không thêm query mỗi raw event).
      include: { source: { select: { verificationConfig: true } } },
    });
  }

  /**
   * S9: raw_events mới nhất của MỘT source (scope qua source.tenantId) — cho `inspect`. Không kèm `source`.
   * `status` (tuỳ chọn): chỉ lấy trạng thái đó (KN L-R3-2: đối chiếu secret chỉ tin hàng ACCEPTED).
   */
  async findRecentRawEventsForSource(sourceId: string, since: Date, limit: number, status?: 'ACCEPTED' | 'REJECTED' | 'DUPLICATE') {
    return this.prisma.rawEvent.findMany({
      where: { sourceId, receivedAt: { gte: since }, source: { tenantId: this.tenantId }, ...(status ? { status } : {}) },
      orderBy: { receivedAt: 'desc' },
      take: limit,
    });
  }

  /**
   * Raw event "mồ côi" (S1-3): ACCEPTED, quá `olderThanSeconds`, chưa sinh event nào và chưa
   * được normalize xong (không có `processed_messages(normalize, id)` — loại trừ raw event mà
   * adapter cố ý chuẩn hoá ra 0 event). Postgres là trọng tài; DLQ broker chỉ là bản sao.
   * `ids` (tuỳ chọn) lọc lại ở server: client không thể ép renormalize raw event không mồ côi.
   */
  async findOrphanRawEvents(opts: { limit: number; ids?: string[]; olderThanSeconds?: number; maxAgeSeconds?: number }) {
    const olderThan = opts.olderThanSeconds ?? ORPHAN_MIN_AGE_SECONDS;
    // S7 (DINH-CHINH §3): raw cũ hơn retention đã mất event (+ processed_messages) do cleanup — KHÔNG phải mồ côi.
    const maxAge = opts.maxAgeSeconds ?? eventRetentionDaysFromEnv() * 86_400;
    const idFilter =
      opts.ids && opts.ids.length > 0 ? Prisma.sql`AND r.id IN (${Prisma.join(opts.ids.map((i) => Prisma.sql`${i}::uuid`))})` : Prisma.empty;
    const where = Prisma.sql`
      s.tenant_id = ${this.tenantId}::uuid AND r.status = 'ACCEPTED'
      AND r.received_at < now() - make_interval(secs => ${olderThan}::double precision)
      AND r.received_at >= now() - make_interval(secs => ${maxAge}::double precision)
      AND NOT EXISTS (SELECT 1 FROM hub.events e WHERE e.raw_event_id = r.id)
      AND NOT EXISTS (SELECT 1 FROM hub.processed_messages p WHERE p.consumer = 'normalize' AND p.message_id = r.id::text)
      -- Review QT-S2 R2 N1: raw đã "Dọn" (body rỗng, user đã xác nhận mức Cao) KHÔNG còn là ứng viên chuẩn hoá lại — không
      -- banner, không normalize.backlog, nút Chuẩn hoá lại không bắn body rỗng.
      AND r.trimmed_at IS NULL
      ${idFilter}`;
    const [items, [countRow]] = await Promise.all([
      this.prisma.$queryRaw<OrphanRawEvent[]>(Prisma.sql`
        SELECT r.id, r.source_id AS "sourceId", s.provider::text AS provider, s.name AS "sourceName",
               r.idempotency_key AS "idempotencyKey", r.received_at AS "receivedAt"
        FROM hub.raw_events r JOIN hub.sources s ON s.id = r.source_id
        WHERE ${where}
        ORDER BY r.received_at DESC
        LIMIT ${opts.limit}`),
      this.prisma.$queryRaw<{ n: bigint }[]>(Prisma.sql`
        SELECT count(*) AS n FROM hub.raw_events r JOIN hub.sources s ON s.id = r.source_id WHERE ${where}`),
    ]);
    return { items, total: Number(countRow?.n ?? 0) };
  }

  // --- API keys (S1/S2, ADR-038): mọi thao tác theo project đi qua repo; chỉ tra theo hash là escape hatch ---
  async createApiKey(data: Omit<Prisma.ApiKeyUncheckedCreateInput, 'tenantId'>) {
    return this.prisma.apiKey.create({ data: { ...data, tenantId: this.tenantId } });
  }

  /** Danh sách key của project — KHÔNG BAO GIỜ trả `keyHash`. */
  async findApiKeys() {
    return this.prisma.apiKey.findMany({
      where: { tenantId: this.tenantId },
      orderBy: { createdAt: 'asc' },
      select: API_KEY_PUBLIC_SELECT,
    });
  }

  async findApiKeyById(id: string) {
    return this.prisma.apiKey.findFirst({ where: { id, tenantId: this.tenantId }, select: API_KEY_PUBLIC_SELECT });
  }

  /** Revoke idempotent: đặt `revokedAt` nếu chưa có. Trả số dòng đổi (0 = đã revoke trước đó hoặc không thuộc project). */
  async revokeApiKey(id: string): Promise<number> {
    const r = await this.prisma.apiKey.updateMany({ where: { id, tenantId: this.tenantId, revokedAt: null }, data: { revokedAt: new Date() } });
    return r.count;
  }

  /** N-1 (ADR-121): thu hồi MỌI key còn sống của project (tài khoản chủ vừa được người nắm hộp thư nhận lại). */
  async revokeAllApiKeys(at: Date): Promise<number> {
    const r = await this.prisma.apiKey.updateMany({ where: { tenantId: this.tenantId, revokedAt: null }, data: { revokedAt: at } });
    return r.count;
  }

  /** `lastUsedAt` (ApiKeyGuard gọi tối đa 1 lần/phút/key, không chặn request). */
  async touchApiKeyLastUsed(id: string, at: Date): Promise<number> {
    const r = await this.prisma.apiKey.updateMany({ where: { id, tenantId: this.tenantId }, data: { lastUsedAt: at } });
    return r.count;
  }

  // --- Audit log (S2-3) ---
  /** Gọi bằng repo dựng trên `tx` để audit nằm CÙNG transaction với hành động. */
  async createAuditLog(input: AuditLogInput) {
    return this.prisma.auditLog.create({
      data: {
        tenantId: this.tenantId,
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId,
        actor: input.actor || 'system',
        reason: input.reason ?? null,
        metadata: (input.metadata ?? undefined) as Prisma.InputJsonValue | undefined,
      },
    });
  }

  /**
   * C-1 (ADR-131): audit MỚI NHẤT của một thực thể trong các `actions`, chỉ xét `created_at >= since` (cửa sổ ngắn ->
   * quét đoạn đầu index `(tenant_id, created_at DESC)`, không cần index theo entity). Dùng để chống spam audit.
   */
  async findLatestAuditForEntity(entityType: string, entityId: string, actions: string[], since: Date) {
    return this.prisma.auditLog.findFirst({
      where: { tenantId: this.tenantId, entityType, entityId, action: { in: actions }, createdAt: { gte: since } },
      orderBy: { id: 'desc' },
    });
  }

  /** Phân trang lùi theo `id` (bigint tăng dần): `before` = id nhỏ nhất của trang trước. */
  async findAuditLogs(opts: { limit: number; before?: bigint }) {
    return this.prisma.auditLog.findMany({
      where: { tenantId: this.tenantId, ...(opts.before !== undefined ? { id: { lt: opts.before } } : {}) },
      orderBy: { id: 'desc' },
      take: opts.limit,
    });
  }

  /**
   * ADR-163: audit theo KEYSET `(created_at, id)` + bộ lọc (người làm, hành động, loại đối tượng, khoảng thời gian).
   * `dir: 'newer'` trả TĂNG dần sát cursor (trang "Trước"; gọi bên ngoài đảo lại). Kèm `cursorAt` µs UTC.
   */
  async findAuditLogPage(f: AuditLogFilter) {
    const conds: Prisma.Sql[] = [];
    if (f.actor) conds.push(Prisma.sql`AND a.actor ILIKE ${'%' + escapeLike(f.actor) + '%'}`);
    if (f.action) conds.push(Prisma.sql`AND (a.action = ${f.action} OR starts_with(a.action, ${f.action.endsWith('.') ? f.action : f.action + '.'}))`);
    if (f.entityType) conds.push(Prisma.sql`AND a.entity_type = ${f.entityType}`);
    if (f.from) conds.push(Prisma.sql`AND a.created_at >= ${f.from}`);
    if (f.to) conds.push(Prisma.sql`AND a.created_at <= ${f.to}`);
    if (f.cursor) {
      const at = Prisma.sql`${f.cursor.at}::timestamp AT TIME ZONE 'UTC'`;
      conds.push(
        f.dir === 'newer'
          ? Prisma.sql`AND (a.created_at, a.id) > (${at}, ${f.cursor.id}::bigint)`
          : Prisma.sql`AND (a.created_at, a.id) < (${at}, ${f.cursor.id}::bigint)`,
      );
    }
    const order = f.dir === 'newer' ? Prisma.sql`a.created_at ASC, a.id ASC` : Prisma.sql`a.created_at DESC, a.id DESC`;
    return this.prisma.$queryRaw<
      { id: bigint; action: string; entityType: string; entityId: string; actor: string; reason: string | null; metadata: unknown; createdAt: Date; cursorAt: string }[]
    >(Prisma.sql`
      SELECT a.id, a.action, a.entity_type AS "entityType", a.entity_id AS "entityId", a.actor, a.reason, a.metadata,
             a.created_at AS "createdAt", to_char(a.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') AS "cursorAt"
      FROM hub.audit_logs a
      WHERE a.tenant_id = ${this.tenantId}::uuid ${conds.length ? Prisma.join(conds, ' ') : Prisma.empty}
      ORDER BY ${order}
      LIMIT ${f.limit + 1}
    `);
  }

  /** Giá trị gợi ý cho bộ lọc audit (hành động / loại đối tượng / người làm đã từng xuất hiện) — tối đa 100 mỗi loại. */
  async findAuditFacets() {
    // Raw DISTINCT (Prisma `distinct` khử trùng trong bộ nhớ sau khi đọc HẾT dòng).
    const col = (c: Prisma.Sql) =>
      this.prisma.$queryRaw<{ v: string }[]>(Prisma.sql`
        SELECT DISTINCT ${c} AS v FROM hub.audit_logs WHERE tenant_id = ${this.tenantId}::uuid ORDER BY 1 LIMIT 100`);
    const actions = await col(Prisma.sql`action`);
    const entityTypes = await col(Prisma.sql`entity_type`);
    const actors = await col(Prisma.sql`actor`);
    return { actions: actions.map((r) => r.v), entityTypes: entityTypes.map((r) => r.v), actors: actors.map((r) => r.v) };
  }

  // --- Alerts (CB1, SPEC-canh-bao-nhan-dinh §3.1, ADR-165) ---
  // Postgres là TRỌNG TÀI: unique index một phần `alerts_open_unique (tenant_id, rule, subject_id) WHERE state='OPEN'`.
  // Không khoá (DINH-CHINH D4): hai evaluator cùng chạy chỉ tốn thêm truy vấn, vẫn đúng MỘT dòng OPEN (CB:T2).

  /**
   * Mở (hoặc làm mới) cảnh báo OPEN của (rule, subject) trong MỘT câu `INSERT … ON CONFLICT … WHERE state='OPEN' DO UPDATE`.
   * `opened` = true khi dòng vừa được TẠO (xmax = 0) — chỉ khi đó evaluator mới publish realtime / tạo email PENDING.
   * Dòng đã có: cập nhật `last_seen_at` (không lùi) + `facts`; `opened_at`, ack giữ nguyên.
   */
  async upsertOpenAlert(input: AlertUpsertInput): Promise<{ alert: AlertRow; opened: boolean }> {
    const facts = JSON.stringify(input.facts ?? {});
    const [row] = await this.prisma.$queryRaw<(AlertRow & { inserted: boolean })[]>(Prisma.sql`
      INSERT INTO hub.alerts AS a (id, tenant_id, rule, severity, subject_type, subject_id, state, opened_at, last_seen_at, facts)
      VALUES (gen_random_uuid(), ${this.tenantId}::uuid, ${input.rule}, ${input.severity}::"hub"."AlertSeverity",
              ${input.subjectType}::"hub"."AlertSubjectType", ${input.subjectId}::uuid, 'OPEN', ${input.now}, ${input.now}, ${facts}::jsonb)
      ON CONFLICT (tenant_id, rule, subject_id) WHERE state = 'OPEN'
      DO UPDATE SET last_seen_at = GREATEST(a.last_seen_at, EXCLUDED.last_seen_at), facts = EXCLUDED.facts
      RETURNING ${ALERT_RETURNING}, (xmax = 0) AS inserted`);
    const { inserted, ...alert } = row;
    return { alert, opened: inserted };
  }

  /**
   * CB2: đóng ĐÚNG dòng đã đọc ở ảnh chụp (theo id, chỉ khi còn OPEN) — không đóng nhầm một dòng OPEN MỚI của cùng
   * (rule, subject) mà evaluator khác vừa mở sau ảnh chụp. Không còn OPEN -> null (không publish lần hai).
   */
  async resolveAlertById(id: string, now: Date, factsPatch: Record<string, unknown> = {}): Promise<AlertRow | null> {
    const [row] = await this.prisma.$queryRaw<AlertRow[]>(Prisma.sql`
      UPDATE hub.alerts SET state = 'RESOLVED', resolved_at = ${now}, facts = facts || ${JSON.stringify(factsPatch)}::jsonb
      WHERE tenant_id = ${this.tenantId}::uuid AND id = ${id}::uuid AND state = 'OPEN'
      RETURNING ${ALERT_RETURNING}`);
    return row ?? null;
  }

  /**
   * CB2: cảnh báo OPEN của MỘT luật cho các đối tượng cho trước — evaluator đọc bù khi ảnh chụp `findOpenAlerts` chạm
   * trần, để quyết định với đúng `current` (hysteresis / HALF_OPEN / PENDING giữ mở) thay vì coi là "chưa mở".
   */
  async findOpenAlertsForSubjects(rule: string, subjectIds: string[]) {
    if (subjectIds.length === 0) return [];
    return this.prisma.alert.findMany({ where: { tenantId: this.tenantId, state: 'OPEN', rule, subjectId: { in: subjectIds } } });
  }

  /** Cảnh báo đang OPEN của project (evaluator đọc để áp hysteresis / đóng). Dùng index (tenant_id, state, opened_at DESC). */
  async findOpenAlerts(limit = 500) {
    return this.prisma.alert.findMany({
      where: { tenantId: this.tenantId, state: 'OPEN' },
      orderBy: { openedAt: 'desc' },
      take: limit,
    });
  }

  async findAlertById(id: string) {
    return this.prisma.alert.findFirst({ where: { id, tenantId: this.tenantId } });
  }

  /**
   * "Đã xem" (idempotent): chỉ ghi lần ĐẦU (`acknowledged_at IS NULL`), không đóng cảnh báo. Trả `found` (alert thuộc
   * project này) và `changed` (lần này mới ghi). Alert của project khác -> found=false (route trả 404 giống hệt).
   */
  async ackAlert(id: string, userId: string, now: Date): Promise<{ found: boolean; changed: boolean }> {
    const r = await this.prisma.alert.updateMany({
      where: { id, tenantId: this.tenantId, acknowledgedAt: null },
      data: { acknowledgedAt: now, acknowledgedBy: userId },
    });
    if (r.count === 1) return { found: true, changed: true };
    const exists = await this.prisma.alert.count({ where: { id, tenantId: this.tenantId } });
    return { found: exists === 1, changed: false };
  }

  /**
   * "Đánh dấu đã xem tất cả" theo DANH SÁCH id người dùng đã thấy trong chuông (re-review CB4): chỉ dòng của project này,
   * còn OPEN, chưa ai xem. Không theo mốc thời gian — `opened_at` là `now` của lượt đánh giá (chung mọi project), một
   * cảnh báo commit muộn hơn trong cùng lượt có cùng mốc mà chưa ai thấy. Trả id đã ghi (gọi trong `tenantTx`).
   */
  async ackAlertsByIds(ids: string[], userId: string, now: Date): Promise<string[]> {
    if (ids.length === 0) return [];
    // MỘT câu UPDATE … RETURNING (CB7, review CB4): id trả về = ĐÚNG các dòng lần gọi này đã ghi — không có khe giữa đọc
    // và ghi (findMany + updateMany cũ: một lượt ack song song chen giữa thì audit liệt kê id mà lần này không ghi).
    const rows = await this.prisma.$queryRaw<{ id: string }[]>(Prisma.sql`
      UPDATE hub.alerts SET acknowledged_at = ${now}, acknowledged_by = ${userId}::uuid
      WHERE tenant_id = ${this.tenantId}::uuid AND id = ANY(${ids}::uuid[]) AND state = 'OPEN' AND acknowledged_at IS NULL
      RETURNING id`);
    return rows.map((r) => r.id).sort();
  }

  /**
   * D1: outbox email theo NGƯỜI — một dòng PENDING cho mỗi (alert, user, kind); trùng thì bỏ qua (unique). Gọi bằng repo
   * dựng trên `tx` để nằm CÙNG transaction đổi trạng thái cảnh báo. Khoá ngoại ghép (alert_id, tenant_id) chặn alert của
   * project khác. Trả số dòng tạo mới.
   */
  async enqueueAlertEmails(alertId: string, kind: 'OPEN' | 'RESOLVED', userIds: string[], tag = ''): Promise<number> {
    if (userIds.length === 0) return 0;
    // QT6 (ADR-190): `tag` tách email theo nấc/ngày của CÙNG một cảnh báo dung lượng (unique alert, user, kind, tag).
    const r = await this.prisma.alertEmail.createMany({
      data: [...new Set(userIds)].map((userId) => ({ tenantId: this.tenantId, alertId, userId, kind, tag })),
      skipDuplicates: true,
    });
    return r.count;
  }

  /**
   * CB2 chống flapping (§6, D1): có cảnh báo cùng (rule, subject) đã RESOLVED từ `since` trở đi không. Có -> lần mở lại
   * này KHÔNG tạo email OPEN. Dùng index `(tenant_id, state, opened_at DESC)` (lọc tenant + state), LIMIT 1.
   */
  async hasAlertResolvedSince(rule: string, subjectId: string, since: Date): Promise<boolean> {
    const rows = await this.prisma.$queryRaw<{ x: number }[]>(Prisma.sql`
      SELECT 1 AS x FROM hub.alerts
      WHERE tenant_id = ${this.tenantId}::uuid AND state = 'RESOLVED' AND rule = ${rule}
        AND subject_id = ${subjectId}::uuid AND resolved_at >= ${since}
      LIMIT 1`);
    return rows.length > 0;
  }

  /** Người đã có dòng outbox `kind` cho cảnh báo này (CB2: email RESOLVED chỉ gửi cho người đã nhận email OPEN). */
  async findAlertEmailUserIds(alertId: string, kind: 'OPEN' | 'RESOLVED'): Promise<string[]> {
    const rows = await this.prisma.alertEmail.findMany({
      where: { tenantId: this.tenantId, alertId, kind, tag: '' },
      select: { userId: true },
    });
    return rows.map((r) => r.userId);
  }

  /** QT6: cảnh báo OPEN của một nhóm luật cho MỘT đối tượng (luật dung lượng — đối tượng = project). */
  async findOpenAlertsByRules(rules: string[], subjectId: string) {
    if (rules.length === 0) return [];
    return this.prisma.alert.findMany({ where: { tenantId: this.tenantId, state: 'OPEN', rule: { in: rules }, subjectId } });
  }

  // --- Đầu vào của AlertEvaluator (CB2, SPEC §4/§5.1): mỗi câu một truy vấn tổng hợp, có cửa sổ thời gian + LIMIT ---

  /**
   * Đích của project để đánh giá luật destination.*: còn dùng (`archived_at IS NULL`) + đích đã lưu trữ đang có cảnh báo
   * OPEN (`includeIds`, để đóng với lý do — xếp TRƯỚC nên LIMIT không cắt mất chúng). Cũng là đầu vào của `destination.circuit_open` (cột `circuit_state`).
   */
  async findAlertDestinations(includeIds: string[], limit = ALERT_INPUT_LIMIT): Promise<AlertDestinationRow[]> {
    return this.prisma.$queryRaw<AlertDestinationRow[]>(Prisma.sql`
      SELECT id, is_active AS "isActive", archived_at AS "archivedAt", circuit_state::text AS "circuitState"
      FROM hub.destinations
      WHERE tenant_id = ${this.tenantId}::uuid AND (archived_at IS NULL OR id = ANY(${uuidArray(includeIds)}))
      ORDER BY (id = ANY(${uuidArray(includeIds)})) DESC, created_at
      LIMIT ${limit}`);
  }

  /**
   * Source của project + kết nối hub->provider (nếu có) — đầu vào lifecycle cho source.* và của `source.connection_broken`
   * (`status`, `updated_at`, `provider` làm nhãn — D5). Cùng quy tắc `includeIds` như đích.
   */
  async findAlertSources(includeIds: string[], limit = ALERT_INPUT_LIMIT): Promise<AlertSourceRow[]> {
    return this.prisma.$queryRaw<AlertSourceRow[]>(Prisma.sql`
      SELECT s.id, s.is_active AS "isActive", s.archived_at AS "archivedAt", s.provider::text AS provider,
             c.status::text AS "connectionStatus", c.last_error AS "connectionLastError", c.last_fix AS "connectionLastFix",
             c.updated_at AS "connectionUpdatedAt", c.provider::text AS "connectionProvider"
      FROM hub.sources s
      LEFT JOIN hub.source_connections c ON c.source_id = s.id AND c.tenant_id = s.tenant_id
      WHERE s.tenant_id = ${this.tenantId}::uuid AND (s.archived_at IS NULL OR s.id = ANY(${uuidArray(includeIds)}))
      ORDER BY (s.id = ANY(${uuidArray(includeIds)})) DESC, s.created_at
      LIMIT ${limit}`);
  }

  /**
   * Attempt gần nhất của từng đích từ `since` (mới nhất trước), tối đa `perDestination` mỗi đích — đầu vào hai luật chuỗi
   * (`auth_rejected`, `client_error`). Lái từ index `delivery_attempts(created_at)` (migration CB2), nối delivery theo PK.
   */
  async findRecentAttemptsByDestination(since: Date, perDestination: number, limit = ALERT_ATTEMPT_ROWS_LIMIT): Promise<AlertAttemptRow[]> {
    return this.prisma.$queryRaw<AlertAttemptRow[]>(Prisma.sql`
      SELECT "destinationId", status, at FROM (
        SELECT s.destination_id AS "destinationId", a.response_status AS status, a.created_at AS at,
               row_number() OVER (PARTITION BY s.destination_id ORDER BY a.created_at DESC, a.id DESC) AS rn
        FROM hub.delivery_attempts a
        JOIN hub.deliveries d ON d.id = a.delivery_id
        JOIN hub.subscriptions s ON s.id = d.subscription_id AND s.tenant_id = d.tenant_id
        WHERE d.tenant_id = ${this.tenantId}::uuid AND a.created_at >= ${since}
      ) x
      WHERE rn <= ${perDestination}
      ORDER BY "destinationId", at DESC
      LIMIT ${limit}`);
  }

  /** Số attempt theo (đích, HTTP status) từ `since` — đầu vào `destination.failing` (phân loại ở hàm chung, không ở SQL). */
  async countAttemptStatusesByDestination(since: Date, limit = ALERT_ATTEMPT_ROWS_LIMIT): Promise<AlertStatusCountRow[]> {
    const rows = await this.prisma.$queryRaw<(Omit<AlertStatusCountRow, 'n'> & { n: bigint })[]>(Prisma.sql`
      SELECT s.destination_id AS "destinationId", a.response_status AS status, count(*) AS n
      FROM hub.delivery_attempts a
      JOIN hub.deliveries d ON d.id = a.delivery_id
      JOIN hub.subscriptions s ON s.id = d.subscription_id AND s.tenant_id = d.tenant_id
      WHERE d.tenant_id = ${this.tenantId}::uuid AND a.created_at >= ${since}
      GROUP BY 1, 2
      LIMIT ${limit}`);
    return rows.map((r) => ({ ...r, n: Number(r.n) }));
  }

  /**
   * Delivery thành DEAD từ `since`, đếm theo đích (`facts.dead` của luật chuỗi). Dùng index một phần
   * `deliveries(tenant_id, updated_at DESC) WHERE status='DEAD'` (migration CB2).
   */
  async countDeadDeliveriesByDestination(since: Date, limit = ALERT_INPUT_LIMIT): Promise<{ destinationId: string; n: number }[]> {
    const rows = await this.prisma.$queryRaw<{ destinationId: string; n: bigint }[]>(Prisma.sql`
      SELECT s.destination_id AS "destinationId", count(*) AS n
      FROM hub.deliveries d
      JOIN hub.subscriptions s ON s.id = d.subscription_id AND s.tenant_id = d.tenant_id
      WHERE d.tenant_id = ${this.tenantId}::uuid AND d.status = 'DEAD' AND d.updated_at >= ${since}
      GROUP BY 1
      LIMIT ${limit}`);
    return rows.map((r) => ({ destinationId: r.destinationId, n: Number(r.n) }));
  }

  /**
   * `delivery.dead_spike`: số delivery thành DEAD từ `since` trong project, ĐÃ loại D9 (DEAD vì đích lưu trữ: `last_error`
   * có tiền tố `archivedErrorPrefix`, hoặc subscription / đích có `archived_at`) và loại bản DEAD đã bị replay (cùng điều
   * kiện `notSuperseded` với DLQ — "Phát lại hàng loạt" làm cảnh báo hạ xuống), dừng đếm ở `cap`. Cùng index một phần.
   */
  async countDeadForSpike(since: Date, archivedErrorPrefix: string, cap: number): Promise<number> {
    const [row] = await this.prisma.$queryRaw<{ n: bigint }[]>(Prisma.sql`
      SELECT count(*) AS n FROM (
        SELECT 1 FROM hub.deliveries d
        JOIN hub.subscriptions s ON s.id = d.subscription_id AND s.tenant_id = d.tenant_id
        JOIN hub.destinations dst ON dst.id = s.destination_id AND dst.tenant_id = s.tenant_id
        WHERE d.tenant_id = ${this.tenantId}::uuid AND d.status = 'DEAD' AND d.updated_at >= ${since}
          AND s.archived_at IS NULL AND dst.archived_at IS NULL
          AND (d.last_error IS NULL OR left(d.last_error, ${archivedErrorPrefix.length}::int) <> ${archivedErrorPrefix})
          AND ${notSuperseded}
        LIMIT ${cap}
      ) x`);
    return Number(row?.n ?? 0);
  }

  /**
   * Request tới từng source từ `since` (KHÔNG tính probe: raw có event `probe=true` — PayOS confirm ADR-159, GitHub ping
   * ADR-162; request ký sai không có event nên luôn tính) và số ký sai. Index `raw_events(received_at DESC)`; scope tenant
   * qua `sources.tenant_id` (raw_events không có cột tenant).
   */
  async countSignatureBySource(since: Date, limit = ALERT_INPUT_LIMIT): Promise<{ sourceId: string; requests: number; invalid: number }[]> {
    const rows = await this.prisma.$queryRaw<{ sourceId: string; requests: bigint; invalid: bigint }[]>(Prisma.sql`
      SELECT r.source_id AS "sourceId", count(*) AS requests, count(*) FILTER (WHERE NOT r.signature_valid) AS invalid
      FROM hub.raw_events r
      JOIN hub.sources s ON s.id = r.source_id
      LEFT JOIN hub.events e ON e.raw_event_id = r.id
      WHERE s.tenant_id = ${this.tenantId}::uuid AND r.received_at >= ${since} AND e.probe IS NOT TRUE
      GROUP BY 1
      LIMIT ${limit}`);
    return rows.map((r) => ({ sourceId: r.sourceId, requests: Number(r.requests), invalid: Number(r.invalid) }));
  }

  /**
   * Nhịp của từng source trong baseline (`source.silent`): sự kiện webhook/API publish (không replay/đối soát/dẫn xuất), KHÔNG probe từ `since`, tối đa `perSource` mốc
   * gần nhất mỗi source -> số mốc khác nhau, mốc cuối, trung vị khoảng cách (ms; bỏ khoảng 0 của nhiều event cùng một
   * request). Index `events(tenant_id, received_at DESC)`.
   */
  async findSourceActivity(sourceIds: string[], since: Date, perSource: number): Promise<AlertSourceActivityRow[]> {
    if (sourceIds.length === 0) return [];
    const rows = await this.prisma.$queryRaw<{ sourceId: string; n: bigint; lastAt: Date | null; medianGapMs: number | null }[]>(Prisma.sql`
      SELECT src.id AS "sourceId", x.n, x.last_at AS "lastAt", x.median_gap AS "medianGapMs"
      FROM unnest(${uuidArray(sourceIds)}) AS src(id)
      CROSS JOIN LATERAL (
        SELECT count(DISTINCT t) AS n, max(t) AS last_at,
               percentile_cont(0.5) WITHIN GROUP (ORDER BY gap) FILTER (WHERE gap > 0) AS median_gap
        FROM (
          SELECT t, EXTRACT(EPOCH FROM (t - lag(t) OVER (ORDER BY t))) * 1000 AS gap
          FROM (
            SELECT e.received_at AS t FROM hub.events e
            WHERE e.tenant_id = ${this.tenantId}::uuid AND e.source_id = src.id AND e.received_at >= ${since}
              AND NOT e.probe AND e.origin IN ('webhook', 'api')
            ORDER BY e.received_at DESC
            LIMIT ${perSource}
          ) recent
        ) g
      ) x`);
    return rows.map((r) => ({ sourceId: r.sourceId, n: Number(r.n), lastAt: r.lastAt, medianGapMs: r.medianGapMs === null ? null : Number(r.medianGapMs) }));
  }

  // --- Nhận định (CB6, SPEC §7): tính lúc đọc, mỗi câu có cửa sổ + index; dùng lại đầu vào của AlertEvaluator ở trên ---

  /**
   * CB6 / ADR-171: cộng dồn bộ đếm bản trùng (đã gom trong bộ nhớ ở hub-api) — MỘT câu cho cả lô của project này.
   * `ON CONFLICT DO UPDATE n = n + EXCLUDED.n` trên PK (tenant, source, giờ): nhiều instance hub-api cùng ghi vẫn cộng đúng.
   */
  // --- QT: hạn mức dung lượng (SPEC-han-muc-dung-luong, ADR-182..189) ---

  /**
   * QT:T26 (Q10): project MỚI nhận policy dọn tự động mặc định + dòng `project_usage` (nấc OK, chưa hiệu chỉnh). Gọi trong
   * transaction tạo project. Idempotent (`skipDuplicates`) — project có sẵn đã được migration QT1 seed.
   */
  async seedStorageDefaults(updatedBy: string): Promise<void> {
    await this.prisma.storagePolicy.createMany({
      data: DEFAULT_STORAGE_POLICIES.map((p) => ({ tenantId: this.tenantId, importance: p.importance, action: p.action, afterDays: p.afterDays, trigger: p.trigger, updatedBy })),
      skipDuplicates: true,
    });
    await this.prisma.projectUsage.createMany({ data: [{ tenantId: this.tenantId }], skipDuplicates: true });
  }

  async findStoragePolicies() {
    return this.prisma.storagePolicy.findMany({ where: { tenantId: this.tenantId }, orderBy: { importance: 'asc' } });
  }

  async findProjectUsage() {
    return this.prisma.projectUsage.findUnique({ where: { tenantId: this.tenantId } });
  }

  /**
   * QT6 (ADR-190): khoá dòng `project_usage` của project (`FOR UPDATE`) cho luồng "báo" — hai đường báo cùng lúc (lượt nấc
   * 60s, lô dọn) xếp hàng ở đây, đường sau thấy `signaled_level` đã khớp nên không báo lần hai. Gọi trong `tenantTx`.
   */
  async lockProjectUsageForSignal() {
    const [row] = await this.prisma.$queryRaw<
      {
        level: string;
        signaledLevel: string | null;
        notifiedLevel: string | null;
        notifiedAt: Date | null;
        usedBytes: bigint;
        bloatFactor: number;
        suggestions: unknown;
        calibratedAt: Date | null;
        measuredAt: Date | null;
      }[]
    >(Prisma.sql`
      SELECT level, signaled_level AS "signaledLevel", notified_level AS "notifiedLevel", notified_at AS "notifiedAt",
             used_bytes AS "usedBytes", bloat_factor::float8 AS "bloatFactor", suggestions, calibrated_at AS "calibratedAt",
             measured_at AS "measuredAt"
      FROM hub.project_usage WHERE tenant_id = ${this.tenantId}::uuid FOR UPDATE`);
    return row ? { ...row, usedBytes: Number(row.usedBytes), bloatFactor: Number(row.bloatFactor) } : null;
  }

  /** QT6: ghi dấu "đã báo" + dấu email theo nấc (cùng transaction với alert/webhook/email của lần báo). */
  async markStorageSignaled(m: { signaledLevel: string; notifiedLevel: string | null; notifiedAt: Date | null }): Promise<void> {
    await this.prisma.$executeRaw(Prisma.sql`
      UPDATE hub.project_usage SET signaled_level = ${m.signaledLevel}, notified_level = ${m.notifiedLevel}, notified_at = ${m.notifiedAt}
      WHERE tenant_id = ${this.tenantId}::uuid`);
  }

  /**
   * QT2 hiệu chỉnh (E2, §2): quét THẬT dung lượng của project — MỘT truy vấn gộp theo source (không giữ transaction dài):
   * `raw_events.body_raw` (octet_length), `events.data`, `deliveries.last_error`, `delivery_attempts` (request/response/
   * error) qua pg_column_size, `audit_logs` (metadata + reason). Không tính index/TOAST overhead — số liệu ƯỚC TÍNH.
   * `bodyRawBytes` = mẫu số của hệ số phình. Khoá `bySource`: id source; `_none` = event không còn source; `_audit`.
   */
  async measureStorage(opts: { statementTimeoutMs?: number } = {}): Promise<{ totalBytes: number; bodyRawBytes: number; bySource: Record<string, number> }> {
    const t = this.tenantId;
    // Review QT-S1 M2: = `SET LOCAL statement_timeout` (is_local = true -> chỉ sống trong transaction đang chạy, an toàn với
    // pgbouncer). Postgres tự huỷ câu quét quá lâu (57014) TRƯỚC khi transaction tương tác của Prisma hết hạn.
    const ms = opts.statementTimeoutMs;
    if (ms !== undefined && Number.isFinite(ms) && ms > 0) {
      await this.prisma.$executeRaw`SELECT set_config('statement_timeout', ${String(Math.floor(ms))}, true)`;
    }
    const rows = await this.prisma.$queryRaw<{ k: string; raw: bigint; other: bigint }[]>(Prisma.sql`
      WITH r AS (
        SELECT r.source_id::text AS k, sum(octet_length(r.body_raw))::bigint AS raw
        FROM hub.raw_events r JOIN hub.sources s ON s.id = r.source_id
        WHERE s.tenant_id = ${t}::uuid GROUP BY r.source_id),
      e AS (
        SELECT COALESCE(e.source_id::text, '_none') AS k, sum(COALESCE(pg_column_size(e.data), 0))::bigint AS b
        FROM hub.events e WHERE e.tenant_id = ${t}::uuid GROUP BY 1),
      a AS (
        SELECT a.delivery_id, sum(COALESCE(pg_column_size(a.request_body), 0) + COALESCE(pg_column_size(a.response_body), 0)
                                  + COALESCE(pg_column_size(a.error), 0))::bigint AS b
        FROM hub.delivery_attempts a
        WHERE a.delivery_id IN (SELECT id FROM hub.deliveries WHERE tenant_id = ${t}::uuid) GROUP BY a.delivery_id),
      d AS (
        SELECT COALESCE(e.source_id::text, '_none') AS k, sum(COALESCE(pg_column_size(d.last_error), 0) + COALESCE(a.b, 0))::bigint AS b
        FROM hub.deliveries d JOIN hub.events e ON e.id = d.event_id LEFT JOIN a ON a.delivery_id = d.id
        WHERE d.tenant_id = ${t}::uuid GROUP BY 1),
      au AS (
        SELECT '_audit'::text AS k, sum(COALESCE(pg_column_size(metadata), 0) + COALESCE(octet_length(reason), 0))::bigint AS b
        FROM hub.audit_logs WHERE tenant_id = ${t}::uuid),
      keys AS (SELECT k FROM r UNION SELECT k FROM e UNION SELECT k FROM d UNION SELECT k FROM au)
      SELECT keys.k, COALESCE(r.raw, 0)::bigint AS raw, (COALESCE(e.b, 0) + COALESCE(d.b, 0) + COALESCE(au.b, 0))::bigint AS other
      FROM keys LEFT JOIN r ON r.k = keys.k LEFT JOIN e ON e.k = keys.k LEFT JOIN d ON d.k = keys.k LEFT JOIN au ON au.k = keys.k`);
    const bySource: Record<string, number> = {};
    let totalBytes = 0;
    let bodyRawBytes = 0;
    for (const r of rows) {
      const raw = Number(r.raw);
      const sum = raw + Number(r.other);
      bodyRawBytes += raw;
      totalBytes += sum;
      if (sum > 0) bySource[r.k] = sum;
    }
    return { totalBytes, bodyRawBytes, bySource };
  }

  /**
   * QT2 (E2): đặt lại mốc hiệu chỉnh — `calibrated_at = now()` (đồng hồ DB), `freed_since_calibration = 0`, `used_bytes` =
   * số vừa quét. Chưa có dòng thì tạo (project tạo trước khi có seed).
   * QT4: `byBucket` (§7) ghi cùng lúc. `freedBaseline` = `freed_since_calibration` đọc NGAY TRƯỚC khi quét: lô dọn COMMIT
   * trong lúc quét (số quét có thể chưa thấy) không bị xoá mất — phần freed tăng thêm sau mốc đọc được giữ lại và trừ khỏi
   * `used_bytes` (sai số còn lại: lô COMMIT giữa lúc đọc mốc và lúc câu quét bắt đầu — vài ms, lần hiệu chỉnh kế sửa).
   */
  async saveStorageCalibration(m: {
    calibratedBytes: number;
    bloatFactor: number;
    bySource: Record<string, number>;
    level: string;
    byBucket?: unknown[];
    freedBaseline?: number;
  }): Promise<number> {
    const t = this.tenantId;
    // Không truyền mốc -> coi như mọi freed đã nằm trong số quét (đặt lại 0, hành vi QT2).
    const base = m.freedBaseline === undefined ? Number.MAX_SAFE_INTEGER : Math.max(0, Math.round(m.freedBaseline));
    const bucket = m.byBucket ? Prisma.sql`, by_bucket = ${JSON.stringify(m.byBucket)}::jsonb` : Prisma.empty;
    return this.prisma.$executeRaw(Prisma.sql`
      INSERT INTO hub.project_usage AS pu (tenant_id, used_bytes, calibrated_bytes, calibrated_at, freed_since_calibration, bloat_factor, by_source, by_bucket, level, measured_at)
      VALUES (${t}::uuid, ${m.calibratedBytes}::bigint, ${m.calibratedBytes}::bigint, now(), 0, ${m.bloatFactor}::numeric, ${JSON.stringify(m.bySource)}::jsonb,
              ${JSON.stringify(m.byBucket ?? [])}::jsonb, ${m.level}, now())
      ON CONFLICT (tenant_id) DO UPDATE SET
        used_bytes = GREATEST(0, EXCLUDED.used_bytes - GREATEST(0, pu.freed_since_calibration - ${base}::bigint)),
        calibrated_bytes = EXCLUDED.calibrated_bytes, calibrated_at = EXCLUDED.calibrated_at,
        freed_since_calibration = GREATEST(0, pu.freed_since_calibration - ${base}::bigint), bloat_factor = EXCLUDED.bloat_factor,
        by_source = EXCLUDED.by_source, level = EXCLUDED.level, measured_at = EXCLUDED.measured_at ${bucket}`);
  }

  /**
   * QT2 (E2): job cập nhật nấc ghi lại số cộng dồn + nấc (chỉ gọi khi có đổi). Review QT-S1 L1: compare-and-set theo mốc
   * hiệu chỉnh ĐÃ ĐỌC (`calibratedAtToken` = `calibrated_at::text`, đủ µs — Date của JS chỉ tới ms). Hiệu chỉnh ghi mốc
   * mới xen giữa lúc đọc và lúc ghi -> 0 dòng: số quét thật thắng, lượt nấc sau tính lại từ mốc mới.
   * QT4 (E2): thêm `freedToken` — một lô dọn vừa cộng `freed_since_calibration` (và hạ nấc NGAY) xen giữa thì lượt nấc đọc
   * số cũ KHÔNG được ghi đè lên (nấc bật ngược lại tới 60s); 0 dòng, lượt sau tính lại.
   */
  async updateStorageUsage(m: { usedBytes: number; level: string; calibratedAtToken: string | null; freedToken?: number }): Promise<number> {
    const freed = m.freedToken === undefined ? Prisma.empty : Prisma.sql`AND freed_since_calibration = ${Math.round(m.freedToken)}::bigint`;
    return this.prisma.$executeRaw(Prisma.sql`
      UPDATE hub.project_usage SET used_bytes = ${m.usedBytes}::bigint, level = ${m.level}, measured_at = now()
      WHERE tenant_id = ${this.tenantId}::uuid
        AND calibrated_at IS NOT DISTINCT FROM ${m.calibratedAtToken}::timestamptz ${freed}`);
  }

  // --- QT4: dọn tay / tự động (SPEC-han-muc-dung-luong §5.1–§5.5 + E2, ADR-184) ---

  /**
   * MỘT lô dọn của project — mọi thứ trong CÙNG transaction (repo trên client gốc = một transaction; worker gọi trong
   * `tenantTx` có hạn rõ ràng): chọn nạn nhân (`FOR UPDATE SKIP LOCKED`) → đo byte TRƯỚC (đúng công thức §2 như
   * `measureStorage`) → dọn/xoá → đo SAU → cộng phần chênh vào `freed_since_calibration`, trừ `used_bytes` và TÍNH LẠI NẤC
   * ngay (E2: mở khoá không chờ job 60s).
   *
   * Bất biến (§5.2, §14) nằm trong SQL, không phụ thuộc người gọi:
   *  - không bao giờ đụng event còn delivery `PENDING`/`DELIVERING`/`RETRYING`, hay event/mẫu nhận SAU `floor`
   *    (= now − cửa sổ retry, người gọi truyền từ `TOTAL_RETRY_WINDOW_MS`);
   *  - không bao giờ đụng source "Giữ lâu" (mức `keep`); `audit_logs` không có trong câu nào;
   *  - "Dọn" (`trim`) KHÔNG xoá dòng `events`/`raw_events`: khoá chống trùng còn nguyên (BB-2, QT:T15);
   *    "Xoá hẳn" (`delete`) xoá cả hai — mất chống trùng (QT:T16, đánh đổi có chủ đích).
   * Mẫu REJECTED (`junk`) chỉ xoá hẳn. `done` = lô không đầy (hết việc).
   */
  async cleanStorageBatch(o: {
    action: 'trim' | 'delete';
    importance: readonly string[];
    cutoff: Date;
    floor: Date;
    sourceId?: string | null;
    limit: number;
    quotaBytes: number;
  }): Promise<CleanBatchResult> {
    const t = this.tenantId;
    const before = o.cutoff.getTime() < o.floor.getTime() ? o.cutoff : o.floor;
    let rejected = 0;
    let freed = 0;
    if (o.action === 'delete' && o.importance.includes('junk')) {
      const src = o.sourceId ? Prisma.sql`AND s.id = ${o.sourceId}::uuid` : Prisma.empty;
      const [r] = await this.prisma.$queryRaw<{ n: number; b: bigint | null }[]>(Prisma.sql`
        WITH v AS (
          SELECT r.id FROM hub.raw_events r JOIN hub.sources s ON s.id = r.source_id
          WHERE s.tenant_id = ${t}::uuid AND r.status = 'REJECTED' AND r.received_at < ${before} AND NOT s.keep_longer ${src}
          ORDER BY r.received_at LIMIT ${o.limit} FOR UPDATE OF r SKIP LOCKED),
        d AS (DELETE FROM hub.raw_events r USING v WHERE r.id = v.id RETURNING octet_length(r.body_raw) AS b)
        SELECT count(*)::int AS n, sum(b)::bigint AS b FROM d`);
      rejected = Number(r?.n ?? 0);
      freed += Number(r?.b ?? 0);
    }
    const eventImportance = o.importance.filter((i) => i !== 'junk' && i !== 'keep');
    const room = o.limit - rejected;
    let events = 0;
    if (eventImportance.length > 0 && room > 0) {
      const onlyUntrimmed = o.action === 'trim' ? Prisma.sql`AND e.trimmed_at IS NULL` : Prisma.empty;
      const bySource = o.sourceId ? Prisma.sql`AND e.source_id = ${o.sourceId}::uuid` : Prisma.empty;
      const victims = await this.prisma.$queryRaw<{ id: string; rawEventId: string | null }[]>(Prisma.sql`
        SELECT e.id, e.raw_event_id AS "rawEventId"
        FROM hub.events e LEFT JOIN hub.sources s ON s.id = e.source_id AND s.tenant_id = e.tenant_id
        WHERE e.tenant_id = ${t}::uuid AND e.received_at < ${before} ${onlyUntrimmed} ${bySource}
          AND NOT EXISTS (SELECT 1 FROM hub.deliveries d WHERE d.event_id = e.id AND d.tenant_id = e.tenant_id
                          AND d.status IN ('PENDING', 'DELIVERING', 'RETRYING'))
          AND ${eventImportanceSql} = ANY(${eventImportance}::text[])
        ORDER BY e.received_at LIMIT ${room} FOR UPDATE OF e SKIP LOCKED`);
      events = victims.length;
      if (events > 0) {
        const ids = victims.map((v) => v.id);
        const rawIds = victims.map((v) => v.rawEventId).filter((x): x is string => !!x);
        const sizeBefore = await this.eventSetBytes(ids);
        if (o.action === 'trim') {
          await this.prisma.$executeRaw(Prisma.sql`
            UPDATE hub.events SET data = 'null'::jsonb, trimmed_at = now() WHERE tenant_id = ${t}::uuid AND id = ANY(${ids}::text[])`);
          if (rawIds.length > 0) {
            await this.prisma.$executeRaw(Prisma.sql`
              UPDATE hub.raw_events r SET body_raw = ''::bytea, body = 'null'::jsonb, headers = '{}'::jsonb, trimmed_at = now()
              FROM hub.sources s WHERE s.id = r.source_id AND s.tenant_id = ${t}::uuid AND r.id = ANY(${rawIds}::uuid[])`);
          }
          await this.prisma.$executeRaw(Prisma.sql`
            UPDATE hub.deliveries SET last_error = left(last_error, ${TRIM_KEEP_CHARS}::int)
            WHERE tenant_id = ${t}::uuid AND event_id = ANY(${ids}::text[]) AND length(last_error) > ${TRIM_KEEP_CHARS}::int`);
          await this.prisma.$executeRaw(Prisma.sql`
            UPDATE hub.delivery_attempts a SET request_body = NULL, response_body = NULL, error = left(a.error, ${TRIM_KEEP_CHARS}::int)
            FROM hub.deliveries d WHERE d.id = a.delivery_id AND d.tenant_id = ${t}::uuid AND d.event_id = ANY(${ids}::text[])
              AND (a.request_body IS NOT NULL OR a.response_body IS NOT NULL OR length(a.error) > ${TRIM_KEEP_CHARS}::int)`);
          freed += Math.max(0, sizeBefore - (await this.eventSetBytes(ids)));
        } else {
          // deliveries + delivery_attempts đi theo CASCADE; raw_events (FK SET NULL từ events) xoá riêng, cùng tenant.
          await this.prisma.$executeRaw(Prisma.sql`DELETE FROM hub.events WHERE tenant_id = ${t}::uuid AND id = ANY(${ids}::text[])`);
          if (rawIds.length > 0) {
            await this.prisma.$executeRaw(Prisma.sql`
              DELETE FROM hub.raw_events r USING hub.sources s
              WHERE s.id = r.source_id AND s.tenant_id = ${t}::uuid AND r.id = ANY(${rawIds}::uuid[])`);
          }
          freed += sizeBefore;
        }
      }
    }
    // Review QT-S2 H1 (bổ sung ADR-184): raw ACCEPTED MỒ CÔI — event của nó đã bị retention xoá (raw giữ theo ADR-045, FK
    // SET NULL) hoặc adapter chuẩn hoá ra 0 event. `measureStorage` đếm byte của chúng nên lệnh dọn PHẢI với tới được, không
    // thì khoá 507 thành bẫy (§13). Mức quan trọng theo `orphanRawImportanceSql` (CÙNG biểu thức với `by_bucket`): ứng viên
    // renormalize còn trong hạn (ADR-045 / S1-3) = `high` (chỉ dọn khi xác nhận Cao), còn lại `low`, source Giữ lâu = `keep`.
    // Cùng sàn retry (`before`). "Dọn" = body rỗng, GIỮ dòng (khoá chống trùng còn, BB-2); "Xoá hẳn" = xoá dòng. Số dòng cộng
    // vào `events` (một ô `by_bucket` của raw mồ côi cũng đếm là một "event").
    const orphanImportance = eventImportance;
    const roomRaw = o.limit - rejected - events;
    let orphans = 0;
    if (orphanImportance.length > 0 && roomRaw > 0) {
      const src = o.sourceId ? Prisma.sql`AND s.id = ${o.sourceId}::uuid` : Prisma.empty;
      const onlyUntrimmed = o.action === 'trim' ? Prisma.sql`AND r.trimmed_at IS NULL` : Prisma.empty;
      const op =
        o.action === 'trim'
          ? Prisma.sql`UPDATE hub.raw_events r SET body_raw = ''::bytea, body = 'null'::jsonb, headers = '{}'::jsonb, trimmed_at = now()
                       FROM v WHERE r.id = v.id RETURNING v.b`
          : Prisma.sql`DELETE FROM hub.raw_events r USING v WHERE r.id = v.id RETURNING v.b`;
      const [r] = await this.prisma.$queryRaw<{ n: number; b: bigint | null }[]>(Prisma.sql`
        WITH v AS (
          SELECT r.id, octet_length(r.body_raw) AS b FROM hub.raw_events r JOIN hub.sources s ON s.id = r.source_id
          WHERE s.tenant_id = ${t}::uuid AND r.status = 'ACCEPTED' AND r.received_at < ${before} ${src} ${onlyUntrimmed}
            AND NOT EXISTS (SELECT 1 FROM hub.events e WHERE e.raw_event_id = r.id)
            AND ${orphanRawImportanceSql()} = ANY(${orphanImportance}::text[])
          ORDER BY r.received_at LIMIT ${roomRaw} FOR UPDATE OF r SKIP LOCKED),
        d AS (${op})
        SELECT count(*)::int AS n, sum(b)::bigint AS b FROM d`);
      orphans = Number(r?.n ?? 0);
      freed += Number(r?.b ?? 0);
    }
    const level = freed > 0 ? await this.applyFreedBytes(freed, o.quotaBytes) : null;
    return { events: events + orphans, rejected, freedBytes: freed, level, done: events + orphans + rejected < o.limit };
  }

  /** Byte của một tập event theo ĐÚNG công thức §2 (`measureStorage`): events.data + body_raw + deliveries + attempts. */
  async eventSetBytes(ids: string[]): Promise<number> {
    if (ids.length === 0) return 0;
    const t = this.tenantId;
    const [r] = await this.prisma.$queryRaw<{ b: bigint | null }[]>(Prisma.sql`
      SELECT (
        (SELECT COALESCE(sum(COALESCE(pg_column_size(e.data), 0)), 0) FROM hub.events e WHERE e.tenant_id = ${t}::uuid AND e.id = ANY(${ids}::text[]))
      + (SELECT COALESCE(sum(octet_length(r.body_raw)), 0) FROM hub.events e JOIN hub.raw_events r ON r.id = e.raw_event_id
         WHERE e.tenant_id = ${t}::uuid AND e.id = ANY(${ids}::text[]))
      + (SELECT COALESCE(sum(COALESCE(pg_column_size(d.last_error), 0)), 0) FROM hub.deliveries d WHERE d.tenant_id = ${t}::uuid AND d.event_id = ANY(${ids}::text[]))
      + (SELECT COALESCE(sum(COALESCE(pg_column_size(a.request_body), 0) + COALESCE(pg_column_size(a.response_body), 0) + COALESCE(pg_column_size(a.error), 0)), 0)
         FROM hub.delivery_attempts a JOIN hub.deliveries d ON d.id = a.delivery_id WHERE d.tenant_id = ${t}::uuid AND d.event_id = ANY(${ids}::text[]))
      )::bigint AS b`);
    return Number(r?.b ?? 0);
  }

  /**
   * E2: cộng byte vừa giải phóng vào `freed_since_calibration`, trừ `used_bytes` và tính lại nấc NGAY (vùng đệm của
   * `levelFor`: LOCKED mở khi < 90%) — trong transaction của người gọi. Chưa có dòng usage (project trước seed) -> null.
   */
  async applyFreedBytes(freed: number, quotaBytes: number): Promise<StorageLevelChange | null> {
    const [row] = await this.prisma.$queryRaw<{ usedBytes: bigint; level: string }[]>(Prisma.sql`
      UPDATE hub.project_usage SET freed_since_calibration = freed_since_calibration + ${Math.round(freed)}::bigint,
             used_bytes = GREATEST(0, used_bytes - ${Math.round(freed)}::bigint), measured_at = now()
      WHERE tenant_id = ${this.tenantId}::uuid
      RETURNING used_bytes AS "usedBytes", level`);
    if (!row) return null;
    return this.writeLevel(Number(row.usedBytes), row.level, quotaBytes);
  }

  /** Tính lại nấc từ `used_bytes` hiện có (sau retention xuyên project đã trừ byte trong systemTx). */
  async recomputeStorageLevel(quotaBytes: number): Promise<StorageLevelChange | null> {
    const [row] = await this.prisma.$queryRaw<{ usedBytes: bigint; level: string }[]>(Prisma.sql`
      SELECT used_bytes AS "usedBytes", level FROM hub.project_usage WHERE tenant_id = ${this.tenantId}::uuid FOR UPDATE`);
    if (!row) return null;
    return this.writeLevel(Number(row.usedBytes), row.level, quotaBytes);
  }

  private async writeLevel(usedBytes: number, prev: string, quotaBytes: number): Promise<StorageLevelChange> {
    const to = levelFor(usedBytes, quotaBytes, parseStorageLevel(prev));
    if (to !== prev) {
      await this.prisma.$executeRaw(Prisma.sql`UPDATE hub.project_usage SET level = ${to} WHERE tenant_id = ${this.tenantId}::uuid`);
    }
    return { from: prev, to, usedBytes };
  }

  /**
   * §7 + E2 (QT4): `by_bucket` — byte + số event CHƯA dọn theo (source, mức quan trọng, tuổi theo ngày), cùng công thức §2
   * và CÙNG biểu thức mức quan trọng với lệnh dọn (`eventImportanceSql`), cộng mẫu REJECTED (`junk`) và raw ACCEPTED mồ côi
   * (`orphanRawImportanceSql`, review QT-S2 H1) — mọi byte `measureStorage` đếm đều nằm trong một ô dọn được. Chạy trong lượt hiệu
   * chỉnh (24h, transaction có hạn của job), không bao giờ trên đường nóng. Số liệu có thể cũ tới 24h (console ghi "tính lúc").
   */
  async measureStorageBuckets(): Promise<StorageBucketRow[]> {
    const t = this.tenantId;
    const rows = await this.prisma.$queryRaw<{ sourceId: string | null; importance: string; ageDays: number; events: number; bytes: bigint }[]>(Prisma.sql`
      WITH ev AS (
        SELECT e.source_id, ${eventImportanceSql} AS imp,
               LEAST(${BUCKET_MAX_AGE}::int, floor(extract(epoch FROM now() - e.received_at) / 86400)::int) AS age,
               COALESCE(pg_column_size(e.data), 0)
               + COALESCE((SELECT octet_length(r.body_raw) FROM hub.raw_events r WHERE r.id = e.raw_event_id), 0)
               + COALESCE((SELECT sum(COALESCE(pg_column_size(d.last_error), 0)
                                      + COALESCE((SELECT sum(COALESCE(pg_column_size(a.request_body), 0) + COALESCE(pg_column_size(a.response_body), 0)
                                                             + COALESCE(pg_column_size(a.error), 0)) FROM hub.delivery_attempts a WHERE a.delivery_id = d.id), 0))
                           FROM hub.deliveries d WHERE d.event_id = e.id AND d.tenant_id = e.tenant_id), 0) AS b
        FROM hub.events e LEFT JOIN hub.sources s ON s.id = e.source_id AND s.tenant_id = e.tenant_id
        WHERE e.tenant_id = ${t}::uuid AND e.trimmed_at IS NULL),
      rj AS (
        SELECT r.source_id, CASE WHEN s.keep_longer THEN 'keep' ELSE 'junk' END AS imp,
               LEAST(${BUCKET_MAX_AGE}::int, floor(extract(epoch FROM now() - r.received_at) / 86400)::int) AS age,
               octet_length(r.body_raw) AS b
        FROM hub.raw_events r JOIN hub.sources s ON s.id = r.source_id
        WHERE s.tenant_id = ${t}::uuid AND r.status = 'REJECTED'),
      orph AS (
        SELECT r.source_id, ${orphanRawImportanceSql()} AS imp,
               LEAST(${BUCKET_MAX_AGE}::int, floor(extract(epoch FROM now() - r.received_at) / 86400)::int) AS age,
               octet_length(r.body_raw) AS b
        FROM hub.raw_events r JOIN hub.sources s ON s.id = r.source_id
        WHERE s.tenant_id = ${t}::uuid AND r.status = 'ACCEPTED' AND r.trimmed_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM hub.events e WHERE e.raw_event_id = r.id))
      SELECT source_id::text AS "sourceId", imp AS importance, age AS "ageDays", count(*)::int AS events, sum(b)::bigint AS bytes FROM ev GROUP BY 1, 2, 3
      UNION ALL
      SELECT source_id::text, imp, age, count(*)::int, sum(b)::bigint FROM rj GROUP BY 1, 2, 3
      UNION ALL
      SELECT source_id::text, imp, age, count(*)::int, sum(b)::bigint FROM orph GROUP BY 1, 2, 3`);
    return rows.map((r) => ({ sourceId: r.sourceId, importance: r.importance, ageDays: Number(r.ageDays), events: Number(r.events), bytes: Number(r.bytes ?? 0) }));
  }

  /** E2: Σ byte (cột `bytes` của bảng lưu lượng) nhận từ `since` — tốc độ tăng cho "còn ~X giờ" và `growthPerDay`. */
  async trafficBytesSince(since: Date): Promise<number> {
    const [r] = await this.prisma.$queryRaw<{ b: bigint | null }[]>(Prisma.sql`
      SELECT sum(bytes)::bigint AS b FROM hub.source_traffic_minutely WHERE tenant_id = ${this.tenantId}::uuid AND minute >= ${since}`);
    return Number(r?.b ?? 0);
  }

  // --- QT5: policy dọn tự động (SPEC §5.4, ADR-186) ---

  /**
   * Ghi đè (upsert) policy của các mức được gửi — chỉ junk/low/medium (CHECK của bảng chặn thêm một lớp). Gọi trong
   * transaction có audit của người gọi.
   */
  async upsertStoragePolicies(rows: { importance: string; action: string; afterDays: number; trigger: string }[], updatedBy: string): Promise<void> {
    for (const r of rows) {
      await this.prisma.storagePolicy.upsert({
        where: { tenantId_importance: { tenantId: this.tenantId, importance: r.importance } },
        create: { tenantId: this.tenantId, importance: r.importance, action: r.action, afterDays: r.afterDays, trigger: r.trigger, updatedBy },
        update: { action: r.action, afterDays: r.afterDays, trigger: r.trigger, updatedBy, updatedAt: new Date() },
      });
    }
  }

  /** Dòng audit mới nhất của một hành động (vd lần dọn tự động gần nhất — "đã giải phóng X MB"). */
  async findLatestAuditLog(action: string) {
    return this.prisma.auditLog.findFirst({ where: { tenantId: this.tenantId, action }, orderBy: { createdAt: 'desc' } });
  }

  // --- QT4b: gợi ý dọn (SPEC §5.6, ADR-187) ---

  /** Lưu bộ gợi ý mới nhất (ĐÃ qua `assertSuggestionSafe`) vào `project_usage.suggestions`. */
  async saveStorageSuggestions(suggestions: unknown[]): Promise<number> {
    return this.prisma.$executeRaw(Prisma.sql`
      UPDATE hub.project_usage SET suggestions = ${JSON.stringify(suggestions)}::jsonb WHERE tenant_id = ${this.tenantId}::uuid`);
  }

  /** Đã phát `hub.project.cleanup_suggested`: mốc cho luật "không quá 1 lần/ngày" và "đổi ≥ 10% quota" — cùng transaction với event. */
  async markCleanupSuggestedEmitted(totalBytes: number): Promise<number> {
    return this.prisma.$executeRaw(Prisma.sql`
      UPDATE hub.project_usage SET suggested_at = now(), suggested_bytes = ${Math.round(totalBytes)}::bigint WHERE tenant_id = ${this.tenantId}::uuid`);
  }

  /** id các source "Giữ lâu" của project (kể cả đã lưu trữ — lịch sử của chúng vẫn được giữ). */
  async findKeepLongerSourceIds(): Promise<string[]> {
    const rows = await this.prisma.source.findMany({ where: { tenantId: this.tenantId, keepLonger: true }, select: { id: true } });
    return rows.map((r) => r.id);
  }

  // --- QT4: lệnh dọn (bảng storage_clean_jobs) ---

  async createStorageCleanJob(input: {
    id: string;
    action: 'trim' | 'delete';
    importance: string[];
    olderThan: string;
    cutoff: Date;
    sourceId: string | null;
    origin: 'manual' | 'suggestion';
    suggestionId?: string | null;
    advisor?: string | null;
    requestedBy: string;
  }) {
    return this.prisma.storageCleanJob.create({
      data: {
        id: input.id,
        tenantId: this.tenantId,
        action: input.action,
        importance: input.importance,
        olderThan: input.olderThan,
        cutoff: input.cutoff,
        sourceId: input.sourceId,
        origin: input.origin,
        suggestionId: input.suggestionId ?? null,
        advisor: input.advisor ?? null,
        requestedBy: input.requestedBy,
      },
    });
  }

  async findStorageCleanJob(id: string) {
    return this.prisma.storageCleanJob.findFirst({ where: { id, tenantId: this.tenantId } });
  }

  async listStorageCleanJobs(take = 10) {
    return this.prisma.storageCleanJob.findMany({ where: { tenantId: this.tenantId }, orderBy: { createdAt: 'desc' }, take });
  }

  /**
   * QT4b `apply` idempotent theo id gợi ý: lệnh đã tạo cho CÙNG id kể từ `since` (lúc bộ gợi ý hiện tại được tính). Khoá
   * advisory theo (project, id gợi ý) trong transaction của người gọi -> hai lần gọi song song không tạo hai lệnh. PHẢI gọi
   * trên repo dựng trong `tx` (khoá nhả khi transaction kết thúc).
   */
  async lockAndFindCleanJobForSuggestion(suggestionId: string, since: Date) {
    await this.prisma.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'storage-apply:' + this.tenantId + ':' + suggestionId}, 0))`;
    return this.prisma.storageCleanJob.findFirst({
      where: { tenantId: this.tenantId, suggestionId, createdAt: { gte: since } },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Tiến độ của lệnh sau MỘT lô — gọi trong CÙNG transaction với lô (số đếm khớp dữ liệu đã đổi, kể cả khi worker chết).
   * Review QT-S2 L1: chỉ ghi khi lệnh còn `RUNNING` và (nếu có) `attempts` = lượt nhận của CHÍNH worker này (fencing) —
   * worker treo quá lease rồi tỉnh dậy không ghi đè DONE/tiến độ của worker đã nhận lại. Trả số dòng: 0 = đã mất lệnh,
   * người gọi phải bỏ lô (ném để rollback).
   */
  async recordCleanJobBatch(
    id: string,
    r: { events: number; rejected: number; freedBytes: number; done: boolean; leaseMs: number; attempts?: number },
  ): Promise<number> {
    const fence = r.attempts === undefined ? Prisma.empty : Prisma.sql`AND attempts = ${r.attempts}::int`;
    const finished = r.done ? Prisma.sql`now()` : Prisma.sql`NULL`;
    const lease = r.done ? Prisma.sql`NULL` : Prisma.sql`now() + make_interval(secs => ${r.leaseMs / 1000}::double precision)`;
    return this.prisma.$executeRaw(Prisma.sql`
      UPDATE hub.storage_clean_jobs SET
        events_affected = events_affected + ${r.events}::int, rejected_affected = rejected_affected + ${r.rejected}::int,
        freed_bytes = freed_bytes + ${Math.round(r.freedBytes)}::bigint, batches = batches + 1,
        status = ${r.done ? 'DONE' : 'RUNNING'}, finished_at = ${finished}, lease_until = ${lease}
      WHERE tenant_id = ${this.tenantId}::uuid AND id = ${id}::uuid AND status = 'RUNNING' ${fence}`);
  }

  async failCleanJob(id: string, error: string): Promise<void> {
    await this.prisma.$executeRaw(Prisma.sql`
      UPDATE hub.storage_clean_jobs SET status = 'FAILED', error = ${error.slice(0, 500)}, finished_at = now(), lease_until = NULL
      WHERE tenant_id = ${this.tenantId}::uuid AND id = ${id}::uuid`);
  }

  async addIngestDuplicates(rows:{ sourceId: string; bucket: Date; n: number }[]): Promise<number> {
    const valid = rows.filter((r) => r.n > 0);
    if (valid.length === 0) return 0;
    return this.prisma.$executeRaw(Prisma.sql`
      INSERT INTO hub.ingest_duplicates (tenant_id, source_id, bucket, n)
      VALUES ${Prisma.join(valid.map((r) => Prisma.sql`(${this.tenantId}::uuid, ${r.sourceId}::uuid, ${r.bucket}, ${r.n}::int)`))}
      ON CONFLICT (tenant_id, source_id, bucket) DO UPDATE SET n = hub.ingest_duplicates.n + EXCLUDED.n`);
  }

  /**
   * EG4 (ADR-179): cộng lưu lượng theo (source, phút, outcome) — MỘT câu `INSERT … ON CONFLICT DO UPDATE` cho cả lô của
   * project. `count` cộng dồn (nhiều instance cùng ghi vẫn đúng); `top_ips` gộp hai bên rồi giữ 5 IP nhiều nhất.
   * Người gọi xếp dòng theo (source, minute, outcome) và không lặp khoá trong một lô.
   */
  async addSourceTraffic(rows: SourceTrafficRow[]): Promise<number> {
    const valid = rows.filter((r) => r.count > 0);
    if (valid.length === 0) return 0;
    return this.prisma.$executeRaw(Prisma.sql`
      INSERT INTO hub.source_traffic_minutely AS t (tenant_id, source_id, minute, outcome, count, bytes, top_ips)
      VALUES ${Prisma.join(valid.map((r) => Prisma.sql`(${this.tenantId}::uuid, ${r.sourceId}::uuid, ${r.minute}, ${r.outcome}::"hub"."TrafficOutcome", ${r.count}::int, ${Math.max(0, Math.floor(r.bytes ?? 0))}::bigint, ${JSON.stringify(r.topIps.slice(0, 5))}::jsonb)`))}
      ON CONFLICT (tenant_id, source_id, minute, outcome) DO UPDATE SET
        count = t.count + EXCLUDED.count,
        bytes = t.bytes + EXCLUDED.bytes,
        top_ips = (
          SELECT coalesce(jsonb_agg(jsonb_build_object('ip', m.ip, 'count', m.c) ORDER BY m.c DESC, m.ip), '[]'::jsonb)
          FROM (
            SELECT u.ip, sum(u.c)::int AS c
            FROM (
              SELECT e->>'ip' AS ip, (e->>'count')::int AS c FROM jsonb_array_elements(t.top_ips) e
              UNION ALL
              SELECT e->>'ip', (e->>'count')::int FROM jsonb_array_elements(EXCLUDED.top_ips) e
            ) u
            GROUP BY u.ip ORDER BY c DESC, u.ip LIMIT 5
          ) m
        )`);
  }

  /**
   * EG5 (ADR-181): lưu lượng của MỘT source từ `since`, gộp theo cột `bucketSec` giây và outcome. Dùng tiền tố PK
   * `(tenant_id, source_id, minute)`. Tối đa 5 outcome × (span / bucket) dòng (7 ngày theo giờ = 840).
   */
  async sourceTrafficBuckets(sourceId: string, since: Date, bucketSec: number): Promise<{ t: Date; outcome: string; n: number }[]> {
    return this.prisma.$queryRaw<{ t: Date; outcome: string; n: number }[]>(Prisma.sql`
      SELECT to_timestamp(floor(extract(epoch FROM minute) / ${bucketSec}::int) * ${bucketSec}::int) AS t,
             outcome::text AS outcome, sum(count)::int AS n
      FROM hub.source_traffic_minutely
      WHERE tenant_id = ${this.tenantId}::uuid AND source_id = ${sourceId}::uuid AND minute >= ${since}
      GROUP BY 1, 2 ORDER BY 1`);
  }

  /**
   * EG5: IP gửi nhiều nhất vào một source từ `since` — gộp `top_ips` (≤ 5 IP mỗi phút × outcome, nên là XẤP XỈ), kèm số
   * request sai chữ ký (outcome REJECTED) và lần cuối thấy.
   */
  async sourceTrafficTopIps(sourceId: string, since: Date, limit: number): Promise<{ ip: string; count: number; rejected: number; lastSeen: Date }[]> {
    return this.prisma.$queryRaw<{ ip: string; count: number; rejected: number; lastSeen: Date }[]>(Prisma.sql`
      SELECT e->>'ip' AS ip, sum((e->>'count')::int)::int AS count,
             sum(CASE WHEN t.outcome = 'REJECTED' THEN (e->>'count')::int ELSE 0 END)::int AS rejected,
             max(t.minute) AS "lastSeen"
      FROM hub.source_traffic_minutely t, jsonb_array_elements(t.top_ips) e
      WHERE t.tenant_id = ${this.tenantId}::uuid AND t.source_id = ${sourceId}::uuid AND t.minute >= ${since}
      GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT ${limit}::int`);
  }

  /**
   * `I-dup`: số bản trùng từ đầu ngày hôm nay (múi giờ của dashboard) theo provider của source. Luôn trả ≥ 1 dòng (mang
   * `since`; `provider` null khi chưa có bản trùng). Index `(tenant_id, bucket DESC)`.
   */
  async countIngestDuplicatesToday(): Promise<{ since: Date; byProvider: { provider: string; n: number }[] }> {
    const rows = await this.prisma.$queryRaw<{ since: Date; provider: string | null; n: bigint | null }[]>(Prisma.sql`
      SELECT b.since, x.provider, x.n
      FROM (SELECT date_trunc('day', now(), ${TIMESERIES_TZ}) AS since) b
      LEFT JOIN LATERAL (
        SELECT s.provider::text AS provider, sum(d.n)::bigint AS n
        FROM hub.ingest_duplicates d
        JOIN hub.sources s ON s.id = d.source_id AND s.tenant_id = d.tenant_id
        WHERE d.tenant_id = ${this.tenantId}::uuid AND d.bucket >= b.since
        GROUP BY 1
      ) x ON true`);
    return {
      since: rows[0].since,
      byProvider: rows.filter((r) => r.provider !== null).map((r) => ({ provider: r.provider as string, n: Number(r.n ?? 0) })),
    };
  }

  /**
   * `I-dead`: DLQ (DEAD + `notSuperseded`, ĐÚNG điều kiện bảng DLQ), dừng ở `cap`, tách hai phần (review CB6 TB1):
   * `total` = cần xử lý (loại D9: DEAD vì đích lưu trữ / subscription hoặc đích có `archived_at` — như `countDeadForSpike`),
   * `excludedArchived` = phần D9 (bảng DLQ vẫn liệt kê để đối soát), `recent` = trong `total`, thành DEAD từ `recentSince`.
   * Index một phần `deliveries(tenant_id, updated_at DESC) WHERE status='DEAD'`.
   */
  async countDlqForInsight(
    recentSince: Date,
    archivedErrorPrefix: string,
    cap: number,
  ): Promise<{ total: number; recent: number; excludedArchived: number; capped: boolean }> {
    const [row] = await this.prisma.$queryRaw<{ total: bigint; recent: bigint; archived: bigint; scanned: bigint }[]>(Prisma.sql`
      SELECT count(*) FILTER (WHERE NOT x.archived) AS total,
             count(*) FILTER (WHERE NOT x.archived AND x.updated_at >= ${recentSince}) AS recent,
             count(*) FILTER (WHERE x.archived) AS archived,
             count(*) AS scanned
      FROM (
        SELECT d.updated_at,
               (s.archived_at IS NOT NULL OR dst.archived_at IS NOT NULL
                OR (d.last_error IS NOT NULL AND left(d.last_error, ${archivedErrorPrefix.length}::int) = ${archivedErrorPrefix})) AS archived
        FROM hub.deliveries d
        JOIN hub.subscriptions s ON s.id = d.subscription_id AND s.tenant_id = d.tenant_id
        JOIN hub.destinations dst ON dst.id = s.destination_id AND dst.tenant_id = s.tenant_id
        WHERE d.tenant_id = ${this.tenantId}::uuid AND d.status = 'DEAD' AND ${notSuperseded}
        ORDER BY d.updated_at DESC
        LIMIT ${cap}
      ) x`);
    return {
      total: Number(row?.total ?? 0),
      recent: Number(row?.recent ?? 0),
      excludedArchived: Number(row?.archived ?? 0),
      capped: Number(row?.scanned ?? 0) >= cap,
    };
  }

  // --- Stats (dashboard) ---

  /**
   * Chuỗi thời gian cho biểu đồ dashboard: số event (theo `received_at`) và số delivery
   * theo trạng thái HIỆN TẠI (theo `created_at`), gom bucket giờ (24h) hoặc ngày (7d).
   *
   * Một câu SQL duy nhất: `generate_series` sinh đủ bucket (kể cả bucket rỗng = 0) rồi
   * LEFT JOIN hai bảng đã `GROUP BY date_trunc`. `tenant_id` lấy từ repo, KHÔNG từ tham số
   * (BB-5). Chỉ đọc Postgres, không chạm Redis (ngân sách Upstash). Bucket cắt theo giờ
   * Việt Nam để cột "ngày" khớp lịch người xem, không lệch 7 tiếng theo UTC.
   */
  async getTimeseries(range: TimeseriesRange): Promise<TimeseriesBucket[]> {
    const spec = TIMESERIES_SPECS[range];
    if (!spec) throw new Error(`TimeseriesRange không hợp lệ: ${String(range)}`);
    const { unit, step, span } = spec;
    const tz = TIMESERIES_TZ;

    const rows = await this.prisma.$queryRaw<
      { bucket: Date; events: bigint; succeeded: bigint; retrying: bigint; dead: bigint }[]
    >(Prisma.sql`
      WITH bounds AS (
        SELECT date_trunc(${unit}, now(), ${tz}) AS last_bucket,
               date_subtract(date_trunc(${unit}, now(), ${tz}), ${span}::interval, ${tz}) AS first_bucket
      ),
      buckets AS (
        -- Cộng/trừ interval theo CÙNG múi giờ với date_trunc (PG16): nếu session TimeZone có DST,
        -- phép tính mặc định theo session sẽ sinh bucket lệch giờ và LEFT JOIN âm thầm ra 0.
        SELECT generate_series(b.first_bucket, b.last_bucket, ${step}::interval, ${tz}) AS bucket FROM bounds b
      ),
      ev AS (
        SELECT date_trunc(${unit}, e.received_at, ${tz}) AS bucket, count(*) AS events
        FROM hub.events e, bounds b
        WHERE e.tenant_id = ${this.tenantId}::uuid AND e.received_at >= b.first_bucket
        GROUP BY 1
      ),
      dl AS (
        SELECT date_trunc(${unit}, d.created_at, ${tz}) AS bucket,
               count(*) FILTER (WHERE d.status = 'SUCCEEDED') AS succeeded,
               count(*) FILTER (WHERE d.status IN ('PENDING', 'DELIVERING', 'RETRYING')) AS retrying,
               count(*) FILTER (WHERE d.status = 'DEAD') AS dead
        FROM hub.deliveries d, bounds b
        WHERE d.tenant_id = ${this.tenantId}::uuid AND d.created_at >= b.first_bucket
        GROUP BY 1
      )
      SELECT bk.bucket,
             COALESCE(ev.events, 0) AS events,
             COALESCE(dl.succeeded, 0) AS succeeded,
             COALESCE(dl.retrying, 0) AS retrying,
             COALESCE(dl.dead, 0) AS dead
      FROM buckets bk
      LEFT JOIN ev ON ev.bucket = bk.bucket
      LEFT JOIN dl ON dl.bucket = bk.bucket
      ORDER BY bk.bucket ASC
    `);

    return rows.map((r) => ({
      bucket: new Date(r.bucket).toISOString(),
      events: Number(r.events),
      succeeded: Number(r.succeeded),
      retrying: Number(r.retrying),
      dead: Number(r.dead),
    }));
  }
}

// Bản DEAD chưa bị replay = không tồn tại generation cao hơn cho cùng (event, subscription).
// Cùng tenant là hệ quả (event thuộc đúng một tenant), nhưng vẫn ghi rõ để không ai phải suy luận.
/** QT4: "Dọn" giữ lại tối đa ngần này ký tự của cột lỗi (đủ đọc loại lỗi, bỏ phần dài). */
const TRIM_KEEP_CHARS = 200;
const BUCKET_MAX_AGE = BUCKET_MAX_AGE_DAYS;

/**
 * QT §5.3 (ADR-186) bằng SQL — CÙNG bảng với `importanceOf` (libs/common/src/storage/importance.ts), dùng chung cho lệnh dọn
 * và `by_bucket` (một định nghĩa, hai chỗ không lệch nhau; test DB `[QT:T17]` đối chiếu). Cần alias `e` (events) và `s`
 * (sources, LEFT JOIN). Delivery xét theo BẢN MỚI NHẤT mỗi subscription (replay thành công thì DEAD cũ không còn là "Cao").
 * KHÔNG đọc payload, KHÔNG xét provider (BB-1). Event không còn source (hub event, source đã mất) -> theo trạng thái giao.
 */
const eventImportanceSql = Prisma.sql`(CASE
  WHEN COALESCE(s.keep_longer, false) THEN 'keep'
  WHEN EXISTS (SELECT 1 FROM hub.deliveries d WHERE d.event_id = e.id AND d.tenant_id = e.tenant_id
               AND d.status IN ('PENDING', 'DELIVERING', 'RETRYING')) THEN 'high'
  WHEN EXISTS (SELECT 1 FROM hub.deliveries d WHERE d.event_id = e.id AND d.tenant_id = e.tenant_id
               AND d.attempt_generation > 1 AND d.created_at > now() - interval '1 day') THEN 'high'
  WHEN EXISTS (SELECT 1 FROM hub.deliveries d WHERE d.event_id = e.id AND d.tenant_id = e.tenant_id AND d.status = 'DEAD'
               AND NOT EXISTS (SELECT 1 FROM hub.deliveries n WHERE n.event_id = d.event_id AND n.subscription_id = d.subscription_id
                               AND n.attempt_generation > d.attempt_generation)) THEN 'high'
  WHEN NOT EXISTS (SELECT 1 FROM hub.deliveries d WHERE d.event_id = e.id AND d.tenant_id = e.tenant_id) THEN 'medium'
  ELSE 'low' END)`;

/**
 * Review QT-S2 H1 (bổ sung ADR-184): mức quan trọng của raw ACCEPTED mồ côi (không event nào trỏ tới — alias `r` raw, `s`
 * source). Ứng viên renormalize (chưa có `processed_messages(normalize)` và còn trong hạn retention — đúng điều kiện
 * `findOrphanRawEvents`, mục đích giữ raw của ADR-045) = `high`: việc khôi phục còn dở, như DEAD chưa replay. Phần còn lại
 * (event đã bị retention xoá, hoặc adapter cố ý ra 0 event) = `low`: vòng đời event đã xong. Source Giữ lâu = `keep`.
 */
function orphanRawImportanceSql(): Prisma.Sql {
  const retentionSecs = eventRetentionDaysFromEnv() * 86_400;
  return Prisma.sql`(CASE
  WHEN s.keep_longer THEN 'keep'
  WHEN r.received_at >= now() - make_interval(secs => ${retentionSecs}::double precision)
       AND NOT EXISTS (SELECT 1 FROM hub.processed_messages p WHERE p.consumer = 'normalize' AND p.message_id = r.id::text) THEN 'high'
  ELSE 'low' END)`;
}

const notSuperseded = Prisma.sql`NOT EXISTS (
  SELECT 1 FROM hub.deliveries n
  WHERE n.tenant_id = d.tenant_id AND n.event_id = d.event_id
    AND n.subscription_id = d.subscription_id AND n.attempt_generation > d.attempt_generation
)`;

/** Trường của api_keys được phép rời DB (không có keyHash). */
export const API_KEY_PUBLIC_SELECT = {
  id: true,
  tenantId: true,
  serviceName: true,
  keyPrefix: true,
  scopes: true,
  readTypes: true,
  sourceId: true,
  lastUsedAt: true,
  revokedAt: true,
  createdAt: true,
} as const;

/** Lease DELIVERING (S1-2): > timeout gửi 5s + ghi DB, đủ rộng để không nhận trùng lần gửi đang chạy. */
export const DELIVERY_LEASE_SECONDS = 60;

/** Raw event phải "nguội" bao lâu mới tính là mồ côi — tránh đụng cái đang nằm trong outbox/relay. */
export const ORPHAN_MIN_AGE_SECONDS = 120;

/**
 * S7 (DINH-CHINH §3): MỘT biến retention — `EVENT_RETENTION_DAYS`, `CLEANUP_RETENTION_DAYS` là alias (env cũ).
 * Mặc định 7. Kiểm "an toàn so với TTL retry" nằm ở CleanupJob (hub-worker).
 */
export function eventRetentionDaysFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const v = env.EVENT_RETENTION_DAYS || env.CLEANUP_RETENTION_DAYS;
  const n = v ? Number(v) : 7;
  return Number.isFinite(n) && n > 0 ? n : 7;
}

export interface OrphanRawEvent {
  id: string;
  sourceId: string;
  provider: string;
  sourceName: string;
  idempotencyKey: string;
  receivedAt: Date;
}

export type TimeseriesRange = '24h' | '7d';

export interface TimeseriesBucket {
  bucket: string;
  events: number;
  succeeded: number;
  /** Chưa tới đích: PENDING + DELIVERING + RETRYING. */
  retrying: number;
  dead: number;
}

const TIMESERIES_TZ = 'Asia/Ho_Chi_Minh';

/** `span` = first_bucket cách last_bucket bao xa → 24 bucket giờ / 7 bucket ngày, tính cả bucket hiện tại. */
const TIMESERIES_SPECS: Record<TimeseriesRange, { unit: string; step: string; span: string }> = {
  '24h': { unit: 'hour', step: '1 hour', span: '23 hours' },
  '7d': { unit: 'day', step: '1 day', span: '6 days' },
};

/** CB1: một dòng `hub.alerts` (đọc qua RETURNING thô — cùng hình với model Prisma `Alert`). */
export interface AlertRow {
  id: string;
  tenantId: string;
  rule: string;
  severity: 'critical' | 'warning' | 'info';
  subjectType: 'destination' | 'source' | 'project';
  subjectId: string;
  state: 'OPEN' | 'RESOLVED';
  openedAt: Date;
  lastSeenAt: Date;
  resolvedAt: Date | null;
  facts: Record<string, unknown>;
  acknowledgedAt: Date | null;
  acknowledgedBy: string | null;
}

export interface AlertUpsertInput {
  rule: string;
  severity: AlertRow['severity'];
  subjectType: AlertRow['subjectType'];
  subjectId: string;
  facts?: Record<string, unknown>;
  now: Date;
}

/** CB2: trần dòng đầu vào của evaluator (đích/source mỗi project; dòng attempt mỗi truy vấn). */
export const ALERT_INPUT_LIMIT = 1000;
export const ALERT_ATTEMPT_ROWS_LIMIT = 20_000;

/** Mảng uuid cho `= ANY(...)` / `unnest(...)` (rỗng vẫn đúng kiểu). */
function uuidArray(ids: string[]): Prisma.Sql {
  return ids.length === 0 ? Prisma.sql`ARRAY[]::uuid[]` : Prisma.sql`ARRAY[${Prisma.join(ids.map((i) => Prisma.sql`${i}::uuid`))}]`;
}

export interface AlertDestinationRow {
  id: string;
  isActive: boolean;
  archivedAt: Date | null;
  circuitState: 'CLOSED' | 'OPEN' | 'HALF_OPEN';
}

export interface AlertSourceRow {
  id: string;
  isActive: boolean;
  archivedAt: Date | null;
  provider: string;
  connectionStatus: 'PENDING' | 'CONNECTED' | 'FAILED' | 'DRIFTED' | 'DISCONNECTED' | null;
  connectionLastError: string | null;
  connectionLastFix: string | null;
  connectionUpdatedAt: Date | null;
  connectionProvider: string | null;
}

export interface AlertAttemptRow {
  destinationId: string;
  status: number | null;
  at: Date;
}

export interface AlertStatusCountRow {
  destinationId: string;
  status: number | null;
  n: number;
}

export interface AlertSourceActivityRow {
  sourceId: string;
  n: number;
  lastAt: Date | null;
  medianGapMs: number | null;
}

const ALERT_RETURNING = Prisma.sql`id, tenant_id AS "tenantId", rule, severity::text AS severity, subject_type::text AS "subjectType",
  subject_id AS "subjectId", state::text AS state, opened_at AS "openedAt", last_seen_at AS "lastSeenAt", resolved_at AS "resolvedAt",
  facts, acknowledged_at AS "acknowledgedAt", acknowledged_by AS "acknowledgedBy"`;

export interface AuditLogInput {
  action: string;
  entityType: string;
  entityId: string;
  actor?: string;
  reason?: string | null;
  metadata?: Record<string, unknown> | null;
}

/** ADR-161: tuỳ chọn tra theo id — mặc định bỏ qua mục đã lưu trữ. */
export interface ArchivedOpt {
  includeArchived?: boolean;
}
function notArchived(opts: ArchivedOpt): { archivedAt?: null } {
  return opts.includeArchived ? {} : { archivedAt: null };
}

export interface DeadDeliveryFilter {
  destinationId?: string;
  from?: Date;
  to?: Date;
  errorContains?: string;
  errorKind?: DlqErrorKind;
  /** ADR-161: chỉ delivery còn replay được (subscription chưa lưu trữ, đích chưa lưu trữ + đang bật). */
  replayableOnly?: boolean;
  /** ADR-163: chỉ trong các id này (tập đã xem trước). */
  ids?: string[];
}

/** ADR-163: vì sao một id đã xem trước KHÔNG được replay lúc chạy thật. */
export type ReplaySkipReason = 'not_found' | 'not_dead' | 'already_replayed' | 'destination_unavailable' | 'event_trimmed';

/**
 * ADR-163: "loại lỗi" của delivery DEAD theo HTTP status của lần thử CUỐI (worker chỉ đặt DEAD sau một attempt):
 * `http_4xx` = đích từ chối (4xx -> DEAD ngay, hoặc 408/429 hết lượt) — gửi lại vô ích nếu chưa sửa cấu hình;
 * `http_other` = mọi status khác 4xx: 5xx thật VÀ lỗi mạng/timeout (sender quy về 500, không tách được ở DB) — hết
 *   lượt retry. Không gọi là "5xx" vì không trung thực: lỗi mạng cũng rơi vào đây;
 * `no_response` = không có status (hoãn vì circuit mở quá lâu, không gọi tới đích).
 */
export const DLQ_ERROR_KINDS = ['http_4xx', 'http_other', 'no_response'] as const;
export type DlqErrorKind = (typeof DLQ_ERROR_KINDS)[number];

/** HTTP code của lần thử cuối: chính xác (`404`), theo lớp (`5` = 5xx), hoặc chưa có phản hồi. */
export type DeliveryHttpCode = { exact: number } | { klass: number } | 'none';

export interface DeliveryPageFilter {
  /** true = đúng điều kiện DLQ (DEAD chưa bị replay, ADR-031) — `status` bị bỏ qua. */
  dlq?: boolean;
  status?: string;
  destinationId?: string;
  from?: Date;
  to?: Date;
  httpCode?: DeliveryHttpCode;
  errorKind?: DlqErrorKind;
  cursor?: { at: string; id: string };
  /** older = `(created_at,id) < cursor` giảm dần; newer = `> cursor` TĂNG dần (trang "Trước"). */
  dir: 'older' | 'newer';
  limit: number;
}

export type DeliveryPageRow = Prisma.DeliveryGetPayload<{
  include: { event: true; subscription: { include: { destination: true } }; attempts: true };
}> & { cursorAt: string };

export interface AuditLogFilter {
  actor?: string;
  /** Tiền tố: `delivery.` khớp `delivery.replay`, `delivery.replay_bulk`; không có `.` cuối = khớp chính xác hoặc tiền tố. */
  action?: string;
  entityType?: string;
  from?: Date;
  to?: Date;
  cursor?: { at: string; id: string };
  dir: 'older' | 'newer';
  limit: number;
}

/** Status HTTP của lần thử cuối của `d` (NULL nếu chưa thử / không có phản hồi). */
const lastAttemptStatus = Prisma.sql`(SELECT a.response_status FROM hub.delivery_attempts a
  WHERE a.delivery_id = d.id ORDER BY a.attempt_no DESC LIMIT 1)`;

function errorKindSql(kind: DlqErrorKind): Prisma.Sql {
  switch (kind) {
    case 'http_4xx':
      return Prisma.sql`${lastAttemptStatus} BETWEEN 400 AND 499`;
    case 'http_other':
      return Prisma.sql`COALESCE(${lastAttemptStatus} NOT BETWEEN 400 AND 499, false)`;
    case 'no_response':
      return Prisma.sql`${lastAttemptStatus} IS NULL`;
  }
}

function httpCodeSql(code: DeliveryHttpCode): Prisma.Sql {
  if (code === 'none') return Prisma.sql`${lastAttemptStatus} IS NULL`;
  if ('exact' in code) return Prisma.sql`${lastAttemptStatus} = ${code.exact}::int`;
  return Prisma.sql`${lastAttemptStatus} BETWEEN ${code.klass * 100}::int AND ${code.klass * 100 + 99}::int`;
}

export interface DeadDeliveryRef {
  id: string;
  eventId: string;
  subscriptionId: string;
  attemptGeneration: number;
  lastError: string | null;
  createdAt: Date;
  correlationId: string;
  eventType: string;
  destinationId: string;
}

/** `%` `_` `\` trong chuỗi người dùng gõ là ký tự thường, không phải wildcard của ILIKE. */
function escapeLike(s: string) {
  return s.replace(/[\\%_]/g, (c) => '\\' + c);
}

export interface PollEventsOptions {
  after: bigint;
  limit: number;
  /** Mẫu như subscription (`payment.*`, `*`, chính xác). Rỗng/không truyền = không lọc. */
  types?: string[];
  readTypes?: string[];
  failedOnly?: boolean;
  endpointId?: string;
}

export interface PolledEvent {
  id: string;
  /** R2-3 (ADR-099): poll_seq — cursor polling theo thứ tự COMMIT. KHÔNG phải events.seq (thứ tự INSERT, dashboard). */
  cursor: bigint;
  type: string;
  source: string;
  sourceId: string | null;
  subject: string | null;
  /** QT:T20: `null` khi event đã "Dọn" (`trimmed: true`). */
  data: unknown;
  /** QT §5.1 (ADR-184): nội dung đã được dọn — chỉ còn dòng gầy (khoá chống trùng, kiểu, thời gian). */
  trimmed: boolean;
  normalized: boolean;
  correlationId: string;
  occurredAt: Date;
  receivedAt: Date;
}

/** Mẫu kiểu -> điều kiện SQL: `*` = mọi kiểu, `a.*` = starts_with 'a.' (nhiều cấp), còn lại = bằng. */
function typeFilterSql(patterns?: string[]): Prisma.Sql {
  if (!patterns || patterns.length === 0 || patterns.includes('*')) return Prisma.sql`TRUE`;
  const exact = patterns.filter((p) => !p.endsWith('.*'));
  const prefixes = patterns.filter((p) => p.endsWith('.*')).map((p) => p.slice(0, -1));
  return Prisma.sql`(e.type = ANY(${exact}::text[]) OR EXISTS (SELECT 1 FROM unnest(${prefixes}::text[]) p WHERE starts_with(e.type, p)))`;
}

/** EG4 (ADR-179): một dòng lưu lượng chờ ghi (đã gộp trong bộ nhớ của hub-api). */
export interface SourceTrafficRow {
  sourceId: string;
  minute: Date;
  outcome: 'ACCEPTED' | 'DUPLICATE' | 'REJECTED' | 'RATE_LIMITED' | 'BLOCKED' | 'STORAGE_FULL';
  count: number;
  /** QT E2 (ADR-183): byte thực sự ghi xuống DB (cộng dồn khi upsert). Thiếu = 0. */
  bytes?: number;
  topIps: { ip: string; count: number }[];
}

/** QT3 (E4): source của đường publish kèm nấc dung lượng của project (JOIN cùng câu). null = chưa đo (= OK). */
export type SourceWithStorageLevel = Source & { storageLevel: string | null };

/** QT4: nấc trước/sau khi trừ byte vừa giải phóng (E2: tính lại NGAY). */
export interface StorageLevelChange {
  from: string;
  to: string;
  usedBytes: number;
}

/** QT4: kết quả MỘT lô dọn (byte giải phóng theo công thức §2; nấc sau khi trừ — null nếu không giải phóng gì). */
export interface CleanBatchResult {
  events: number;
  rejected: number;
  freedBytes: number;
  level: StorageLevelChange | null;
  done: boolean;
}

/** QT4: một ô `by_bucket` đọc từ DB (mức quan trọng là chuỗi của `eventImportanceSql`). */
export interface StorageBucketRow {
  sourceId: string | null;
  importance: string;
  ageDays: number;
  events: number;
  bytes: number;
}
