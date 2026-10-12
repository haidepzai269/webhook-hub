import type { ReactNode } from "react";

import type { Metadata } from "next";

import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { fontVars } from "@/lib/fonts/registry";
import { QueryProvider } from "@/lib/hub/query-provider";
import { getT } from "@/lib/i18n/server";
import { PREFERENCE_DEFAULTS } from "@/lib/preferences/preferences-config";
import { ThemeBootScript } from "@/scripts/theme-boot";
import { PreferencesStoreProvider } from "@/stores/preferences/preferences-provider";

import "./globals.css";

// Tiêu đề/mô tả theo ngôn ngữ đang chọn (cookie `language`); bản gốc vi vẫn ở APP_CONFIG.meta.
export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("admin.meta.title"), description: t("admin.meta.description") };
}

// ADR-025: root layout của admin (Tailwind v4 + shadcn). Storefront có root layout riêng ở (shop).
export default function AdminRootLayout({ children }: Readonly<{ children: ReactNode }>) {
  const {
    theme_mode,
    theme_preset,
    content_layout,
    navbar_style,
    sidebar_variant,
    sidebar_collapsible,
    font,
    language,
  } = PREFERENCE_DEFAULTS;
  return (
    <html
      lang={language}
      data-theme-mode={theme_mode}
      data-theme-preset={theme_preset}
      data-content-layout={content_layout}
      data-navbar-style={navbar_style}
      data-sidebar-variant={sidebar_variant}
      data-sidebar-collapsible={sidebar_collapsible}
      data-font={font}
      data-language={language}
      suppressHydrationWarning
    >
      <head>
        {/* Áp preference (theme, layout) trước khi hydrate để không nháy. */}
        <ThemeBootScript />
      </head>
      <body className={`${fontVars} min-h-screen antialiased`}>
        <TooltipProvider>
          <PreferencesStoreProvider initialValues={PREFERENCE_DEFAULTS}>
            <QueryProvider>{children}</QueryProvider>
            {/* Toast thao tác thường (góc phải), tối đa 3 cùng lúc. Đẩy xuống dưới header 48px
                (h-12) + 12px — không thì toast che badge Thời gian thực, nút cài đặt, chuông, ngôn ngữ, giao diện. */}
            <Toaster
              richColors
              position="top-right"
              visibleToasts={3}
              offset={{ top: 60, right: 16 }}
              mobileOffset={{ top: 56, right: 12, left: 12 }}
            />
            {/* Toast CẢNH BÁO (CB4, toasterId "alerts" = ALERT_TOASTER_ID ở components/alerts/alert-toast.tsx): giữa phía
                trên, dưới header; sonner trượt từ trên xuống khi vào, trượt lên + mờ khi ra (giảm chuyển động: chỉ mờ —
                styles/alerts.css). `expand`: nhiều toast xếp dọc, không chồng lên nhau. Màn hẹp: gutter 16px hai bên. */}
            <Toaster
              id="alerts"
              className="toaster group alert-toaster"
              position="top-center"
              expand
              visibleToasts={3}
              offset={{ top: 60 }}
              mobileOffset={{ top: 56, right: 16, left: 16 }}
            />
          </PreferencesStoreProvider>
        </TooltipProvider>
      </body>
    </html>
  );
}
