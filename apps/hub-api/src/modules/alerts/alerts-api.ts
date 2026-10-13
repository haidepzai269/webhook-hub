import { Prisma } from '@prisma/client';
import { ALERT_RULE_CODES, ALERT_RULES, AlertRuleCode, alertTitleKey, ownerVisibleRules, ruleAudience, ALERT_EMAIL_HOURLY_CAP, DEFAULT_EMAIL_RULES, logger, MailSender, maskEmail, sampleAlertEmail } from '@hub/common';
import { AlertPreferencesInput, OperatorAlertRow, PrismaService } from '@hub/database';
import { hubError } from '../errors/hub-error';
import { assertFlatQuery, badParam, isUuid, parseEnumParam, parsePageCursor, parseUuidParam } from '../api/list-params';
import { parseLimit, runPage } from '../api/console-lists';

/**
 * CB3 (SPEC-canh-bao-nhan-dinh §5.2, ADR-169): logic của API cảnh báo — tách khỏi controller để test bằng store giả.
 * - ĐỌC xuyên project: CHỈ qua escape hatch có tên của PrismaService (`operatorAlertsAcrossTenants`,
 *   `operatorAlertSummaryAcrossTenants`, `operatorFindAlertTenant`).
 * - GHI (ack): tra tenant của cảnh báo rồi `tenantTx` + `forTenant(tenant, tx)` — ack và dòng `audit_logs` cùng transaction.
 * - Tuỳ chọn / ngôn ngữ gắn NGƯỜI -> `IdentityRepository` + `auth_audit` (cùng transaction), không có tenant_id.
 */

export type AlertStore = Pick<
  PrismaService,
  | 'operatorAlertsAcrossTenants'
  | 'operatorAlertSummaryAcrossTenants'
  | 'operatorFindAlertTenant'
  | 'operatorFindAlertTenants'
  | 'dbNow'
  | 'ownerAlertsAcrossTenants'
  | 'ownerAlertSummaryAcrossTenants'
  | 'tenantTx'
  | 'forTenant'
  | 'findExistingProjectIds'
  | 'identity'
  | '$transaction'
>;

export const ALERT_STATES = ['OPEN', 'RESOLVED'] as const;
export const ALERT_SEVERITIES = ['critical', 'warning', 'info'] as const;
/** Trần danh sách mỗi trang (mặc định 50 — LIST_PAGE_SIZE). */
export const ALERT_LIST_MAX = 200;
/** Trần mảng trong tuỳ chọn — chặn body khổng lồ, dư rộng so với số luật / số project thật. */
export const MUTED_PROJECTS_MAX = 500;

export interface AlertListQuery {
  state?: string;
  severity?: string;
  project?: string;
  rule?: string;
  /** = `before` (trang CŨ HƠN) — tên trong SPEC §5.2. */
  cursor?: string;
  before?: string;
  after?: string;
  limit?: string;
}

/** Một dòng cảnh báo cho console: không có `cursorAt`/`tenantId` thô — project đi kèm {id, slug, name}. */
export function alertView(a: OperatorAlertRow) {
  return {
    id: a.id,
    rule: a.rule,
    severity: a.severity,
    titleKey: alertTitleKey(a.rule as AlertRuleCode),
    subjectType: a.subjectType,
    subjectId: a.subjectId,
    state: a.state,
    openedAt: a.openedAt,
    lastSeenAt: a.lastSeenAt,
    resolvedAt: a.resolvedAt,
    acknowledgedAt: a.acknowledgedAt,
    acknowledgedBy: a.acknowledgedBy,
    // facts đã sạch từ thiết kế (§3.1: không payload/secret/header) — chỉ operator đọc được route này.
    facts: a.facts,
    project: a.project,
  };
}

