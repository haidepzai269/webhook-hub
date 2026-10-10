"use client";

import { Settings } from "lucide-react";
import { useShallow } from "zustand/react/shallow";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { type FontKey, fontOptions } from "@/lib/fonts/registry";
import type { ContentLayout, NavbarStyle, SidebarCollapsible, SidebarVariant } from "@/lib/preferences/layout";
import { THEME_PRESET_OPTIONS, type ThemeMode, type ThemePreset } from "@/lib/preferences/theme";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";

/** Bảng tuỳ chỉnh giao diện của Studio Admin, Việt hoá nhãn. */
export function LayoutControls() {
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
    <Popover>
      <PopoverTrigger asChild>
        <Button size="icon" variant="outline" aria-label="Tuỳ chỉnh giao diện">
          <Settings />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end">
        <div className="flex flex-col gap-5">
          <div className="space-y-1.5">
            <h4 className="font-medium text-sm leading-none">Tuỳ chỉnh giao diện</h4>
            <p className="text-muted-foreground text-xs">Lưu trong cookie của trình duyệt này.</p>
          </div>
          <div className="space-y-3 **:data-[slot=toggle-group]:w-full **:data-[slot=toggle-group-item]:flex-1 **:data-[slot=toggle-group-item]:text-xs">
            <div className="space-y-1">
              <Label className="font-medium text-xs">Bộ màu</Label>
              <Select
                value={values.theme_preset}
                onValueChange={(v) => setPreference("theme_preset", v as ThemePreset)}
              >
                <SelectTrigger size="sm" className="w-full text-xs">
                  <SelectValue placeholder="Bộ màu" />
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
                        {preset.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1">
              <Label className="font-medium text-xs">Phông chữ</Label>
              <Select value={values.font} onValueChange={(v) => setPreference("font", v as FontKey)}>
                <SelectTrigger size="sm" className="w-full text-xs">
                  <SelectValue placeholder="Phông chữ" />
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
              <Label className="font-medium text-xs">Chế độ</Label>
              <ToggleGroup
                size="sm"
                spacing={0}
                variant="outline"
                type="single"
                value={values.theme_mode}
                onValueChange={toggle<ThemeMode>((v) => setPreference("theme_mode", v))}
              >
                <ToggleGroupItem value="light">Sáng</ToggleGroupItem>
                <ToggleGroupItem value="dark">Tối</ToggleGroupItem>
                <ToggleGroupItem value="system">Hệ thống</ToggleGroupItem>
              </ToggleGroup>
            </div>

            <div className="space-y-1">
              <Label className="font-medium text-xs">Độ rộng nội dung</Label>
              <ToggleGroup
                size="sm"
                spacing={0}
                variant="outline"
                type="single"
                value={values.content_layout}
                onValueChange={toggle<ContentLayout>((v) => setPreference("content_layout", v))}
              >
                <ToggleGroupItem value="centered">Căn giữa</ToggleGroupItem>
                <ToggleGroupItem value="full-width">Toàn màn hình</ToggleGroupItem>
              </ToggleGroup>
            </div>

            <div className="space-y-1">
              <Label className="font-medium text-xs">Thanh trên cùng</Label>
              <ToggleGroup
                size="sm"
                spacing={0}
                variant="outline"
                type="single"
                value={values.navbar_style}
                onValueChange={toggle<NavbarStyle>((v) => setPreference("navbar_style", v))}
              >
                <ToggleGroupItem value="sticky">Dính</ToggleGroupItem>
                <ToggleGroupItem value="scroll">Cuộn theo</ToggleGroupItem>
              </ToggleGroup>
            </div>

            <div className="space-y-1">
              <Label className="font-medium text-xs">Kiểu sidebar</Label>
              <ToggleGroup
                size="sm"
                spacing={0}
                variant="outline"
                type="single"
                value={values.sidebar_variant}
                onValueChange={toggle<SidebarVariant>((v) => setPreference("sidebar_variant", v))}
              >
                <ToggleGroupItem value="inset">Inset</ToggleGroupItem>
                <ToggleGroupItem value="sidebar">Sidebar</ToggleGroupItem>
                <ToggleGroupItem value="floating">Nổi</ToggleGroupItem>
              </ToggleGroup>
            </div>

            <div className="space-y-1">
              <Label className="font-medium text-xs">Khi thu gọn sidebar</Label>
              <ToggleGroup
                size="sm"
                spacing={0}
                variant="outline"
                type="single"
                value={values.sidebar_collapsible}
                onValueChange={toggle<SidebarCollapsible>((v) => setPreference("sidebar_collapsible", v))}
              >
                <ToggleGroupItem value="icon">Chỉ icon</ToggleGroupItem>
                <ToggleGroupItem value="offcanvas">Ẩn hẳn</ToggleGroupItem>
              </ToggleGroup>
            </div>

            <Button type="button" size="sm" variant="outline" className="w-full text-xs" onClick={resetPreferences}>
              Khôi phục mặc định
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
