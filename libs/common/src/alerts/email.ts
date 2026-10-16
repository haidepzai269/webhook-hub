/**
 * CB5 (SPEC-canh-bao-nhan-dinh §6, DINH-CHINH D3, ADR-173): MẪU THƯ cảnh báo vi/en — dùng chung cho vòng gửi của hub-worker
 * và nút "Gửi email thử" của hub-api. Câu của luật lấy từ `text.ts` (cùng nguồn với console).
 *
 * Nội dung: tiêu đề, project, đối tượng, từ lúc nào, số liệu, TÁC ĐỘNG (số sự kiện DEAD nếu luật có), cách xử lý, nút deep
 * link vào console (trang Cảnh báo lọc đúng project + luật), link tới Cài đặt để tắt.
 * CẤM (CB:T9): payload, header, secret, URL của endpoint. Thư chỉ được dựng từ: mã luật + `facts` (số, mốc giờ, mã
 * provider — §3.1 không chứa payload/secret/header), tên project, tên đối tượng. `lastError`/`lastFix` của kết nối KHÔNG
 * vào thư (chữ tự do của server). Không có URL đích nào được truyền vào hàm này — chỉ địa chỉ console (`webUrl`).
 */
import { AlertLike, AlertTextLocale, buildAlertText, createAlertTextT, ruleName } from './text';

export type AlertEmailKind = 'OPEN' | 'RESOLVED';

/** §6: tối đa 6 email cảnh báo / giờ / người (vòng gửi của hub-worker đếm; trang Cài đặt hiện ghi chú). */
export const ALERT_EMAIL_HOURLY_CAP = 6;

/** Múi giờ của mốc trong thư (thư dựng ở server; người vận hành ở VN — cùng múi với biểu đồ dashboard, ADR-171). */
export const ALERT_EMAIL_TIME_ZONE = 'Asia/Ho_Chi_Minh';

const EMAIL_TEXT: Record<AlertTextLocale, Record<string, string>> = {
  vi: {
    'email.tag.resolved': 'ĐÃ ỔN',
    'email.tag.test': 'THỬ',
    'email.heading.open': 'Cảnh báo {severity}',
    'email.heading.resolved': 'Đã ổn trở lại',
    'email.test.banner': 'Đây là email THỬ từ trang Cài đặt — không có sự cố thật. Thư cảnh báo thật trông như dưới đây.',
    'email.label.project': 'Dự án',
    'email.label.subject': 'Đối tượng',
    'email.label.since': 'Từ lúc',
    'email.label.resolved-at': 'Đã ổn lúc',
    'email.label.details': 'Số liệu',
    'email.label.impact': 'Tác động',
    'email.label.fix': 'Cách xử lý',
    'email.impact.dead': '{dead} sự kiện đã ngừng thử (DEAD) và nằm trong hàng đợi lỗi — cần phát lại sau khi sửa.',
    'email.resolved.lead': 'Luật cảnh báo này không còn đúng nữa, hub đã đóng cảnh báo.',
    'email.rollup': '…và {count} cảnh báo khác, xem trong console.',
    'email.cta': 'Mở trong console',
    'email.settings': 'Tắt email hoặc chọn loại cảnh báo được gửi trong Cài đặt',
    'email.footer':
      'Bạn nhận thư này vì là người vận hành Webhook Hub và đã bật "Gửi cảnh báo về email của tôi". Tối đa 6 email mỗi giờ, phần vượt được gộp vào thư kế tiếp.',
    'email.timezone': 'giờ Việt Nam',
    'email.tag.reminder': 'NHẮC',
    'email.cta.storage': 'Mở trang Dung lượng',
    'email.storage.auto-clean': 'Bật dọn tự động',
    'email.settings.owner': 'Tắt email 70% và 85% ở trang Dung lượng (email 95% và khi khoá không tắt được)',
    'email.footer.owner':
      'Bạn nhận thư này vì là chủ (owner) của dự án. Số liệu dung lượng là ước tính. Tối đa 6 email mỗi giờ, phần vượt được gộp vào thư kế tiếp.',
  },
  en: {
    'email.tag.resolved': 'RESOLVED',
    'email.tag.test': 'TEST',
    'email.heading.open': '{severity} alert',
    'email.heading.resolved': 'Back to normal',
    'email.test.banner': 'This is a TEST email from the Settings page — nothing is wrong. Real alert emails look like the one below.',
    'email.label.project': 'Project',
    'email.label.subject': 'Subject',
    'email.label.since': 'Since',
    'email.label.resolved-at': 'Resolved at',
    'email.label.details': 'Details',
    'email.label.impact': 'Impact',
    'email.label.fix': 'What to do',
    'email.impact.dead': '{dead} events stopped retrying (DEAD) and sit in the dead-letter queue — replay them after the fix.',
    'email.resolved.lead': 'The alert condition no longer holds; the hub closed this alert.',
    'email.rollup': '…and {count} more alerts, see the console.',
    'email.cta': 'Open in console',
    'email.settings': 'Turn these emails off or choose which alerts are sent in Settings',
    'email.footer':
      'You get this email because you operate this Webhook Hub and turned on "Email alerts to me". At most 6 emails per hour; the rest are rolled into the next email.',
    'email.timezone': 'Vietnam time',
    'email.tag.reminder': 'REMINDER',
    'email.cta.storage': 'Open the Storage page',
    'email.storage.auto-clean': 'Turn on auto-clean',
    'email.settings.owner': 'Turn off the 70% and 85% emails on the Storage page (95% and locked emails cannot be turned off)',
    'email.footer.owner':
      'You get this email because you own this project. Storage numbers are estimates. At most 6 emails per hour; the rest are rolled into the next email.',
  },
};