export async function listAlerts(store: AlertStore, q: AlertListQuery) {
  assertFlatQuery(q);
  if (q.cursor && (q.before || q.after)) throw badParam('cursor', 'cursor là tên khác của before — không truyền cùng before/after');
  const filter = {
    state: parseEnumParam(q.state, 'state', ALERT_STATES),
    severity: parseEnumParam(q.severity, 'severity', ALERT_SEVERITIES),
    rule: parseEnumParam(q.rule, 'rule', ALERT_RULE_CODES),
    projectId: parseUuidParam(q.project, 'project'),
  };
  const limit = parseLimit(q.limit, ALERT_LIST_MAX); // mặc định LIST_PAGE_SIZE
  const page = parsePageCursor(q.cursor || q.before, q.after);
  // ADR-188: `asOf` = đồng hồ DB, đọc TRƯỚC danh sách (dòng commit giữa hai câu vẫn nằm trong trang -> đã thấy). Console
  // lấy mốc "cảnh báo mới" từ đây, không từ Date.now() của trình duyệt.
  const asOf = await store.dbNow();
  const out = await runPage(
    (dir, cursor) => store.operatorAlertsAcrossTenants({ ...filter, dir, cursor, limit }),
    page,
    limit,
    (r) => ({ at: r.cursorAt, id: r.id }),
  );
  return { items: out.items.map(alertView), next: out.next, prev: out.prev, asOf: asOf.toISOString() };
}

/** Người xem chuông / trang Cảnh báo — từ CHÍNH session (SessionGuard), không từ client. */
export interface AlertViewer {
  userId: string;
  isOperator: boolean;
}

/**
 * QT6 (E3): project người xem là OWNER (không phải operator). Không owner project nào -> 403 `operator_required` như cũ
 * (developer/viewer không thấy cảnh báo nào).
 */
async function ownedProjectIds(store: Pick<AlertStore, 'identity'>, userId: string): Promise<string[]> {
  const ms = await store.identity().listMemberships(userId);
  const owned = ms.filter((m) => m.role === 'owner').map((m) => m.projectId);
  if (owned.length === 0) throw hubError('operator_required', {}, 'Chỉ người vận hành hub (hoặc owner — với cảnh báo dung lượng của project mình) xem được cảnh báo');
  return owned;
}

/**
 * QT6 (E3, ADR-190): danh sách cảnh báo theo QUYỀN. Operator: như cũ (mọi luật, mọi project). Owner: CHỈ luật audience
 * `owners+operator` (`project.storage_*`) của project mình là owner — lọc cứng trong SQL của escape hatch có tên
 * `ownerAlertsAcrossTenants`. Lọc `rule` ngoài tập đó -> trang rỗng (không lộ có hay không).
 */
export async function listAlertsFor(store: AlertStore, viewer: AlertViewer, q: AlertListQuery) {
  if (viewer.isOperator) return listAlerts(store, q);
  await ownedProjectIds(store, viewer.userId);
  assertFlatQuery(q);
  if (q.cursor && (q.before || q.after)) throw badParam('cursor', 'cursor là tên khác của before — không truyền cùng before/after');
  const filter = {
    state: parseEnumParam(q.state, 'state', ALERT_STATES),
    severity: parseEnumParam(q.severity, 'severity', ALERT_SEVERITIES),
    rule: parseEnumParam(q.rule, 'rule', ALERT_RULE_CODES),
    projectId: parseUuidParam(q.project, 'project'),
  };
  const limit = parseLimit(q.limit, ALERT_LIST_MAX);
  const page = parsePageCursor(q.cursor || q.before, q.after);
  const rules = filter.rule ? (ruleAudience(filter.rule) === 'owners+operator' ? [filter.rule] : []) : ownerVisibleRules();
  // ADR-188 (review QT-S3 M0): owner cũng lấy mốc "cảnh báo mới" theo đồng hồ DB, đọc TRƯỚC danh sách như đường operator.
  const asOf = await store.dbNow();
  const out = await runPage(
    (dir, cursor) => store.ownerAlertsAcrossTenants(viewer.userId, rules, { ...filter, rule: undefined, dir, cursor, limit }),
    page,
    limit,
    (r) => ({ at: r.cursorAt, id: r.id }),
  );
  return { items: out.items.map(alertView), next: out.next, prev: out.prev, asOf: asOf.toISOString(), scope: 'owner' as const };
}

