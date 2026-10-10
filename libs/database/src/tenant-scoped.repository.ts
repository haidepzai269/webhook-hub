import { eventTypeCandidates } from '@hub/common';
import { PrismaClient, Destination, Delivery, Prisma, CircuitState } from '@prisma/client';

/**
 * `PrismaClient` gốc HOẶC `Prisma.TransactionClient` (bên trong một `$transaction`
 * interactive) — cho phép dựng `TenantScopedRepository` ngay trong `tx` callback khi
 * tenant đã biết (ví dụ NormalizeConsumer), thay vì gọi thẳng `tx.subscription...`.
 */
type PrismaClientOrTx = PrismaClient | Prisma.TransactionClient;

export class TenantScopedRepository {
  constructor(
    private readonly prisma: PrismaClientOrTx,
    public readonly tenantId: string,
  ) {
    if (!tenantId) {
      throw new Error('TenantScopedRepository: tenantId là bắt buộc (BB-5 vi phạm)');
    }
  }

  // --- Sources ---
  async findSources(where: Prisma.SourceWhereInput = {}) {
    return this.prisma.source.findMany({
      where: { ...where, tenantId: this.tenantId },
      include: { secrets: true },
    });
  }

  async findSourceById(id: string) {
    return this.prisma.source.findFirst({
      where: { id, tenantId: this.tenantId },
      include: { secrets: true },
    });
  }

  async createSource(data: Omit<Prisma.SourceUncheckedCreateInput, 'tenantId'>) {
    return this.prisma.source.create({
      data: { ...data, tenantId: this.tenantId },
      include: { secrets: true },
    });
  }

  async updateSource(id: string, data: Pick<Prisma.SourceUncheckedUpdateInput, 'name' | 'isActive'>) {
    const result = await this.prisma.source.updateMany({ where: { id, tenantId: this.tenantId }, data });
    if (result.count !== 1) return null;
    return this.findSourceById(id);
  }

  async countSources(where: Prisma.SourceWhereInput = {}) {
    return this.prisma.source.count({
      where: { ...where, tenantId: this.tenantId },
    });
  }

  // --- Destinations ---
  async findDestinations(where: Prisma.DestinationWhereInput = {}) {
    return this.prisma.destination.findMany({
      where: { ...where, tenantId: this.tenantId },
    });
  }

