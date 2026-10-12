import { INTL_LOCALE, type Locale } from "../i18n/locales";

// Một formatter mỗi ngôn ngữ, tạo sẵn (Intl.*Format tạo mới mỗi lần gọi là đắt khi render bảng dài).
const dateTime: Record<Locale, Intl.DateTimeFormat> = {
  vi: new Intl.DateTimeFormat(INTL_LOCALE.vi, { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }),
  en: new Intl.DateTimeFormat(INTL_LOCALE.en, { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }),
};

/** `locale` = ngôn ngữ giao diện (useLocale()); vắng = vi như trước. */
export function formatDateTime(iso: string | null | undefined, locale: Locale = "vi"): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : dateTime[locale].format(d);
}

// Mốc "dd/MM HH:mm[:ss]" CÙNG một khuôn ở mọi ngôn ngữ, 24 giờ (review trên trình duyệt thật: vi ra "14:19 12-10", en
// ra "10/12, 02:19 PM" cho cùng một mốc). Lấy từng phần qua formatToParts để không phụ thuộc thứ tự/dấu nối của locale.
const stampParts = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit",
  month: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

/** Mốc tuyệt đối gọn cho cảnh báo (dòng thời gian, bảng số liệu): "12/10 14:19" hoặc "12/10 14:19:38" — vi và en như nhau. */
export function formatStamp(at: string | number | Date | null | undefined, opts: { seconds?: boolean } = {}): string {
  if (at === null || at === undefined || at === "") return "—";
  const d = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(d.getTime())) return "—";
  const p: Record<string, string> = {};
  for (const x of stampParts.formatToParts(d)) p[x.type] = x.value;
  const hour = p.hour === "24" ? "00" : p.hour;
  return `${p.day}/${p.month} ${hour}:${p.minute}${opts.seconds ? `:${p.second}` : ""}`;
}

const rtf: Record<Locale, Intl.RelativeTimeFormat> = {
  vi: new Intl.RelativeTimeFormat("vi", { numeric: "auto" }),
  en: new Intl.RelativeTimeFormat("en", { numeric: "auto" }),
};

export function formatRelative(iso: string | null | undefined, now = Date.now(), locale: Locale = "vi"): string {
  if (!iso) return "—";
  const diffSec = Math.round((new Date(iso).getTime() - now) / 1000);
  const abs = Math.abs(diffSec);
  if (abs < 60) return rtf[locale].format(diffSec, "second");
  if (abs < 3600) return rtf[locale].format(Math.round(diffSec / 60), "minute");
  if (abs < 86400) return rtf[locale].format(Math.round(diffSec / 3600), "hour");
  return rtf[locale].format(Math.round(diffSec / 86400), "day");
}

export function shortId(id: string, n = 8): string {
  return id.length > n ? `${id.slice(0, n)}…` : id;
}
