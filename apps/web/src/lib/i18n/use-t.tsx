"use client";

import { createContext, type ReactNode, use, useMemo } from "react";

import { useShallow } from "zustand/react/shallow";

import { usePreferencesStore } from "@/stores/preferences/preferences-provider";

import { createT, DEFAULT_LOCALE, type Locale, type TranslateFn } from "./dictionary";

/**
 * Ngôn ngữ mà SERVER đã render (đọc cookie `language` ở layout). Dùng cho tới khi store preference đồng bộ với DOM
 * — cùng mẹo `isSynced ? store : props` của AppSidebar — để HTML server và lần render đầu ở client khớp nhau.
 */
const ServerLocaleContext = createContext<Locale>(DEFAULT_LOCALE);

export function LocaleProvider({ locale, children }: { locale: Locale; children: ReactNode }) {
  return <ServerLocaleContext.Provider value={locale}>{children}</ServerLocaleContext.Provider>;
}

export function useLocale(): Locale {
  const serverLocale = use(ServerLocaleContext);
  const { language, isSynced } = usePreferencesStore(
    useShallow((s) => ({ language: s.values.language, isSynced: s.isSynced })),
  );
  return isSynced ? language : serverLocale;
}

/** Client component: `const t = useT(); t("nav.item.sources")` — khoá có kiểu, sai khoá là lỗi biên dịch. */
export function useT(): TranslateFn {
  const locale = useLocale();
  return useMemo(() => createT(locale), [locale]);
}
