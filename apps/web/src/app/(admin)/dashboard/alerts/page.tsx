import { redirect } from "next/navigation";

import { legacyAccountRedirect } from "@/lib/hub/account-routes";

/**
 * ADR-237: Cảnh báo đã lên tầng tài khoản (`/alerts`, không sidebar dự án). Đường cũ còn trong email đã gửi / bookmark -> chuyển
 * hướng, giữ nguyên query.
 */
export default async function LegacyAlertsPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  redirect(legacyAccountRedirect("alerts", await searchParams));
}
