"use client";

import { useRouter } from "next/navigation";

import { Languages } from "lucide-react";

import { Button } from "@/components/ui/button";
import { nextLocale } from "@/lib/i18n/dictionary";
import { useLocale, useT } from "@/lib/i18n/use-t";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";

/**
 * Bấm để đổi vi ⇄ en. Lưu như theme: preference `language` (cookie, ghi đồng bộ trong setPreference) rồi
 * `router.refresh()` để server component (layout, getT()) render lại bằng cookie mới — không thì trang lẫn vi/en.
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
    <Button
      variant="outline"
      onClick={() => {
        setPreference("language", next);
        router.refresh();
      }}
      aria-label={label}
      title={label}
      className="px-2"
    >
      <Languages />
      <span className="font-mono text-xs uppercase">{locale}</span>
    </Button>
  );
}
