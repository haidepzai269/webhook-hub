import type { ReactNode } from "react";

import { cookies } from "next/headers";

import { cn } from "cn";
import { Menu } from "lucide-react";

import { AccountMenu } from "@/components/admin/account-menu";
import { AppSidebar } from "@/components/admin/app-sidebar";
import { AuthGuard } from "@/components/admin/auth-guard";
import { DisplaySettings } from "@/components/admin/display-settings";
import { RealtimeBadge } from "@/components/admin/realtime-badge";
import { AlertBanner } from "@/components/alerts/alert-banner";
import { AlertBell } from "@/components/alerts/alert-bell";
import { AlertNotifier } from "@/components/alerts/alert-notifier";
import { StorageBanner } from "@/components/storage/storage-banner";
import { Separator } from "@/components/ui/separator";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { createT } from "@/lib/i18n/dictionary";
import { LocaleProvider } from "@/lib/i18n/use-t";
import { getPreference } from "@/server/server-actions";

export default async function DashboardLayout({ children }: Readonly<{ children: ReactNode }>) {
  const cookieStore = await cookies();
  const defaultOpen = cookieStore.get("sidebar_state")?.value !== "false";
  const [variant, collapsible, language] = await Promise.all([
    getPreference("sidebar_variant"),
    getPreference("sidebar_collapsible"),
    getPreference("language"),
  ]);
  const t = createT(language);

  return (
    <LocaleProvider locale={language}>
      <AuthGuard>
        <SidebarProvider
          defaultOpen={defaultOpen}
          style={{ "--sidebar-width": "calc(var(--spacing) * 64)" } as React.CSSProperties}
        >
          <AppSidebar variant={variant} collapsible={collapsible} />
          <SidebarInset
            className={cn(
              "[html[data-content-layout=centered]_&>*]:mx-auto",
              "[html[data-content-layout=centered]_&>*]:w-full",
              "[html[data-content-layout=centered]_&>*]:max-w-screen-2xl",
              "peer-data-[variant=inset]:border",
              "min-w-0 overflow-x-clip",
            )}
          >
            <header
              className={cn(
                "flex h-12 shrink-0 items-center gap-2 border-b",
                "[html[data-navbar-style=sticky]_&]:sticky [html[data-navbar-style=sticky]_&]:top-0 [html[data-navbar-style=sticky]_&]:z-50 [html[data-navbar-style=sticky]_&]:overflow-hidden [html[data-navbar-style=sticky]_&]:rounded-t-[inherit] [html[data-navbar-style=sticky]_&]:bg-background/50 [html[data-navbar-style=sticky]_&]:backdrop-blur-md",
              )}
            >
              <div className="flex w-full items-center justify-between gap-2 px-4 lg:px-6">
                <div className="flex min-w-0 items-center gap-1 lg:gap-2">
                  {/* Mobile (ADR-261): ☰ mở ngăn kéo điều hướng, vùng chạm 40px; từ md là nút thu gọn sidebar như cũ. */}
                  <SidebarTrigger className="-ml-2 size-10 md:hidden" icon={<Menu className="size-5" />} label={t("mobile.nav.open")} />
                  <SidebarTrigger className="-ml-1 max-md:hidden" label={t("admin.sidebar.toggle")} />
                  <Separator
                    orientation="vertical"
                    className="mx-2 data-[orientation=vertical]:h-4 data-[orientation=vertical]:self-center max-sm:hidden"
                  />
                  <span className="truncate font-medium text-sm max-sm:hidden">Webhook Hub</span>
                </div>
                <div className="flex shrink-0 items-center gap-1.5 sm:gap-2">
                  <RealtimeBadge />
                  {/* CB4/QT6: chuông cảnh báo — operator + owner (component tự ẩn với người khác); "Xem tất cả" -> /alerts. */}
                  <AlertBell />
                  {/* ADR-266: Ngôn ngữ + Sáng/Tối + (từ md) Tuỳ chỉnh bố cục gộp trong menu bánh răng — hiện cả trên mobile. */}
                  <DisplaySettings withLayout />
                  {/* ADR-237: menu tài khoản — Tất cả dự án, Cảnh báo, Cài đặt (tầng tài khoản, không trong sidebar dự án). */}
                  <AccountMenu />
                </div>
              </div>
            </header>
            <div className="min-h-0 min-w-0 flex-1 overflow-x-clip p-4 md:p-6">
              {/* CB4: banner critical dính đầu vùng nội dung, sống qua chuyển trang; notifier quyết định banner/toast. */}
              <AlertNotifier />
              <AlertBanner />
              {/* QT7: banner dung lượng theo nấc của dự án đang chọn (ước tính; LOCKED có 2 nút, không có "Nâng cấp"). */}
              <StorageBanner />
              {children}
            </div>
          </SidebarInset>
        </SidebarProvider>
      </AuthGuard>
    </LocaleProvider>
  );
}
