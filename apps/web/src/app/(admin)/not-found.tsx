import { FileQuestion } from "lucide-react";
import Link from "next/link";

import { StatusScreen } from "@/components/admin/status-screen";
import { Button } from "@/components/ui/button";
import { getT } from "@/lib/i18n/server";

/**
 * 404 của nhóm (admin) — cùng khuôn `StatusScreen` với màn xin lỗi của ScreenGuard (ADR-261). Chỉ áp cho (admin): storefront
 * (shop) có root layout riêng; URL không khớp route nào vẫn dùng 404 mặc định của Next.
 */
export default async function AdminNotFound() {
  const t = await getT();
  return (
    <main>
    <StatusScreen icon={FileQuestion} code="404" title={t("mobile.notfound.title")} description={t("mobile.notfound.desc")}>
      <Button asChild className="min-h-10">
        <Link href="/dashboard">{t("mobile.guard.home")}</Link>
      </Button>
    </StatusScreen>
    </main>
  );
}
