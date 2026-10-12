/**
 * CB5 (SPEC-canh-bao-nhan-dinh §2, §4, §6): câu chữ của MỘT cảnh báo `{ title, message, fix }` dựng từ `rule + facts` —
 * dùng CHUNG cho console (apps/web, qua alias `@hub/common/alerts/text`) và email (hub-worker, hub-api gửi thử). Một nguồn
 * câu: sửa câu ở đây thì chuông, banner, trang Cảnh báo và email cùng đổi (CB4 đã dựng ở web; CB5 chuyển về đây).
 * - Khoá `alerts.<…>` giữ NGUYÊN như từ điển web (web trải `ALERT_TEXT.vi/en` vào namespace `alerts`).
 * - TS THUẦN: không import gì (kể cả trong @hub/common) — Next build web kéo thẳng file này.
 * - D5: tên nhà cung cấp lấy từ `facts.providerLabel` (dữ liệu) qua bảng tên — không nhánh theo provider. BB-1: không câu
 *   nào biết nghiệp vụ.
 */

export type AlertTextLocale = 'vi' | 'en';
export type AlertTextVars = Record<string, string | number>;
/** Hàm dịch tối thiểu: khoá thiếu -> trả chính khoá (cùng hợp đồng `translate` của web). */
export type AlertTextT = (key: string, vars?: AlertTextVars) => string;

