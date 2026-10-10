"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { ExternalLink, LogOut } from "lucide-react";
import { useShallow } from "zustand/react/shallow";

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
import { clearToken } from "@/lib/hub/token";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";

import { sidebarItems } from "./sidebar-items";

export function AppSidebar(props: React.ComponentProps<typeof Sidebar>) {
  const path = usePathname();
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

  // Tải lại toàn trang tới /auth/login: cache query + socket mất sạch theo, và không còn query nào
  // đang mount để bắn request 401 → tránh toast "phiên hết hạn" sau một lần đăng xuất chủ động.
  const logout = () => {
    clearToken();
    window.location.replace("/auth/login");
  };

  return (
    <Sidebar {...props} variant={variant} collapsible={collapsible}>
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
      </SidebarHeader>
      <SidebarContent>
        {sidebarItems.map((group) => (
          <SidebarGroup key={group.id}>
            <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {group.items.map((item) => (
                  <SidebarMenuItem key={item.id}>
                    <SidebarMenuButton asChild tooltip={item.title} isActive={isActive(item.url)}>
                      <Link href={item.url}>
                        <item.icon />
                        <span>{item.title}</span>
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
            <SidebarMenuButton asChild tooltip="Mở Shop">
              <a href="/shop" target="_blank" rel="noreferrer">
                <ExternalLink />
                <span>Mở Shop</span>
              </a>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton tooltip="Đăng xuất" onClick={logout}>
              <LogOut />
              <span>Đăng xuất</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}
