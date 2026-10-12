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
