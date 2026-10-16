import type { ReactNode } from "react";

import { LocaleProvider } from "@/lib/i18n/use-t";
import { getPreference } from "@/server/server-actions";

/**
 * ADR-234 — tầng TÀI KHOẢN: "Dự án của tôi" nằm NGOÀI layout dashboard (không sidebar dự án).
 * Guard đăng nhập đặt ở page (chế độ `?demo=1` bỏ qua guard để xem bố cục khi hub-api không chạy).
 */
export default async function AccountLayout({ children }: Readonly<{ children: ReactNode }>) {
  const language = await getPreference("language");
  return <LocaleProvider locale={language}>{children}</LocaleProvider>;
}
