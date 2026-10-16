import type { ReactNode } from "react";

import { AccountShell } from "@/components/admin/account-menu";
import { AuthGuard } from "@/components/admin/auth-guard";
import { LocaleProvider } from "@/lib/i18n/use-t";
import { getPreference } from "@/server/server-actions";

/**
 * ADR-237 — trang tầng TÀI KHOẢN `/alerts`, `/settings`: cùng khuôn `/projects` (thanh trên có menu tài khoản, KHÔNG sidebar
 * dự án). Cảnh báo xuyên dự án (ADR-190), Cài đặt là email cảnh báo của người vận hành — không thuộc dự án đang chọn.
 */
export default async function AccountPagesLayout({ children }: Readonly<{ children: ReactNode }>) {
  const language = await getPreference("language");
  return (
    <LocaleProvider locale={language}>
      <AuthGuard>
        <AccountShell>{children}</AccountShell>
      </AuthGuard>
    </LocaleProvider>
  );
}