const VI = {
  "alerts.severity.critical": "Nghiêm trọng",
  "alerts.severity.warning": "Cần chú ý",
  "alerts.severity.info": "Thông tin",
  "alerts.state.open": "Đang mở",
  "alerts.state.resolved": "Đã ổn",
  "alerts.subject.destination": "Đích",
  "alerts.subject.source": "Nguồn",
  "alerts.subject.project": "Toàn dự án",
  "alerts.subject.fallback": "{type} {id}",
  "alerts.headline": "{subject}: {title}",
  "alerts.rule.destination.auth-rejected.name": "Đích từ chối xác thực",
  "alerts.rule.destination.auth-rejected.title": "Bên nhận từ chối xác thực ({status})",
  "alerts.rule.destination.auth-rejected.message": "{count} lần thử liên tiếp bị từ chối kể từ {since}.",
  "alerts.rule.destination.auth-rejected.impact": "{dead} sự kiện đã DEAD ngay vì lỗi 4xx không được thử lại.",
  "alerts.rule.destination.auth-rejected.fix":
    "Thường do secret phía nhận đã đổi. Cập nhật secret của đích, kiểm tra lại, rồi phát lại hàng đợi lỗi.",
  "alerts.rule.destination.client-error.name": "Đích từ chối nội dung",
  "alerts.rule.destination.client-error.title": "Bên nhận từ chối nội dung ({status})",
  "alerts.rule.destination.client-error.message": "{count} lần thử liên tiếp bị trả {status} kể từ {since}.",
  "alerts.rule.destination.client-error.fix":
    "Yêu cầu bị từ chối vì nội dung. Kiểm tra bên nhận có hiểu kiểu sự kiện và khuôn dữ liệu hub gửi.",
  "alerts.rule.destination.failing.name": "Đích lỗi hoặc chậm",
  "alerts.rule.destination.failing.title": "Bên nhận lỗi hoặc chậm: {pct}% thất bại",
  "alerts.rule.destination.failing.message": "{failed}/{total} lần thử trong 15 phút gần nhất thất bại: {breakdown}.",
  "alerts.rule.destination.failing.reassure": "Hub vẫn đang tự thử lại giúp bạn.",
  "alerts.rule.destination.failing.fix.server-error": "Lỗi nằm ở phía bên nhận (5xx). Xem nhật ký của bên nhận.",
  "alerts.rule.destination.failing.fix.no-response": "Bên nhận không trả lời: kiểm tra nó còn chạy và mạng tới được.",
  "alerts.rule.destination.failing.fix.throttled": "Bên nhận đang bảo chậm lại (408/429): hạ giới hạn RPS của đích.",
  "alerts.rule.destination.failing.fix.unexpected": "Bên nhận trả mã 3xx: kiểm tra lại URL của đích, có thể địa chỉ đã chuyển.",
  "alerts.class.server-error": "{n} lỗi 5xx",
  "alerts.class.no-response": "{n} không phản hồi",
  "alerts.class.throttled": "{n} lần bị bảo chậm lại",
  "alerts.class.unexpected": "{n} mã 3xx/lạ",
  "alerts.rule.destination.circuit-open.name": "Tạm ngưng gửi (mạch bảo vệ)",
  "alerts.rule.destination.circuit-open.title": "Hub tạm ngưng gửi tới đích này",
  "alerts.rule.destination.circuit-open.message": "Mạch bảo vệ đang mở để bên nhận có thời gian hồi phục.",
  "alerts.rule.destination.circuit-open.retry-at": "Hub thử lại lúc {at}.",
  "alerts.rule.destination.circuit-open.fix":
    "Không cần làm gì nếu bên nhận tự hồi phục. Nếu kéo dài, kiểm tra bên nhận và các lượt giao gần nhất.",
  "alerts.rule.delivery.dead-spike.name": "Nhiều sự kiện ngừng thử",
  "alerts.rule.delivery.dead-spike.title": "{count} sự kiện đã ngừng thử trong 1 giờ",
  "alerts.rule.delivery.dead-spike.message": "Các lượt giao này đã vào hàng đợi lỗi (DEAD) và sẽ không tự gửi lại.",
  "alerts.rule.delivery.dead-spike.fix": "Mở hàng đợi lỗi (đã lọc 1 giờ), sửa nguyên nhân ở bên nhận rồi phát lại hàng loạt.",
  "alerts.rule.source.signature-failing.name": "Chữ ký sai",
  "alerts.rule.source.signature-failing.title": "Chữ ký sai ở {failed}/{total} yêu cầu",
  "alerts.rule.source.signature-failing.message":
    "{pct}% yêu cầu tới nguồn này trong 15 phút gần nhất bị từ chối vì chữ ký không khớp.",
  "alerts.rule.source.signature-failing.fix":
    "Hoặc secret của nguồn sai, hoặc có người đang gửi yêu cầu giả. Đối chiếu secret với nhà cung cấp, xoay secret nếu nghi bị lộ.",
  "alerts.rule.source.connection-broken.name": "Kết nối nhà cung cấp hỏng",
  "alerts.rule.source.connection-broken.title.failed": "Kết nối {provider} bị lỗi",
  "alerts.rule.source.connection-broken.title.drifted": "Webhook phía {provider} đã bị đổi hoặc gỡ",
  "alerts.rule.source.connection-broken.title.pending": "Kết nối {provider} bị kẹt",
  "alerts.rule.source.connection-broken.message.failed": "Hub không đăng ký được webhook với {provider}.",
  "alerts.rule.source.connection-broken.message.drifted": "Hub sẽ không nhận được sự kiện từ {provider} cho tới khi kết nối lại.",
  "alerts.rule.source.connection-broken.message.pending": "Lần kết nối bắt đầu từ {since} vẫn chưa xong.",
  "alerts.rule.source.connection-broken.fix": "Mở trang Nguồn và bấm Kết nối lại.",
  "alerts.rule.source.silent.name": "Nguồn im lặng",
  "alerts.rule.source.silent.title": "Nguồn im lặng {duration}",
  "alerts.rule.source.silent.message": "Bình thường khoảng {gap} có một sự kiện. Sự kiện cuối lúc {last}.",
  "alerts.rule.source.silent.fix": "Nhà cung cấp có thể đã ngừng gửi. Kiểm tra cấu hình webhook ở phía nhà cung cấp.",
  "alerts.rule.normalize.backlog.name": "Sự kiện thô chưa chuẩn hoá",
  "alerts.rule.normalize.backlog.title": "{count} sự kiện thô chưa được chuẩn hoá",
  "alerts.rule.normalize.backlog.message": "Đã nhận và lưu an toàn nhưng quá 10 phút chưa chuẩn hoá, nên chưa được giao.",
  "alerts.rule.normalize.backlog.fix": "Kiểm tra tiến trình worker, rồi bấm Chuẩn hoá lại ở trang Hành trình sự kiện.",
  "alerts.rule.unknown.title": "Cảnh báo {rule}",
  "alerts.unit.seconds": "{n} giây",
  "alerts.unit.minutes": "{n} phút",
  "alerts.unit.hours": "{n} giờ",
  "alerts.unit.days": "{n} ngày",
  "alerts.reason.archived": "Đóng vì đối tượng đã bị lưu trữ hoặc xoá.",
  "alerts.reason.inactive": "Đóng vì đối tượng đã bị ngắt.",
  "alerts.reason.disconnected": "Đóng vì kết nối với nhà cung cấp đã được gỡ.",
} as const;

