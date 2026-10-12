import { Prisma } from '@prisma/client';
import { ALERT_RULE_CODES, ALERT_RULES, AlertRuleCode, alertTitleKey, DEFAULT_EMAIL_RULES } from '@hub/common';
import { AlertPreferencesInput, OperatorAlertRow, PrismaService } from '@hub/database';
import { hubError } from '../errors/hub-error';
import { assertFlatQuery, badParam, isUuid, parseEnumParam, parsePageCursor, parseTimeParam, parseUuidParam } from '../api/list-params';
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
  | 'operatorAlertsUnackedTenants'
  | 'tenantTx'
  | 'forTenant'
  | 'findProjectById'
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
  const out = await runPage(
    (dir, cursor) => store.operatorAlertsAcrossTenants({ ...filter, dir, cursor, limit }),
    page,
    limit,
    (r) => ({ at: r.cursorAt, id: r.id }),
  );
  return { items: out.items.map(alertView), next: out.next, prev: out.prev };
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

/**
 * "Đã xem tất cả": `?project=<uuid>` -> một project (không tồn tại -> 404); không có -> mọi project còn cảnh báo OPEN chưa
 * xem (truy vấn riêng, không trần). `?asOf=<ISO>` (review L2): chỉ cảnh báo mở TỪ TRƯỚC mốc này — web gửi lúc mở chuông,
 * cảnh báo mới đến sau đó không bị đánh dấu "đã xem" oan. Mỗi project MỘT transaction (ack + audit khi ghi được ≥ 1 dòng).
 */
export async function ackAllAlerts(store: AlertStore, q: { project?: unknown; asOf?: unknown }, actor: string, now = new Date()) {
  assertFlatQuery(q);
  const projectId = parseUuidParam(q.project, 'project');
  const asOf = parseTimeParam(q.asOf, 'asOf');
  let tenants: string[];
  if (projectId) {
    if (!(await store.findProjectById(projectId))) throw hubError('not_found');
    tenants = [projectId];
  } else {
    tenants = await store.operatorAlertsUnackedTenants(asOf);
  }
  const projects: { id: string; acknowledged: number }[] = [];
  for (const tenantId of tenants) {
    const n = await store.tenantTx(tenantId, async (tx) => {
      const repo = store.forTenant(tenantId, tx);
      const count = await repo.ackAllOpenAlerts(actor, now, asOf);
      if (count > 0) {
        await repo.createAuditLog({
          action: 'alert.acknowledged_all',
          entityType: 'project',
          entityId: tenantId,
          actor,
          metadata: { count, ...(asOf ? { asOf: asOf.toISOString() } : {}) },
        });
      }
      return count;
    });
    projects.push({ id: tenantId, acknowledged: n });
  }
  return { acknowledged: projects.reduce((s, p) => s + p.acknowledged, 0), projects };
}

// ------------------------------------------------------------------ tuỳ chọn cảnh báo (§3.2) + ngôn ngữ (D3)

const PREF_KEYS = ['emailEnabled', 'emailRules', 'emailOnResolve', 'mutedProjects'] as const;

/** Danh mục luật cho trang Cài đặt (CB5): mã + mức — web dịch tên luật theo `alerts.rules.<mã>.title`. */
export const ALERT_RULE_CATALOG = ALERT_RULE_CODES.map((code) => ({ code, severity: ALERT_RULES[code].severity, titleKey: alertTitleKey(code) }));

function prefsView(p: { emailEnabled: boolean; emailRules: string[]; emailOnResolve: boolean; mutedProjects: string[]; updatedAt: Date } | null) {
  return {
    emailEnabled: p?.emailEnabled ?? false,
    emailRules: p ? p.emailRules : [...DEFAULT_EMAIL_RULES],
    emailOnResolve: p?.emailOnResolve ?? false,
    mutedProjects: p?.mutedProjects ?? [],
    updatedAt: p?.updatedAt ?? null,
    rules: ALERT_RULE_CATALOG,
  };
}

export async function getAlertPreferences(store: AlertStore, userId: string) {
  return prefsView(await store.identity().findAlertPreferences(userId));
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
    return saved;
  });
  return prefsView(row);
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
