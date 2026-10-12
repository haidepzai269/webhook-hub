/**
 * i18n của admin console — hai ngôn ngữ (vi mặc định, en), KHÔNG thư viện i18n.
 *
 * ── Cấu trúc ──────────────────────────────────────────────────────────────────────────────────────────────
 *   locales.ts          LOCALES / Locale / DEFAULT_LOCALE + defineMessages()
 *   messages/<ns>.ts    một namespace = một file, vi + en cạnh nhau (common, nav, header, layout, rồi page.<tên>…)
 *   dictionary.ts       (file này) gộp namespace → DICTIONARIES, MessageKey, translate()
 *   use-t.tsx           client component: useT() / useLocale() / <LocaleProvider>
 *   server.ts           server component / route: await getT() / await getLocale()
 *   Ngôn ngữ đang chọn = preference `language` (cookie, cùng cơ chế theme — lib/preferences/preferences-config.ts).
 *
 * ── Thêm namespace cho một trang (vd. trang Nguồn) ────────────────────────────────────────────────────────
 *   1. Tạo messages/page-sources.ts:
 *        export const pageSources = defineMessages("page.sources", {
 *          vi: { "page.sources.title": "Nguồn", "page.sources.empty": "Chưa có nguồn nào" },
 *          en: { "page.sources.title": "Sources", "page.sources.empty": "No sources yet" },
 *        });
 *      Khoá phải bắt đầu bằng "<namespace>." và en phải có đúng bộ khoá của vi — sai là lỗi tsc.
 *   2. Thêm `...pageSources.vi` / `...pageSources.en` vào NAMESPACES bên dưới.
 *   3. Dùng: client → `const t = useT(); t("page.sources.title")`;
 *            server → `const t = await getT(); t("page.sources.title")`.
 *      Biến: chuỗi "Đã xoá {count} mục" + `t("…", { count: 3 })`.
 *      Đổi ngôn ngữ: LanguageSwitcher ghi cookie rồi gọi `router.refresh()` → server component (getT) render lại
 *      ngay; client component (useT) đổi theo store. Ai tự viết nút đổi ngôn ngữ khác cũng PHẢI refresh như vậy.
 *   4. `dictionary.spec.ts` tự kiểm tra mọi locale đủ khoá, không rỗng — chạy `npx jest apps/web/src/lib/i18n`.
 *   Từ dùng chung (Lưu, Huỷ, Xoá, Đang tải…) → `common.*`, đừng lặp ở từng trang.
 *   Mỗi nhãn chỉ MỘT ngôn ngữ — không kèm tiếng kia trong ngoặc ("Nguồn (Sources)" là sai).
 *
 * File này và messages/* là TS thuần (không React, không alias `@/`) để jest gốc của repo import thẳng.
 */
import { DEFAULT_LOCALE, LOCALES, type Locale } from "./locales";
import { common } from "./messages/common";
import { header } from "./messages/header";
import { layout } from "./messages/layout";
import { nav } from "./messages/nav";

export { DEFAULT_LOCALE, LOCALES, type Locale } from "./locales";

const NAMESPACES = {
  vi: { ...common.vi, ...nav.vi, ...header.vi, ...layout.vi },
  en: { ...common.en, ...nav.en, ...header.en, ...layout.en },
} satisfies Record<Locale, unknown>;

export type MessageKey = keyof (typeof NAMESPACES)["vi"];
export type Dictionary = Record<MessageKey, string>;

export const DICTIONARIES: Record<Locale, Dictionary> = NAMESPACES;

export type TranslateVars = Record<string, string | number>;
export type TranslateFn = (key: MessageKey, vars?: TranslateVars) => string;

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

/** Ngôn ngữ kế tiếp khi bấm nút chuyển (vi → en → vi). */
export function nextLocale(locale: Locale): Locale {
  return LOCALES[(LOCALES.indexOf(locale) + 1) % LOCALES.length];
}

/** Tra khoá; `{name}` được thay bằng `vars.name` (biến không truyền thì giữ nguyên). Thiếu khoá → rơi về vi. */
export function translate(locale: Locale, key: MessageKey, vars?: TranslateVars): string {
  const template = DICTIONARIES[locale][key] ?? DICTIONARIES[DEFAULT_LOCALE][key] ?? key;
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => (name in vars ? String(vars[name]) : match));
}

/** Hàm t gắn sẵn locale — dùng chung cho useT() (client) và getT() (server). */
export function createT(locale: Locale): TranslateFn {
  return (key, vars) => translate(locale, key, vars);
}
