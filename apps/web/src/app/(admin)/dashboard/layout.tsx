import type { ReactNode } from "react";

import { cookies } from "next/headers";

import { cn } from "cn";

import { AppSidebar } from "@/components/admin/app-sidebar";
import { AuthGuard } from "@/components/admin/auth-guard";
import { LanguageSwitcher } from "@/components/admin/language-switcher";
import { LayoutControls } from "@/components/admin/layout-controls";
import { RealtimeBadge } from "@/components/admin/realtime-badge";
import { ThemeSwitcher } from "@/components/admin/theme-switcher";
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
                <div className="flex items-center gap-1 lg:gap-2">
                  <SidebarTrigger className="-ml-1" label={t("admin.sidebar.toggle")} />
                  <Separator
                    orientation="vertical"
                    className="mx-2 data-[orientation=vertical]:h-4 data-[orientation=vertical]:self-center"
                  />
                  <span className="truncate font-medium text-sm">Webhook Hub</span>
                </div>
                <div className="flex items-center gap-2">
                  <RealtimeBadge />
                  <LayoutControls />
                  <LanguageSwitcher />
                  <ThemeSwitcher />
                </div>
              </div>
            </header>
            <div className="min-h-0 min-w-0 flex-1 overflow-x-hidden p-4 md:p-6">{children}</div>
          </SidebarInset>
        </SidebarProvider>
      </AuthGuard>
    </LocaleProvider>
  );
}