const EN: { [K in keyof typeof VI]: string } = {
  "alerts.severity.critical": "Critical",
  "alerts.severity.warning": "Warning",
  "alerts.severity.info": "Info",
  "alerts.state.open": "Open",
  "alerts.state.resolved": "Resolved",
  "alerts.subject.destination": "Destination",
  "alerts.subject.source": "Source",
  "alerts.subject.project": "Whole project",
  "alerts.subject.fallback": "{type} {id}",
  "alerts.headline": "{subject}: {title}",
  "alerts.rule.destination.auth-rejected.name": "Destination rejects authentication",
  "alerts.rule.destination.auth-rejected.title": "Receiver rejected authentication ({status})",
  "alerts.rule.destination.auth-rejected.message": "{count} attempts in a row rejected since {since}.",
  "alerts.rule.destination.auth-rejected.impact": "{dead} events went DEAD immediately because 4xx errors are not retried.",
  "alerts.rule.destination.auth-rejected.fix":
    "Usually the receiver's secret changed. Update the destination's secret, re-check it, then replay the dead-letter queue.",
  "alerts.rule.destination.client-error.name": "Destination rejects content",
  "alerts.rule.destination.client-error.title": "Receiver rejected the content ({status})",
  "alerts.rule.destination.client-error.message": "{count} attempts in a row answered {status} since {since}.",
  "alerts.rule.destination.client-error.fix":
    "The request is rejected for its content. Check that the receiver understands the event type and the payload shape the hub sends.",
  "alerts.rule.destination.failing.name": "Destination failing or slow",
  "alerts.rule.destination.failing.title": "Receiver failing or slow: {pct}% failed",
  "alerts.rule.destination.failing.message": "{failed}/{total} attempts in the last 15 minutes failed: {breakdown}.",
  "alerts.rule.destination.failing.reassure": "The hub keeps retrying for you.",
  "alerts.rule.destination.failing.fix.server-error": "The fault is on the receiver's side (5xx). Check the receiver's logs.",
  "alerts.rule.destination.failing.fix.no-response": "The receiver does not answer: check that it is running and reachable.",
  "alerts.rule.destination.failing.fix.throttled":
    "The receiver is asking to slow down (408/429): lower the destination's RPS limit.",
  "alerts.rule.destination.failing.fix.unexpected": "The receiver answers 3xx: check the destination URL, it may have moved.",
  "alerts.class.server-error": "{n} 5xx errors",
  "alerts.class.no-response": "{n} with no response",
  "alerts.class.throttled": "{n} asked to slow down",
  "alerts.class.unexpected": "{n} 3xx/unexpected",
  "alerts.rule.destination.circuit-open.name": "Sending paused (circuit breaker)",
  "alerts.rule.destination.circuit-open.title": "Hub paused sending to this destination",
  "alerts.rule.destination.circuit-open.message": "The circuit breaker is open so the receiver has time to recover.",
  "alerts.rule.destination.circuit-open.retry-at": "The hub tries again at {at}.",
  "alerts.rule.destination.circuit-open.fix":
    "Nothing to do if the receiver recovers on its own. If it persists, check the receiver and its recent deliveries.",
  "alerts.rule.delivery.dead-spike.name": "Many events stopped retrying",
  "alerts.rule.delivery.dead-spike.title": "{count} events stopped retrying in the last hour",
  "alerts.rule.delivery.dead-spike.message":
    "These deliveries are now in the dead-letter queue (DEAD) and will not be sent again on their own.",
  "alerts.rule.delivery.dead-spike.fix":
    "Open the dead-letter queue (filtered to 1 hour), fix the cause on the receiver, then bulk replay.",
  "alerts.rule.source.signature-failing.name": "Invalid signatures",
  "alerts.rule.source.signature-failing.title": "Invalid signature on {failed}/{total} requests",
  "alerts.rule.source.signature-failing.message":
    "{pct}% of requests to this source in the last 15 minutes were rejected for a mismatched signature.",
  "alerts.rule.source.signature-failing.fix":
    "Either the source secret is wrong, or someone is sending forged requests. Compare the secret with the provider and rotate it if you suspect a leak.",
  "alerts.rule.source.connection-broken.name": "Provider connection broken",
  "alerts.rule.source.connection-broken.title.failed": "{provider} connection failed",
  "alerts.rule.source.connection-broken.title.drifted": "The webhook on {provider}'s side was changed or removed",
  "alerts.rule.source.connection-broken.title.pending": "{provider} connection is stuck",
  "alerts.rule.source.connection-broken.message.failed": "The hub could not register its webhook with {provider}.",
  "alerts.rule.source.connection-broken.message.drifted": "The hub will not receive events from {provider} until you reconnect.",
  "alerts.rule.source.connection-broken.message.pending": "The connection attempt started at {since} has not finished.",
  "alerts.rule.source.connection-broken.fix": "Open Sources and click Reconnect.",
  "alerts.rule.source.silent.name": "Silent source",
  "alerts.rule.source.silent.title": "Source silent for {duration}",
  "alerts.rule.source.silent.message": "Normally one event about every {gap}. Last event at {last}.",
  "alerts.rule.source.silent.fix": "The provider may have stopped sending. Check the webhook settings on the provider's side.",
  "alerts.rule.normalize.backlog.name": "Raw events not normalized",
  "alerts.rule.normalize.backlog.title": "{count} raw events not normalized",
  "alerts.rule.normalize.backlog.message":
    "Received and stored safely, but not normalized for over 10 minutes, so not delivered yet.",
  "alerts.rule.normalize.backlog.fix": "Check the worker process, then click Re-normalize on the Event journeys page.",
  "alerts.rule.unknown.title": "Alert {rule}",
  "alerts.unit.seconds": "{n} s",
  "alerts.unit.minutes": "{n} min",
  "alerts.unit.hours": "{n} h",
  "alerts.unit.days": "{n} d",
  "alerts.reason.archived": "Closed because the subject was archived or deleted.",
  "alerts.reason.inactive": "Closed because the subject was disabled.",
  "alerts.reason.disconnected": "Closed because the provider connection was removed.",
};