/** QT6: tóm tắt chuông theo quyền (owner: chỉ cảnh báo dung lượng của project mình). */
export async function alertSummaryFor(store: AlertStore, viewer: AlertViewer) {
  if (viewer.isOperator) return alertSummary(store);
  await ownedProjectIds(store, viewer.userId);
  const asOf = await store.dbNow(); // ADR-188 (M0): mốc đồng hồ DB, đọc trước tóm tắt
  const { totals, perProject } = await store.ownerAlertSummaryAcrossTenants(viewer.userId, ownerVisibleRules());
  return {
    openBySeverity: { critical: totals.critical, warning: totals.warning, info: totals.info },
    unacked: totals.unacked,
    unackedBySeverity: totals.unackedBySeverity,
    perProject,
    asOf: asOf.toISOString(),
    scope: 'owner' as const,
  };
}

export async function alertSummary(store: AlertStore) {
  const { totals, perProject } = await store.operatorAlertSummaryAcrossTenants();
  return {
    openBySeverity: { critical: totals.critical, warning: totals.warning, info: totals.info },
    unacked: totals.unacked,
    // CB4 review L1: badge chuông tô màu theo mức cao nhất CHƯA XEM (không phải mọi cảnh báo đang mở).
    unackedBySeverity: totals.unackedBySeverity,
    perProject,
  };
}

/** "Đã xem" (idempotent): lần đầu ghi + audit; lần sau 200 `changed:false`, không audit thêm. Không đóng cảnh báo. */
export async function ackAlert(store: AlertStore, rawId: string, actor: string, now = new Date()) {
  if (typeof rawId !== 'string' || !isUuid(rawId)) throw hubError('not_found');
  const id = rawId.toLowerCase();
  const tenantId = await store.operatorFindAlertTenant(id);
  if (!tenantId) throw hubError('not_found');
  return store.tenantTx(tenantId, async (tx) => {
    const repo = store.forTenant(tenantId, tx);
    const r = await repo.ackAlert(id, actor, now);
    if (!r.found) throw hubError('not_found');
    if (r.changed) {
      await repo.createAuditLog({ action: 'alert.acknowledged', entityType: 'alert', entityId: id, actor });
    }
    const a = await repo.findAlertById(id);
    return { id, state: a?.state, acknowledgedAt: a?.acknowledgedAt ?? null, acknowledgedBy: a?.acknowledgedBy ?? null, changed: r.changed };
  });
}

/** Trần số id mỗi lần "Đã xem tất cả" (chuông hiện tối đa 100 dòng). */
export const ACK_ALL_MAX_IDS = 200;

/** Body `{ ids: uuid[] }` (1..200, chỉ khoá `ids`) -> id chữ thường, bỏ trùng. Sai hình -> 400 `bad_request` kèm field. */
export function parseAckAllIds(body: unknown): string[] {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw badParam('body', 'Body là {"ids": ["<uuid>", …]}');
  const b = body as Record<string, unknown>;
  for (const k of Object.keys(b)) if (k !== 'ids') throw badParam(k, `Không nhận trường ${k} — chỉ: ids`);
  const v = b.ids;
  if (!Array.isArray(v) || v.length === 0 || v.length > ACK_ALL_MAX_IDS) {
    throw badParam('ids', `ids phải là mảng 1–${ACK_ALL_MAX_IDS} id cảnh báo`);
  }
  if (v.some((x) => typeof x !== 'string' || !isUuid(x))) throw badParam('ids', 'ids chỉ chứa UUID của cảnh báo');
  return [...new Set((v as string[]).map((x) => x.toLowerCase()))];
}

