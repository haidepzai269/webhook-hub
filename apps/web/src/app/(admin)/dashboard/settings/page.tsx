import { redirect } from "next/navigation";

import { legacyAccountRedirect } from "@/lib/hub/account-routes";

/**
 * ADR-237: Cài đặt đã lên tầng tài khoản (`/settings`, không sidebar dự án). Đường cũ còn trong email đã gửi / bookmark -> chuyển
 * hướng, giữ nguyên query.
 */
export default async function LegacySettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  redirect(legacyAccountRedirect("settings", await searchParams));
}