/** Câu chữ cảnh báo dùng chung (vi nguồn khoá, en đủ bộ khoá — tsc kiểm). */
export const ALERT_TEXT: Record<AlertTextLocale, { [K in keyof typeof VI]: string }> & { vi: typeof VI } = { vi: VI, en: EN };
export type AlertTextKey = keyof typeof VI;

/** Thay `{name}` bằng `vars.name` (biến không truyền thì giữ nguyên) — cùng luật với `translate` của web. */
export function fillTemplate(template: string, vars?: AlertTextVars): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => (name in vars ? String(vars[name]) : match));
}

/** Hàm dịch phía server trên một hoặc nhiều bảng (bảng sau đè bảng trước); thiếu khoá -> rơi về vi, rồi chính khoá. */
export function createAlertTextT(locale: AlertTextLocale, ...extra: Partial<Record<AlertTextLocale, Record<string, string>>>[]): AlertTextT {
  const pick = (l: AlertTextLocale): Record<string, string> => Object.assign({}, ALERT_TEXT[l], ...extra.map((e) => e[l] ?? {}));
  const main = pick(locale);
  const fallback = locale === 'vi' ? main : pick('vi');
  return (key, vars) => fillTemplate(main[key] ?? fallback[key] ?? key, vars);
}

export interface AlertLike {
  rule: string;
  facts: Record<string, unknown> | null | undefined;
  subjectType: 'destination' | 'source' | 'project';
  subjectId: string;
}