/**
 * "Đã xem tất cả" (re-review CB4): body `{ids}` = ĐÚNG các cảnh báo chưa xem đang hiện trong chuông. Không theo mốc
 * thời gian: `opened_at` là `now` của lượt đánh giá (chung mọi project) nên một cảnh báo commit muộn hơn cùng lượt có
 * cùng mốc mà chưa ai thấy — `asOf` sẽ đánh dấu oan nó (và nuốt banner/toast của nó). Tra tenant từng id qua escape
 * hatch có tên, rồi mỗi tenant MỘT transaction: chỉ ghi dòng còn OPEN + chưa xem; audit kèm danh sách id khi ghi được.
 * Query (`?project=`, `?asOf=` cũ) không còn nhận -> 400.
 */
export async function ackAllAlerts(store: AlertStore, body: unknown, q: Record<string, unknown> | undefined, actor: string, now = new Date()) {
  assertFlatQuery(q);
  const extra = Object.keys(q ?? {}).find((k) => (q as Record<string, unknown>)[k] !== undefined);
  if (extra) throw badParam(extra, 'ack-all nhận danh sách id trong body {"ids": […]}, không nhận tham số query');
  const ids = parseAckAllIds(body);
  const byTenant = new Map<string, string[]>();
  for (const { id, tenantId } of await store.operatorFindAlertTenants(ids)) {
    byTenant.set(tenantId, [...(byTenant.get(tenantId) ?? []), id]);
  }
  const projects: { id: string; acknowledged: number }[] = [];
  for (const tenantId of [...byTenant.keys()].sort()) {
    const acked = await store.tenantTx(tenantId, async (tx) => {
      const repo = store.forTenant(tenantId, tx);
      const hit = await repo.ackAlertsByIds(byTenant.get(tenantId) ?? [], actor, now);
      if (hit.length > 0) {
        await repo.createAuditLog({
          action: 'alert.acknowledged_all',
          entityType: 'project',
          entityId: tenantId,
          actor,
          metadata: { count: hit.length, ids: hit },
        });
      }
      return hit.length;
    });
    projects.push({ id: tenantId, acknowledged: acked });
  }
  return { acknowledged: projects.reduce((s, p) => s + p.acknowledged, 0), projects };
}

// ------------------------------------------------------------------ tuỳ chọn cảnh báo (§3.2) + ngôn ngữ (D3)

const PREF_KEYS = ['emailEnabled', 'emailRules', 'emailOnResolve', 'mutedProjects'] as const;

/** Danh mục luật cho trang Cài đặt (CB5): mã + mức — web dịch tên luật theo `alerts.rules.<mã>.title`. */
export const ALERT_RULE_CATALOG = ALERT_RULE_CODES.map((code) => ({ code, severity: ALERT_RULES[code].severity, titleKey: alertTitleKey(code), audience: ruleAudience(code) }));

type PrefsRow = { emailEnabled: boolean; emailRules: string[]; emailOnResolve: boolean; mutedProjects: string[]; updatedAt: Date } | null;
type Account = { email: string; emailVerifiedAt: Date | null } | null;

/** CB5: trang Cài đặt hiện email đích (chỉ đọc = email tài khoản) và khoá công tắc khi email chưa xác minh. */
function prefsView(p: PrefsRow, user: Account = null) {
  return {
    email: user?.email ?? null,
    emailVerified: !!user?.emailVerifiedAt,
    testEmail: { perHour: TEST_EMAIL_PER_HOUR },
    hourlyCap: ALERT_EMAIL_HOURLY_CAP,
    emailEnabled: p?.emailEnabled ?? false,
    emailRules: p ? p.emailRules : [...DEFAULT_EMAIL_RULES],
    emailOnResolve: p?.emailOnResolve ?? false,
    mutedProjects: p?.mutedProjects ?? [],
    updatedAt: p?.updatedAt ?? null,
    rules: ALERT_RULE_CATALOG,
  };
}

