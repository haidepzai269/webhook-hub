"use client";

import { Monitor, Moon, Sun } from "lucide-react";
import { useShallow } from "zustand/react/shallow";

import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/admin/icon-button";
import { useT } from "@/lib/i18n/use-t";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";

const THEME_CYCLE = ["light", "dark", "system"] as const;

export function ThemeSwitcher() {
  const t = useT();
  const { themeMode, setPreference } = usePreferencesStore(
    useShallow((state) => ({
      themeMode: state.values.theme_mode,
      setPreference: state.setPreference,
    })),
  );

  const cycleTheme = () => {
    const currentIndex = THEME_CYCLE.indexOf(themeMode);
    setPreference("theme_mode", THEME_CYCLE[(currentIndex + 1) % THEME_CYCLE.length]);
  };

  const label = t("header.theme.aria", { mode: t(`common.theme.${themeMode}`) });

  return (
    <IconButton
      size="icon"
      variant="outline"
      onClick={cycleTheme}
      label={label}
      icon={
        <>
          <Monitor className="hidden [html[data-theme-mode=system]_&]:block" />
          <Sun className="hidden dark:block [html[data-theme-mode=system]_&]:hidden" />
          <Moon className="block dark:hidden [html[data-theme-mode=system]_&]:hidden" />
        </>
      }
    />
  );
}