export interface AlertTextContext {
  locale: AlertTextLocale;
  /** Mốc "bây giờ" (ms) — tiêm vào để test ổn định. */
  now: number;
  /** Tên đối tượng nếu biết (đích/nguồn của project); không biết -> nhãn loại + id ngắn. */
  subjectName?: string | null;
  /** Múi giờ hiển thị mốc giờ (email dựng ở server: `Asia/Ho_Chi_Minh`); bỏ trống = múi giờ của máy (trình duyệt). */
  timeZone?: string;
}

export interface AlertText {
  title: string;
  message: string;
  fix: string;
  /** "{đối tượng}: {title}" — dùng ở banner/toast (một dòng nói đủ "cái gì" và "ở đâu"). */
  headline: string;
  subjectLabel: string;
}

/** Mã BCP-47 cho Intl (cùng bảng `INTL_LOCALE` của web). */
export const ALERT_INTL_LOCALE: Record<AlertTextLocale, string> = { vi: 'vi-VN', en: 'en-US' };

/** Mã luật -> đoạn khoá i18n: `destination.auth_rejected` -> `destination.auth-rejected` (khoá chỉ có chữ thường, '.', '-'). */
export function ruleSegment(rule: string): string {
  return rule.replace(/_/g, '-');
}

/** Khoá `alerts.rule.<luật>.<phần>`. */
export function ruleKey(rule: string, part: string): string {
  return `alerts.rule.${ruleSegment(rule)}.${part}`;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);
const time = (v: unknown): number | null => {
  const s = str(v);
  if (!s) return null;
  const n = Date.parse(s);
  return Number.isNaN(n) ? null : n;
};

/** Thời lượng gọn theo ngôn ngữ: 45 giây · 12 phút · 3 giờ · 2 ngày. */
export function formatDuration(ms: number, t: AlertTextT): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return t('alerts.unit.seconds', { n: s });
  const m = Math.round(s / 60);
  if (m < 90) return t('alerts.unit.minutes', { n: m });
  const h = Math.round(m / 60);
  if (h < 48) return t('alerts.unit.hours', { n: h });
  return t('alerts.unit.days', { n: Math.round(h / 24) });
}

const timeFmt = new Map<string, Intl.DateTimeFormat>();
function fmt(locale: AlertTextLocale, withDay: boolean, timeZone?: string): Intl.DateTimeFormat {
  const k = `${locale}:${withDay}:${timeZone ?? ''}`;
  let f = timeFmt.get(k);
  if (!f) {
    // 24 giờ ở MỌI ngôn ngữ (en-US mặc định ra "02:36 PM" còn vi ra "14:36" — xem trên trình duyệt thật); thứ tự
    // ngày/tháng vẫn theo locale.
    f = new Intl.DateTimeFormat(ALERT_INTL_LOCALE[locale], {
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      ...(withDay ? { day: '2-digit', month: '2-digit' } : {}),
      ...(timeZone ? { timeZone } : {}),
    });
    timeFmt.set(k, f);
  }
  return f;
}

/** Mốc ngắn: "14:02" nếu trong 20 giờ qua/tới, không thì kèm ngày "12/10 14:02". */
export function formatClock(at: number, ctx: Pick<AlertTextContext, 'locale' | 'now' | 'timeZone'>): string {
  return fmt(ctx.locale, Math.abs(ctx.now - at) > 20 * 3600_000, ctx.timeZone).format(new Date(at));
}