export async function getAlertPreferences(store: AlertStore, userId: string) {
  const idn = store.identity();
  const [prefs, user] = await Promise.all([idn.findAlertPreferences(userId), idn.findUserById(userId)]);
  return prefsView(prefs, user);
}

/**
 * Kiểm HÌNH body (đồng bộ): object phẳng, chỉ các khoá đã biết, ít nhất một khoá; `emailRules` ⊆ ALERT_RULE_CODES;
 * `mutedProjects` là mảng UUID. Lỗi -> 400 `bad_request` kèm `field`. Kiểm project TỒN TẠI ở `putAlertPreferences`.
 */
export function parseAlertPreferences(body: unknown): AlertPreferencesInput {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw badParam('body', 'Body phải là object JSON');
  const b = body as Record<string, unknown>;
  for (const k of Object.keys(b)) {
    if (!(PREF_KEYS as readonly string[]).includes(k)) throw badParam(k, `Không nhận trường ${k} — chỉ: ${PREF_KEYS.join(', ')}`);
  }
  const out: AlertPreferencesInput = {};
  for (const k of ['emailEnabled', 'emailOnResolve'] as const) {
    if (b[k] === undefined) continue;
    if (typeof b[k] !== 'boolean') throw badParam(k, `${k} phải là true/false`);
    out[k] = b[k] as boolean;
  }
  if (b.emailRules !== undefined) {
    const v = b.emailRules;
    if (!Array.isArray(v) || v.length > 50) throw badParam('emailRules', 'emailRules phải là mảng mã luật (tối đa 50 phần tử)');
    const bad = v.filter((x) => typeof x !== 'string' || !(ALERT_RULE_CODES as readonly string[]).includes(x));
    if (bad.length) throw badParam('emailRules', `Mã luật không tồn tại: ${bad.slice(0, 5).map((x) => JSON.stringify(x)).join(', ')} — chỉ nhận: ${ALERT_RULE_CODES.join(', ')}`);
    out.emailRules = [...new Set(v as string[])];
  }
  if (b.mutedProjects !== undefined) {
    const v = b.mutedProjects;
    if (!Array.isArray(v) || v.length > MUTED_PROJECTS_MAX) throw badParam('mutedProjects', `mutedProjects phải là mảng UUID project (tối đa ${MUTED_PROJECTS_MAX})`);
    if (v.some((x) => typeof x !== 'string' || !isUuid(x))) throw badParam('mutedProjects', 'mutedProjects chỉ chứa UUID của project');
    out.mutedProjects = [...new Set((v as string[]).map((x) => x.toLowerCase()))];
  }
  if (Object.keys(out).length === 0) throw badParam('body', `Cần ít nhất một trường: ${PREF_KEYS.join(', ')}`);
  return out;
}

export async function putAlertPreferences(store: AlertStore, userId: string, body: unknown, ip: string | null) {
  const input = parseAlertPreferences(body);
  if (input.mutedProjects?.length) {
    // review CB1: mảng uuid không có khoá ngoại -> route kiểm project tồn tại TRƯỚC khi ghi (một truy vấn theo id).
    const existing = new Set(await store.findExistingProjectIds(input.mutedProjects));
    const unknown = input.mutedProjects.filter((id) => !existing.has(id));
    if (unknown.length) throw badParam('mutedProjects', `Project không tồn tại: ${unknown.slice(0, 5).join(', ')}`);
  }
  const row = await store.$transaction(async (tx: Prisma.TransactionClient) => {
    const idn = store.identity(tx);
    const saved = await idn.upsertAlertPreferences(userId, input);
    await idn.recordAuthAudit({ userId, action: 'alert_preferences.updated', ip, meta: { changes: input } });
    return { saved, user: await idn.findUserById(userId) };
  });
  return prefsView(row.saved, row.user);
}

export const USER_LOCALES = ['vi', 'en'] as const;

