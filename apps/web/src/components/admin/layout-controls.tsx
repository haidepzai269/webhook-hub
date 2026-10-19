"use client";

import { useShallow } from "zustand/react/shallow";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { type FontKey, fontOptions } from "@/lib/fonts/registry";
import { useT } from "@/lib/i18n/use-t";
import type { ContentLayout, NavbarStyle, SidebarCollapsible, SidebarVariant } from "@/lib/preferences/layout";
import { THEME_PRESET_OPTIONS, type ThemeMode, type ThemePreset } from "@/lib/preferences/theme";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";

/**
 * Nội dung bảng tuỳ chỉnh bố cục của Studio Admin; nhãn theo namespace `layout.*` (lib/i18n/messages/layout.ts).
 * ADR-266: không còn nút bánh răng riêng — `DisplaySettings` mở bảng này từ mục "Tuỳ chỉnh bố cục…".
 */
export function LayoutControlsPanel() {
  const t = useT();
  const { values, resolvedThemeMode, setPreference, resetPreferences } = usePreferencesStore(
    useShallow((state) => ({
      values: state.values,
      resolvedThemeMode: state.resolvedThemeMode,
      setPreference: state.setPreference,
      resetPreferences: state.resetPreferences,
    })),
  );

  const toggle =
    <T extends string>(onPick: (v: T) => void) =>
    (v: T | "") => {
      if (v) onPick(v);
    };

  return (
        <div className="flex flex-col gap-5">
          <div className="space-y-1.5">
            <h4 className="font-medium text-sm leading-none">{t("layout.title")}</h4>
            <p className="text-muted-foreground text-xs">{t("layout.hint")}</p>
          </div>
          <div className="space-y-3 **:data-[slot=toggle-group]:w-full **:data-[slot=toggle-group-item]:flex-1 **:data-[slot=toggle-group-item]:text-xs">
            <div className="space-y-1">
              <Label className="font-medium text-xs">{t("layout.preset")}</Label>
              <Select
                value={values.theme_preset}
                onValueChange={(v) => setPreference("theme_preset", v as ThemePreset)}
              >
                <SelectTrigger size="sm" className="w-full text-xs">
                  <SelectValue placeholder={t("layout.preset")} />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {THEME_PRESET_OPTIONS.map((preset) => (
                      <SelectItem key={preset.value} className="text-xs" value={preset.value}>
                        <span
                          className="size-2.5 rounded-full"
                          style={{
                            backgroundColor: resolvedThemeMode === "dark" ? preset.primary.dark : preset.primary.light,
                          }}
                        />
                        {preset.value === "default" ? t("layout.preset.default") : preset.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1">
              <Label className="font-medium text-xs">{t("layout.font")}</Label>
              <Select value={values.font} onValueChange={(v) => setPreference("font", v as FontKey)}>
                <SelectTrigger size="sm" className="w-full text-xs">
                  <SelectValue placeholder={t("layout.font")} />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {fontOptions.map((font) => (
                      <SelectItem key={font.key} className="text-xs" value={font.key}>
                        {font.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1">
              <Label className="font-medium text-xs">{t("layout.mode")}</Label>
              <ToggleGroup
                size="sm"
                spacing={0}
                variant="outline"
                type="single"
                value={values.theme_mode}
                onValueChange={toggle<ThemeMode>((v) => setPreference("theme_mode", v))}
              >
                <ToggleGroupItem value="light">{t("common.theme.light")}</ToggleGroupItem>
                <ToggleGroupItem value="dark">{t("common.theme.dark")}</ToggleGroupItem>
                <ToggleGroupItem value="system">{t("common.theme.system")}</ToggleGroupItem>
              </ToggleGroup>
            </div>

            <div className="space-y-1">
              <Label className="font-medium text-xs">{t("layout.content")}</Label>
              <ToggleGroup
                size="sm"
                spacing={0}
                variant="outline"
                type="single"
                value={values.content_layout}
                onValueChange={toggle<ContentLayout>((v) => setPreference("content_layout", v))}
              >
                <ToggleGroupItem value="centered">{t("layout.content.centered")}</ToggleGroupItem>
                <ToggleGroupItem value="full-width">{t("layout.content.full-width")}</ToggleGroupItem>
              </ToggleGroup>
            </div>

            <div className="space-y-1">
              <Label className="font-medium text-xs">{t("layout.navbar")}</Label>
              <ToggleGroup
                size="sm"
                spacing={0}
                variant="outline"
                type="single"
                value={values.navbar_style}
                onValueChange={toggle<NavbarStyle>((v) => setPreference("navbar_style", v))}
              >
                <ToggleGroupItem value="sticky">{t("layout.navbar.sticky")}</ToggleGroupItem>
                <ToggleGroupItem value="scroll">{t("layout.navbar.scroll")}</ToggleGroupItem>
              </ToggleGroup>
            </div>

            <div className="space-y-1">
              <Label className="font-medium text-xs">{t("layout.sidebar")}</Label>
              <ToggleGroup
                size="sm"
                spacing={0}
                variant="outline"
                type="single"
                value={values.sidebar_variant}
                onValueChange={toggle<SidebarVariant>((v) => setPreference("sidebar_variant", v))}
              >
                <ToggleGroupItem value="inset">{t("layout.sidebar.inset")}</ToggleGroupItem>
                <ToggleGroupItem value="sidebar">{t("layout.sidebar.sidebar")}</ToggleGroupItem>
                <ToggleGroupItem value="floating">{t("layout.sidebar.floating")}</ToggleGroupItem>
              </ToggleGroup>
            </div>

            <div className="space-y-1">
              <Label className="font-medium text-xs">{t("layout.collapsible")}</Label>
              <ToggleGroup
                size="sm"
                spacing={0}
                variant="outline"
                type="single"
                value={values.sidebar_collapsible}
                onValueChange={toggle<SidebarCollapsible>((v) => setPreference("sidebar_collapsible", v))}
              >
                <ToggleGroupItem value="icon">{t("layout.collapsible.icon")}</ToggleGroupItem>
                <ToggleGroupItem value="offcanvas">{t("layout.collapsible.offcanvas")}</ToggleGroupItem>
              </ToggleGroup>
            </div>

            <Button type="button" size="sm" variant="outline" className="w-full text-xs" onClick={resetPreferences}>
              {t("layout.reset")}
            </Button>
          </div>
        </div>
  );
}
