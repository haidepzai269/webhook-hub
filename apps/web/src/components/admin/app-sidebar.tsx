"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { ExternalLink, LogOut } from "lucide-react";
import { useShallow } from "zustand/react/shallow";

import { SidebarProjectPicker } from "@/components/flow/project-picker";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { APP_CONFIG } from "@/config/app-config";
import { logout as serverLogout } from "@/lib/hub/client";
import { useIsOperator } from "@/lib/hub/me-store";
import { useT } from "@/lib/i18n/use-t";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";

import { sidebarItems } from "./sidebar-items";

export function AppSidebar(props: React.ComponentProps<typeof Sidebar>) {
  const path = usePathname();
  const t = useT();
  const operator = useIsOperator();
  const { sidebarVariant, sidebarCollapsible, isSynced } = usePreferencesStore(
    useShallow((s) => ({
      sidebarVariant: s.values.sidebar_variant,
      sidebarCollapsible: s.values.sidebar_collapsible,
      isSynced: s.isSynced,
    })),
  );

  const variant = isSynced ? sidebarVariant : props.variant;
  const collapsible = isSynced ? sidebarCollapsible : props.collapsible;

  // "/dashboard" chỉ active đúng trang đó; các mục con active theo prefix.
  const isActive = (url: string) => (url === "/dashboard" ? path === url : path.startsWith(url));

  // Thu hồi phiên ở server (SPEC-auth §5.3) rồi tải lại toàn trang tới /login: cache query + socket mất sạch theo,
  // và không còn query nào đang mount để bắn request 401 → tránh toast "phiên hết hạn" sau khi chủ động đăng xuất.
  const logout = () => {
    void serverLogout().finally(() => window.location.replace("/login"));
  };

  return (
    <Sidebar
      {...props}
      variant={variant}
      collapsible={collapsible}
      mobileTitle={t("admin.sidebar.mobile-title")}
      mobileDescription={t("admin.sidebar.mobile-description")}
    >
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton asChild>
              <Link href="/dashboard">
                <Image src="/brand/webhook-hub-mark.png" alt="" width={24} height={24} className="size-6 shrink-0" />
                <span className="font-semibold text-base">{APP_CONFIG.name}</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        <SidebarProjectPicker />
      </SidebarHeader>
      <SidebarContent>
        {sidebarItems.map((group) => (
          <SidebarGroup key={group.id}>
            <SidebarGroupLabel>{t(group.labelKey)}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {group.items
                  .filter((item) => operator || !item.operatorOnly)
                  .map((item) => (
                  <SidebarMenuItem key={item.id}>
                    <SidebarMenuButton asChild tooltip={t(item.titleKey)} isActive={isActive(item.url)}>
                      <Link href={item.url}>
                        <item.icon />
                        <span>{t(item.titleKey)}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton asChild tooltip={t("nav.footer.open-shop")}>
              <a href="/shop" target="_blank" rel="noreferrer">
                <ExternalLink />
                <span>{t("nav.footer.open-shop")}</span>
              </a>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton tooltip={t("nav.footer.logout")} onClick={logout}>
              <LogOut />
              <span>{t("nav.footer.logout")}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}
