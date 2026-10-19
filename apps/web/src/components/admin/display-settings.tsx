"use client";

import { useRef, useState } from "react";

import { Settings } from "lucide-react";
import { useShallow } from "zustand/react/shallow";

import { IconButton } from "@/components/admin/icon-button";
import { LayoutControlsPanel } from "@/components/admin/layout-controls";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { useIsMobile } from "@/hooks/use-mobile";
import { LOCALES, type Locale } from "@/lib/i18n/locales";
import { useChangeLanguage } from "@/lib/i18n/use-change-language";
import { useLocale, useT } from "@/lib/i18n/use-t";
import type { ThemeMode } from "@/lib/preferences/theme";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";

const THEME_MODES = ["light", "dark", "system"] as const satisfies readonly ThemeMode[];

/**
 * Nút bánh răng "Cài đặt hiển thị" (ADR-266): gộp Ngôn ngữ (vi/en) + Giao diện (sáng/tối/theo hệ thống) thành hai nhóm
 * radio của một DropdownMenu. `withLayout` (thanh trên của dashboard dự án) thêm mục "Tuỳ chỉnh bố cục…" mở bảng
 * `LayoutControlsPanel` neo vào chính nút bánh răng; mục này ẩn dưới `md` (không có sidebar/bố cục để chỉnh) —
 * bỏ khỏi cây hẳn chứ không ẩn bằng CSS, để phím mũi tên không rơi vào mục vô hình.
 * Cơ chế lưu giữ nguyên: ngôn ngữ qua `useChangeLanguage`, theme qua `setPreference("theme_mode")`.
 */
export function DisplaySettings({ withLayout = false }: { withLayout?: boolean }) {
  const t = useT();
  const locale = useLocale();
  const changeLanguage = useChangeLanguage();
  const mobile = useIsMobile();
  const { themeMode, setPreference } = usePreferencesStore(
    useShallow((state) => ({ themeMode: state.values.theme_mode, setPreference: state.setPreference })),
  );
  const [layoutOpen, setLayoutOpen] = useState(false);
  // Mục "Tuỳ chỉnh bố cục…" vừa chọn: menu đóng KHÔNG được trả focus về nút (giành focus của bảng đang mở).
  const openingLayout = useRef(false);
  const showLayout = withLayout && !mobile;

  const menu = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <IconButton size="icon" variant="outline" icon={<Settings />} label={t("header.settings")} />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        collisionPadding={8}
        className="w-52"
        onCloseAutoFocus={(e) => {
          // biome-ignore lint/suspicious/noUnnecessaryConditions: ref đổi trong onSelect — biome không thấy
          if (openingLayout.current) {
            e.preventDefault();
            openingLayout.current = false;
          }
        }}
      >
        <DropdownMenuGroup>
          <DropdownMenuLabel className="font-normal text-muted-foreground text-xs">
            {t("header.settings.language")}
          </DropdownMenuLabel>
          <DropdownMenuRadioGroup value={locale} onValueChange={(v) => changeLanguage(v as Locale)}>
            {LOCALES.map((l) => (
              <DropdownMenuRadioItem key={l} value={l} className="max-md:min-h-10">
                {t(`common.language.${l}`)}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuLabel className="font-normal text-muted-foreground text-xs">
            {t("header.settings.theme")}
          </DropdownMenuLabel>
          <DropdownMenuRadioGroup value={themeMode} onValueChange={(v) => setPreference("theme_mode", v as ThemeMode)}>
            {THEME_MODES.map((m) => (
              <DropdownMenuRadioItem key={m} value={m} className="max-md:min-h-10">
                {t(`common.theme.${m}`)}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
        {showLayout && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={() => {
                openingLayout.current = true;
                setLayoutOpen(true);
              }}
            >
              {t("header.settings.layout")}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );

  if (!withLayout) return menu;
  return (
    <Popover open={layoutOpen && showLayout} onOpenChange={setLayoutOpen}>
      <PopoverAnchor asChild>
        <div className="inline-flex">{menu}</div>
      </PopoverAnchor>
      <PopoverContent align="end" collisionPadding={8}>
        <LayoutControlsPanel />
      </PopoverContent>
    </Popover>
  );
}