export interface AlertEmailInput {
  kind: AlertEmailKind;
  locale: AlertTextLocale;
  alert: AlertLike & { severity: 'critical' | 'warning' | 'info'; openedAt: Date; resolvedAt?: Date | null };
  project: { id: string; slug: string; name: string };
  /** Tên đích/nguồn (KHÔNG phải URL). */
  subjectName?: string | null;
  /** Địa chỉ console (`WEB_PUBLIC_URL`) — gốc của deep link. */
  webUrl: string;
  /** Số email đã bị trần 6/giờ gộp lại (CB:T8) — > 0 thì thư có dòng "…và k cảnh báo khác". */
  rollup?: number;
  now?: Date;
  /** Email thử từ Cài đặt: tiêu đề có [TEST] + dòng nói rõ không có sự cố thật. */
  test?: boolean;
  /** QT6 (E3): người nhận là owner (thư dung lượng) — chân thư + link tắt khác operator. Mặc định operator. */
  audience?: 'owner' | 'operator';
  /** QT6 (§3): thư NHẮC hằng ngày ở 95% / đã khoá — tiêu đề có [NHẮC]. */
  reminder?: boolean;
}

export interface AlertEmail {
  subject: string;
  html: string;
  text: string;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** Gốc console an toàn cho link: chỉ http(s), bỏ `/` cuối; sai -> localhost (như link mail của auth). */
export function consoleBase(webUrl: string | undefined): string {
  const u = (webUrl ?? '').trim().replace(/\/+$/, '');
  return /^https?:\/\/[^\s"'<>]+$/.test(u) ? u : 'http://localhost:3000';
}

/** Deep link: trang Cảnh báo lọc đúng project + luật (bộ lọc trên URL, ADR-163) — trang đó mở tiếp tới đối tượng. */
export function alertConsoleLink(webUrl: string, a: { rule: string }, projectId: string): string {
  const p = new URLSearchParams({ project: projectId, rule: a.rule });
  return `${consoleBase(webUrl)}/alerts?${p.toString()}`;
}

export function alertSettingsLink(webUrl: string): string {
  return `${consoleBase(webUrl)}/settings`;
}

/** QT6: trang Dung lượng của ĐÚNG project (luật `project.storage_*`) — nơi dọn, bật dọn tự động, tắt email 70/85. */
export function storageConsoleLink(webUrl: string, projectId: string, anchor?: string): string {
  const p = new URLSearchParams({ project: projectId });
  return `${consoleBase(webUrl)}/dashboard/storage?${p.toString()}${anchor ? `#${anchor}` : ''}`;
}

const isStorageRule = (rule: string) => rule.startsWith('project.storage_');

const dateFmt = new Map<string, Intl.DateTimeFormat>();
function formatDateTime(at: Date, locale: AlertTextLocale): string {
  let f = dateFmt.get(locale);
  if (!f) {
    f = new Intl.DateTimeFormat(locale === 'vi' ? 'vi-VN' : 'en-US', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: ALERT_EMAIL_TIME_ZONE,
    });
    dateFmt.set(locale, f);
  }
  return f.format(at);
}

/** Tác động đo được: số delivery DEAD (luật đích dùng `facts.dead`, `delivery.dead_spike` dùng `facts.count`). */
function deadImpact(a: AlertLike): number | null {
  const f = a.facts ?? {};
  const v = a.rule === 'delivery.dead_spike' ? f.count : a.rule.startsWith('destination.') ? f.dead : null;
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
}

/** Dựng thư (subject + HTML + text). Mọi chuỗi động đều escape HTML. */
export function renderAlertEmail(input: AlertEmailInput): AlertEmail {
  const { kind, locale, alert, project } = input;
  const t = createAlertTextT(locale, EMAIL_TEXT);
  const now = (input.now ?? new Date()).getTime();
  const txt = buildAlertText(alert, t, { locale, now, subjectName: input.subjectName ?? null, timeZone: ALERT_EMAIL_TIME_ZONE });
  const sev = alert.severity.toUpperCase();
  const tag = input.test ? `[${t('email.tag.test')}]` : input.reminder ? `[${t('email.tag.reminder')}]` : '';
  const state = kind === 'RESOLVED' ? `[${t('email.tag.resolved')}]` : `[${sev}]`;
  const subject = `[Webhook Hub]${tag}${state}[${project.slug}] ${txt.title}`.replace(/[\r\n]+/g, ' ');

  const tz = t('email.timezone');
  const rows: [string, string][] = [
    [t('email.label.project'), `${project.name} (${project.slug})`],
    [t('email.label.subject'), `${txt.subjectLabel} · ${ruleName(alert.rule, t)}`],
    [t('email.label.since'), `${formatDateTime(alert.openedAt, locale)} (${tz})`],
  ];
  if (kind === 'RESOLVED' && alert.resolvedAt) rows.push([t('email.label.resolved-at'), `${formatDateTime(alert.resolvedAt, locale)} (${tz})`]);
  if (txt.message) rows.push([t('email.label.details'), txt.message]);
  const dead = kind === 'OPEN' ? deadImpact(alert) : null;
  if (dead !== null) rows.push([t('email.label.impact'), t('email.impact.dead', { dead })]);
  if (kind === 'OPEN' && txt.fix) rows.push([t('email.label.fix'), txt.fix]);

  const heading = kind === 'RESOLVED' ? t('email.heading.resolved') : t('email.heading.open', { severity: t(`alerts.severity.${alert.severity}`) });
  const lead = kind === 'RESOLVED' ? t('email.resolved.lead') : null;
  const rollup = input.rollup && input.rollup > 0 ? t('email.rollup', { count: input.rollup }) : null;
  const banner = input.test ? t('email.test.banner') : null;
  const storage = isStorageRule(alert.rule);
  const owner = input.audience === 'owner';
  const link = storage ? storageConsoleLink(input.webUrl, project.id) : alertConsoleLink(input.webUrl, alert, project.id);
  const settings = owner ? storageConsoleLink(input.webUrl, project.id, 'email') : alertSettingsLink(input.webUrl);
  const settingsText = owner ? t('email.settings.owner') : t('email.settings');
  const footer = owner ? t('email.footer.owner') : t('email.footer');
  const cta = storage ? t('email.cta.storage') : t('email.cta');
  // §3: thư ở nấc 70% có thêm link "Bật dọn tự động".
  const autoClean = storage && kind === 'OPEN' && alert.facts?.level === 'WARN_70' ? storageConsoleLink(input.webUrl, project.id, 'auto-clean') : null;
  const color = kind === 'RESOLVED' ? '#15803d' : alert.severity === 'critical' ? '#b91c1c' : '#b45309';

  const html = [
    `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:600px;color:#111">`,
    banner ? `<p style="background:#eef2ff;border:1px solid #c7d2fe;padding:8px 12px;border-radius:6px">${esc(banner)}</p>` : '',
    `<div style="border-left:4px solid ${color};padding:4px 0 4px 12px;margin:12px 0">`,
    `<div style="color:${color};font-size:12px;font-weight:600;text-transform:uppercase">${esc(heading)}</div>`,
    `<h2 style="margin:4px 0 0">${esc(txt.title)}</h2>`,
    `</div>`,
    lead ? `<p>${esc(lead)}</p>` : '',
    `<table style="border-collapse:collapse;width:100%;font-size:14px">`,
    ...rows.map(([k, v]) => `<tr><td style="padding:6px 12px 6px 0;color:#555;vertical-align:top;white-space:nowrap">${esc(k)}</td><td style="padding:6px 0">${esc(v)}</td></tr>`),
    `</table>`,
    rollup ? `<p style="margin-top:16px;font-weight:600">${esc(rollup)}</p>` : '',
    `<p style="margin:20px 0"><a href="${esc(link)}" style="background:${color};color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none;display:inline-block">${esc(cta)}</a></p>`,
    autoClean ? `<p><a href="${esc(autoClean)}">${esc(t('email.storage.auto-clean'))}</a></p>` : '',
    `<p style="font-size:12px;color:#666"><a href="${esc(settings)}">${esc(settingsText)}</a></p>`,
    `<p style="font-size:12px;color:#666">${esc(footer)}</p>`,
    `</div>`,
  ]
    .filter(Boolean)
    .join('\n');

  const text = [
    ...(banner ? [banner, ''] : []),
    heading.toUpperCase(),
    txt.title,
    '',
    ...(lead ? [lead, ''] : []),
    ...rows.map(([k, v]) => `${k}: ${v}`),
    ...(rollup ? ['', rollup] : []),
    '',
    `${cta}: ${link}`,
    ...(autoClean ? [`${t('email.storage.auto-clean')}: ${autoClean}`] : []),
    `${settingsText}: ${settings}`,
    '',
    footer,
    '— Webhook Hub',
  ].join('\n');

  return { subject, html, text };
}

/** Cảnh báo mẫu cho "Gửi email thử": 401 ở một đích giả định — đúng khuôn thư thật, không đọc dữ liệu thật nào. */
export function sampleAlertEmail(opts: { locale: AlertTextLocale; webUrl: string; project: { id: string; slug: string; name: string }; now?: Date }): AlertEmail {
  const now = opts.now ?? new Date();
  const since = new Date(now.getTime() - 12 * 60_000);
  return renderAlertEmail({
    kind: 'OPEN',
    locale: opts.locale,
    test: true,
    now,
    webUrl: opts.webUrl,
    project: opts.project,
    subjectName: opts.locale === 'vi' ? 'đích-ví-dụ' : 'example-destination',
    alert: {
      rule: 'destination.auth_rejected',
      severity: 'critical',
      subjectType: 'destination',
      subjectId: '00000000-0000-4000-8000-000000000000',
      facts: { count: 3, httpStatus: 401, sinceAt: since.toISOString(), dead: 3 },
      openedAt: since,
    },
  });
}
