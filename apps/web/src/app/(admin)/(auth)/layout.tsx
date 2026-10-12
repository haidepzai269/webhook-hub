import type { ReactNode } from "react";

import { LocaleProvider } from "@/lib/i18n/use-t";
import { getPreference } from "@/server/server-actions";

/** Trang xác thực render ĐÚNG ngôn ngữ của cookie ngay từ server (như dashboard/layout) — không nháy vi → en. */
export default async function AuthLayout({ children }: Readonly<{ children: ReactNode }>) {
  return <LocaleProvider locale={await getPreference("language")}>{children}</LocaleProvider>;
}
