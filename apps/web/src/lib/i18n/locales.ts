// Thuần TS, không phụ thuộc gì — dùng được ở server, client, boot script và jest.
export const LOCALES = ["vi", "en"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "vi";

/** Mã BCP-47 cho Intl / toLocaleString — `fmt.toLocaleString(INTL_LOCALE[locale])`, đừng hardcode "vi-VN". */
export const INTL_LOCALE: Record<Locale, string> = { vi: "vi-VN", en: "en-US" };

/**
 * Khai báo một namespace: mọi khoá phải bắt đầu bằng `<ns>.`; bảng `en` phải có ĐÚNG bộ khoá của `vi`
 * (thiếu khoá → lỗi biên dịch; thừa khoá → lỗi excess-property vì truyền object literal). `vi` là nguồn khoá.
 */
export function defineMessages<const NS extends string, const Vi extends Record<`${NS}.${string}`, string>>(
  _namespace: NS,
  messages: { vi: Vi; en: { [K in keyof Vi]: string } },
): Record<Locale, { [K in keyof Vi]: string }> {
  return messages;
}