/** Tên hiển thị của nhà cung cấp từ mã dữ liệu (`facts.providerLabel`) — bảng tên, không phải nhánh logic. */
const PROVIDER_NAMES: Record<string, string> = { payos: 'PayOS', github: 'GitHub', generic: 'Generic' };
export function providerDisplayName(code: unknown): string {
  const c = str(code);
  if (!c) return '?';
  return PROVIDER_NAMES[c.toLowerCase()] ?? c.charAt(0).toUpperCase() + c.slice(1);
}

/** Nhãn đối tượng: tên nếu biết; cấp dự án -> "Toàn dự án"; không thì "Đích 3fa2c1d0". */
export function subjectLabel(a: Pick<AlertLike, 'subjectType' | 'subjectId'>, t: AlertTextT, name?: string | null): string {
  if (name) return name;
  if (a.subjectType === 'project') return t('alerts.subject.project');
  return t('alerts.subject.fallback', { type: t(`alerts.subject.${a.subjectType}`), id: a.subjectId.slice(0, 8) });
}

/** Loại lỗi của `destination.failing` (khớp `byClass` của rules.ts) — thứ tự cố định để câu ổn định khi bằng nhau. */
export const FAILURE_CLASSES = ['server_error', 'no_response', 'throttled', 'unexpected'] as const;
export type FailureClass = (typeof FAILURE_CLASSES)[number];
const CLASS_SEGMENT: Record<FailureClass, 'server-error' | 'no-response' | 'throttled' | 'unexpected'> = {
  server_error: 'server-error',
  no_response: 'no-response',
  throttled: 'throttled',
  unexpected: 'unexpected',
};

/** byClass -> các loại có số > 0, nhiều nhất trước (bằng nhau giữ thứ tự FAILURE_CLASSES). */
export function failureBreakdown(byClass: unknown): { cls: FailureClass; n: number }[] {
  if (!byClass || typeof byClass !== 'object') return [];
  const b = byClass as Record<string, unknown>;
  return FAILURE_CLASSES.map((cls) => ({ cls, n: num(b[cls]) ?? 0 }))
    .filter((x) => x.n > 0)
    .sort((x, y) => y.n - x.n);
}

/** Câu "cách sửa" của destination.failing theo loại lỗi TRỘI (429 -> chậm lại, 3xx -> URL, không phản hồi -> mạng). */
export function failingFixKey(byClass: unknown): string {
  const top = failureBreakdown(byClass)[0]?.cls ?? 'server_error';
  return `alerts.rule.destination.failing.fix.${CLASS_SEGMENT[top]}`;
}

const join = (...parts: (string | null | undefined | false)[]) => parts.filter(Boolean).join(' ');

/**
 * Dựng câu cho một cảnh báo. Thiếu số liệu thì câu gọn hơn chứ không in "undefined"; luật lạ (server mới hơn web)
 * -> tiêu đề chung có mã luật, không vỡ trang.
 */