  async findDestinationById(id: string) {
    return this.prisma.destination.findFirst({
      where: { id, tenantId: this.tenantId },
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
      where: { id, tenantId: this.tenantId },
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

  async findSubscriptionById(id: string) {
    return this.prisma.subscription.findFirst({
      where: { id, tenantId: this.tenantId },
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
        eventTypes: { hasSome: eventTypeCandidates(eventType) },
        destination: { tenantId: this.tenantId },
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
        eventTypes: { hasSome: eventTypeCandidates(eventType) },
        destination: { tenantId: this.tenantId },
        OR: sourceId ? [anySource, { sourceIds: { has: sourceId } }] : [anySource],
      },
      include: { destination: { select: { id: true, name: true, type: true, verification: true } } },
    });
  }

  /** S5: id nào trong danh sách KHÔNG phải source của project này (kiểm `sourceIds` của subscription). */
  async findForeignSourceIds(ids: string[]): Promise<string[]> {
    if (ids.length === 0) return [];
    const own = await this.prisma.source.findMany({ where: { id: { in: ids }, tenantId: this.tenantId }, select: { id: true } });
    const ok = new Set(own.map((s) => s.id));
    return ids.filter((id) => !ok.has(id));
  }

  async updateSubscription(id: string, data: Prisma.SubscriptionUncheckedUpdateInput) {
    const result = await this.prisma.subscription.updateMany({ where: { id, tenantId: this.tenantId }, data });
    if (result.count !== 1) return null;
    return this.findSubscriptionById(id);
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
   * S7 (SPEC §4.5, ADR-077): polling (A). `seq > after` tăng dần, chỉ event đã LẮNG `settleSeconds` (mặc định 2s)
   * tính theo `created_at` = lúc INSERT (clock_timestamp): seq cấp lúc INSERT, transaction seq nhỏ có thể COMMIT
   * sau transaction seq lớn — đọc ngay thì cursor vượt qua và mất vĩnh viễn sự kiện đó.
   * `types` và `readTypes` (mẫu wildcard như subscription) là hai điều kiện AND. `failedOnly`: có delivery
   * DEAD/RETRYING ở generation MỚI NHẤT của cặp (event, subscription) [tới `endpointId` nếu có].
   */
  async pollEvents(o: PollEventsOptions): Promise<PolledEvent[]> {
    const settle = o.settleSeconds ?? 2;
    const failed = o.failedOnly
      ? Prisma.sql`AND EXISTS (
          SELECT 1 FROM "hub"."deliveries" d JOIN "hub"."subscriptions" s ON s.id = d.subscription_id
          WHERE d.event_id = e.id AND d.tenant_id = e.tenant_id AND d.status IN ('DEAD', 'RETRYING')
          ${o.endpointId ? Prisma.sql`AND s.destination_id = ${o.endpointId}::uuid` : Prisma.empty}
          AND NOT EXISTS (SELECT 1 FROM "hub"."deliveries" d2 WHERE d2.event_id = d.event_id
                          AND d2.subscription_id = d.subscription_id AND d2.attempt_generation > d.attempt_generation))`
      : Prisma.empty;
    return this.prisma.$queryRaw<PolledEvent[]>`
      SELECT e.id, e.seq, e.type, e.source, e.source_id AS "sourceId", e.subject, e.data, e.normalized,
             e.correlation_id AS "correlationId", e.occurred_at AS "occurredAt", e.received_at AS "receivedAt"
      FROM "hub"."events" e
      WHERE e.tenant_id = ${this.tenantId}::uuid
        AND e.seq > ${o.after}
        AND e.created_at <= clock_timestamp() - ${settle} * interval '1 second'
        AND ${typeFilterSql(o.types)} AND ${typeFilterSql(o.readTypes)}
        ${failed}
      ORDER BY e.seq ASC
      LIMIT ${o.limit}`;
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
  async findDeliveryForSend(id: string) {
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
  async claimForSend(
    id: string,
    attemptGeneration: number,
    attemptCount: number,
    leaseSeconds = DELIVERY_LEASE_SECONDS,
  ): Promise<number> {
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
  async deferDelivery(id: string, nextAttemptAt: Date): Promise<number> {
    const result = await this.prisma.delivery.updateMany({
      where: { id, tenantId: this.tenantId, status: { in: ['PENDING', 'RETRYING'] } },
      data: { nextAttemptAt },
    });
    return result.count;
  }

  /** Trạng thái lease hiện tại (sau khi claim thua) — để phân biệt "đang có worker gửi" với "đã xong". */
  async getDeliveryLeaseState(id: string) {
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

  /** Phân trang lùi theo `id` (bigint tăng dần): `before` = id nhỏ nhất của trang trước. */
  async findAuditLogs(opts: { limit: number; before?: bigint }) {
    return this.prisma.auditLog.findMany({
      where: { tenantId: this.tenantId, ...(opts.before !== undefined ? { id: { lt: opts.before } } : {}) },
      orderBy: { id: 'desc' },
      take: opts.limit,
    });
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

export interface AuditLogInput {
  action: string;
  entityType: string;
  entityId: string;
  actor?: string;
  reason?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface DeadDeliveryFilter {
  destinationId?: string;
  from?: Date;
  to?: Date;
  errorContains?: string;
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
  settleSeconds?: number;
}

export interface PolledEvent {
  id: string;
  seq: bigint;
  type: string;
  source: string;
  sourceId: string | null;
  subject: string | null;
  data: unknown;
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
