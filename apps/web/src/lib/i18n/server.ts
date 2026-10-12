import { getPreference } from "@/server/server-actions";

import { createT, type Locale, type TranslateFn } from "./dictionary";

/** Server component / route handler: ngôn ngữ từ cookie `language` (preference), mặc định vi. */
export function getLocale(): Promise<Locale> {
  return getPreference("language");
}

/** `const t = await getT(); t("nav.item.sources")` trong server component. */
export async function getT(): Promise<TranslateFn> {
  return createT(await getLocale());
}