export function buildAlertText(a: AlertLike, t: AlertTextT, ctx: AlertTextContext): AlertText {
  const f = a.facts ?? {};
  const subject = subjectLabel(a, t, ctx.subjectName);
  const clock = (v: unknown) => {
    const at = time(v);
    return at === null ? null : formatClock(at, ctx);
  };
  let title: string;
  let message = '';
  let fix = '';

  switch (a.rule) {
    case 'destination.auth_rejected':
    case 'destination.client_error': {
      const status = num(f.httpStatus) ?? (a.rule === 'destination.auth_rejected' ? '401/403' : '4xx');
      title = t(ruleKey(a.rule, 'title'), { status });
      const count = num(f.count);
      const since = clock(f.sinceAt);
      const dead = num(f.dead);
      message = join(
        count !== null && since ? t(ruleKey(a.rule, 'message'), { count, since, status }) : null,
        a.rule === 'destination.auth_rejected' && dead ? t('alerts.rule.destination.auth-rejected.impact', { dead }) : null,
      );
      fix = t(ruleKey(a.rule, 'fix'));
      break;
    }
    case 'destination.failing': {
      const pct = num(f.pct);
      title = t('alerts.rule.destination.failing.title', { pct: pct ?? '?' });
      const parts = failureBreakdown(f.byClass).map(({ cls, n }) => t(`alerts.class.${CLASS_SEGMENT[cls]}`, { n }));
      const failed = num(f.failed);
      const total = num(f.total);
      message = join(
        failed !== null && total !== null && parts.length
          ? t('alerts.rule.destination.failing.message', { failed, total, breakdown: parts.join(', ') })
          : null,
        t('alerts.rule.destination.failing.reassure'),
      );
      fix = t(failingFixKey(f.byClass));
      break;
    }
    case 'destination.circuit_open': {
      title = t('alerts.rule.destination.circuit-open.title');
      const at = clock(f.halfOpenAt);
      message = join(t('alerts.rule.destination.circuit-open.message'), at ? t('alerts.rule.destination.circuit-open.retry-at', { at }) : null);
      fix = t('alerts.rule.destination.circuit-open.fix');
      break;
    }
    case 'delivery.dead_spike': {
      title = t('alerts.rule.delivery.dead-spike.title', { count: num(f.count) ?? '≥10' });
      message = t('alerts.rule.delivery.dead-spike.message');
      fix = t('alerts.rule.delivery.dead-spike.fix');
      break;
    }
    case 'source.signature_failing': {
      title = t('alerts.rule.source.signature-failing.title', { failed: num(f.failed) ?? '?', total: num(f.total) ?? '?' });
      const pct = num(f.pct);
      message = pct !== null ? t('alerts.rule.source.signature-failing.message', { pct }) : '';
      fix = t('alerts.rule.source.signature-failing.fix');
      break;
    }
    case 'source.connection_broken': {
      const provider = providerDisplayName(f.providerLabel);
      const VARIANT: Record<string, 'drifted' | 'pending'> = { DRIFTED: 'drifted', PENDING: 'pending' };
      const variant = (typeof f.status === 'string' && VARIANT[f.status]) || 'failed';
      title = t(ruleKey(a.rule, `title.${variant}`), { provider });
      const since = clock(f.stuckSince);
      message = t(ruleKey(a.rule, `message.${variant}`), { provider });
      if (variant === 'pending') message = since ? t('alerts.rule.source.connection-broken.message.pending', { since }) : '';
      // Review L8: `lastError`/`lastFix` của server là chữ một ngôn ngữ (không dịch được) -> KHÔNG ghép vào câu; chỉ hiện
      // nguyên văn ở bảng số liệu của console. Câu "cách sửa" luôn từ từ điển, đúng ngôn ngữ đang chọn.
      fix = t('alerts.rule.source.connection-broken.fix');
      break;
    }
    case 'source.silent': {
      const last = time(f.lastEventAt);
      const silentMs = last !== null ? ctx.now - last : num(f.silentMs);
      title = t('alerts.rule.source.silent.title', { duration: silentMs !== null ? formatDuration(silentMs, t) : '?' });
      const gap = num(f.medianGapMs);
      message = gap !== null && last !== null ? t('alerts.rule.source.silent.message', { gap: formatDuration(gap, t), last: formatClock(last, ctx) }) : '';
      fix = t('alerts.rule.source.silent.fix');
      break;
    }
    case 'normalize.backlog': {
      title = t('alerts.rule.normalize.backlog.title', { count: num(f.count) ?? '?' });
      message = t('alerts.rule.normalize.backlog.message');
      fix = t('alerts.rule.normalize.backlog.fix');
      break;
    }
    default:
      title = t('alerts.rule.unknown.title', { rule: a.rule });
  }

  const reason = str(f.reason);
  if (reason === 'archived' || reason === 'inactive' || reason === 'disconnected') {
    message = join(message, t(`alerts.reason.${reason}`));
  }
  return { title, message, fix, headline: t('alerts.headline', { subject, title }), subjectLabel: subject };
}

/** Tên ngắn của luật (bộ lọc, Cài đặt, email) — luật lạ -> chính mã luật. */
export function ruleName(rule: string, t: AlertTextT): string {
  const key = ruleKey(rule, 'name');
  const out = t(key);
  return out === key ? rule : out;
}
