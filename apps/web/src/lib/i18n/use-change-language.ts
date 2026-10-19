"use client";

import { useRouter } from "next/navigation";

import { hubFetch } from "@/lib/hub/client";
import type { Locale } from "@/lib/i18n/locales";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";

/**
 * Đổi ngôn ngữ giao diện. Lưu như theme: preference `language` (cookie, ghi đồng bộ trong setPreference) rồi
 * `router.refresh()` để server component (layout, getT()) render lại bằng cookie mới — không thì trang lẫn vi/en.
 * DINH-CHINH D3 (CB4): SAU khi đặt cookie, báo server `PUT /api/v1/me/locale` (worker gửi email cảnh báo theo ngôn ngữ này)
 * — bắn rồi quên: lỗi mạng/phiên không được chặn việc đổi ngôn ngữ trên màn hình.
 * (Trước ADR-266 đây là thân của `LanguageSwitcher`; giữ nguyên cơ chế, chỉ đổi chỗ gọi.)
 */
export function useChangeLanguage(): (next: Locale) => void {
  const router = useRouter();
  const setPreference = usePreferencesStore((state) => state.setPreference);
  return (next) => {
    setPreference("language", next);
    router.refresh();
    void hubFetch("/api/v1/me/locale", { method: "PUT", body: JSON.stringify({ locale: next }) }).catch(() => undefined);
  };
}