/** D3: nút Ngôn ngữ gọi (mọi người dùng, không riêng operator). Trùng giá trị hiện tại -> không ghi, không audit. */
export async function putUserLocale(store: Pick<AlertStore, 'identity' | '$transaction'>, userId: string, body: unknown, ip: string | null) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  const locale = b?.locale;
  if (!b || Object.keys(b).some((k) => k !== 'locale') || typeof locale !== 'string' || !(USER_LOCALES as readonly string[]).includes(locale)) {
    throw badParam('locale', `Body là {"locale": "${USER_LOCALES.join('" | "')}"}`);
  }
  const loc = locale as (typeof USER_LOCALES)[number];
  return store.$transaction(async (tx: Prisma.TransactionClient) => {
    const idn = store.identity(tx);
    const user = await idn.findUserById(userId);
    if (!user) throw hubError('not_found');
    if (user.locale === loc) return { locale: loc, changed: false };
    await idn.setUserLocale(userId, loc);
    await idn.recordAuthAudit({ userId, action: 'user.locale_changed', ip, meta: { from: user.locale, to: loc } });
    return { locale: loc, changed: true };
  });
}

// ------------------------------------------------------------------ gửi email thử (CB5, §5.2, §8.5)

/** §5.2: "Gửi email thử" tối đa 3 lần / giờ / người — đếm trên `auth_audit` ở Postgres (không Redis, ngân sách R1). */
export const TEST_EMAIL_PER_HOUR = 3;
export const TEST_EMAIL_AUDIT_ACTION = 'alert_preferences.test_email';
const HOUR_MS = 3_600_000;

/**
 * Gửi một thư mẫu (cảnh báo giả định, gắn nhãn [THỬ]) tới email ĐÃ XÁC MINH của chính người gọi, theo `users.locale`.
 * Suất được giữ TRƯỚC khi gửi (khoá dòng users + đếm + ghi audit trong một transaction) — gửi lỗi vẫn tốn suất, để nút
 * này không thành vòi bắn thư. Không đọc dữ liệu cảnh báo thật; project trong thư = project đầu tiên của người dùng (nếu có).
 */
export async function sendTestAlertEmail(
  store: AlertStore,
  mail: MailSender,
  userId: string,
  ip: string | null,
  webUrl: string,
  now = new Date(),
) {
  const idn = store.identity();
  const user = await idn.findUserById(userId);
  if (!user) throw hubError('not_found');
  if (!user.emailVerifiedAt) throw hubError('email_not_verified', {}, 'Email tài khoản chưa xác minh — không gửi được email cảnh báo.');
  const slot = await store.$transaction((tx: Prisma.TransactionClient) =>
    store.identity(tx).reserveAuditSlot({ userId, action: TEST_EMAIL_AUDIT_ACTION, since: new Date(now.getTime() - HOUR_MS), max: TEST_EMAIL_PER_HOUR, ip }),
  );
  if (!slot.ok) {
    const retryAfter = Math.max(1, Math.ceil((slot.oldestAt.getTime() + HOUR_MS - now.getTime()) / 1000));
    throw hubError('rate_limited', { retryAfter }, `Tối đa ${TEST_EMAIL_PER_HOUR} email thử mỗi giờ.`);
  }
  const memberships = await idn.listMemberships(userId).catch(() => []);
  const first = memberships[0];
  const project = first ? { id: first.projectId, slug: first.slug, name: first.name } : { id: '00000000-0000-4000-8000-000000000000', slug: 'example', name: 'Example' };
  const msg = sampleAlertEmail({ locale: user.locale === 'en' ? 'en' : 'vi', webUrl, project, now });
  try {
    await mail.send({ to: user.email, ...msg });
  } catch (err: any) {
    logger.warn({ err: err?.message, to: maskEmail(user.email) }, 'Gửi email cảnh báo thử lỗi');
    throw hubError('service_unavailable', {}, 'Không gửi được email thử — kiểm tra cấu hình MAIL_DRIVER của hub.');
  }
  return { sent: true, to: user.email, remaining: Math.max(0, TEST_EMAIL_PER_HOUR - slot.used) };
}
