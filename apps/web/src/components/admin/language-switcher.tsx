"use client";

import { useRouter } from "next/navigation";

import { Languages } from "lucide-react";

import { Button } from "@/components/ui/button";
import { hubFetch } from "@/lib/hub/client";
import { nextLocale } from "@/lib/i18n/dictionary";
import { useLocale, useT } from "@/lib/i18n/use-t";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * Bấm để đổi vi ⇄ en. Lưu như theme: preference `language` (cookie, ghi đồng bộ trong setPreference) rồi
 * `router.refresh()` để server component (layout, getT()) render lại bằng cookie mới — không thì trang lẫn vi/en.
 * DINH-CHINH D3 (CB4): SAU khi đặt cookie, báo server `PUT /api/v1/me/locale` (worker gửi email cảnh báo theo ngôn ngữ này)
 * — bắn rồi quên: lỗi mạng/phiên không được chặn việc đổi ngôn ngữ trên màn hình.
 */
export function LanguageSwitcher() {
  const router = useRouter();
  const setPreference = usePreferencesStore((state) => state.setPreference);
  const locale = useLocale();
  const t = useT();
  const next = nextLocale(locale);

  const label = t("header.language.aria", {
    language: t(`common.language.${locale}`),
    next: t(`common.language.${next}`),
  });

  return (
    <Tooltip>
      <TooltipTrigger asChild>
    <Button
      variant="outline"
      onClick={() => {
        setPreference("language", next);
        router.refresh();
        void hubFetch("/api/v1/me/locale", { method: "PUT", body: JSON.stringify({ locale: next }) }).catch(() => undefined);
      }}
      aria-label={label}
      className="px-2"
    >
      <Languages />
      <span className="font-mono text-xs uppercase">{locale}</span>
    </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
