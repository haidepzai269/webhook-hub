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
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { APP_CONFIG } from "@/config/app-config";
import { useIsMobile } from "@/hooks/use-mobile";
import { type BadgeTab, formatBadge } from "@/lib/hub/badges-logic";
import { useBadgeStore, useSidebarBadges } from "@/lib/hub/badges-store";
import { logout as serverLogout } from "@/lib/hub/client";
import { formatRelative } from "@/lib/hub/format";
import { useLocale, useT } from "@/lib/i18n/use-t";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";

import { type NavItem, sidebarItems } from "./sidebar-items";

/**
 * Một mục sidebar. Mục có `badgeKey` (events/deliveries/dlq — ADR-269) hiện số "chưa xem" (>9 -> "9+", 0 -> ẩn) và, khi có
 * bản ghi mới, tooltip nội dung bản ghi mới nhất — CẢ khi sidebar mở lẫn thu gọn (`hidden: false` ghi đè mặc định chỉ-khi-thu-gọn).
 * `SidebarMenuBadge` có pointer-events-none nên tooltip gắn vào nút.
 */
function SidebarNavItem({ item, active }: { item: NavItem; active: boolean }) {
  const t = useT();
  const locale = useLocale();
  const mobile = useIsMobile();
  const tab: BadgeTab | undefined = item.badgeKey;
  const count = useBadgeStore((s) => (tab ? s.badges.counts[tab] : 0));
  const latest = useBadgeStore((s) => (tab ? s.badges.latest[tab] : null));
  const label = tab ? formatBadge(count) : null;

  let tooltip: React.ComponentProps<typeof SidebarMenuButton>["tooltip"] = t(item.titleKey);
  // Mobile (ngăn kéo): không bật tooltip — giữ mặc định của SidebarMenuButton (ẩn khi isMobile).
  if (tab && label && latest && !mobile) {
    const age = formatRelative(latest.at, Date.now(), locale);
    let line: string;
    if ("type" in latest) line = `${latest.type} · ${latest.source} · ${age}`;
    else if ("status" in latest) line = `${latest.destination} · ${latest.status} · ${age}`;
    else line = `${t("nav.badge.dlq", { destination: latest.destination, attemptNo: String(latest.attemptNo) })} · ${age}`;
    tooltip = {
      hidden: false,
      children: (
        <div className="flex max-w-64 flex-col gap-0.5">
          <span className="font-medium">
            {t(item.titleKey)} · {t("nav.badge.unseen", { count: label })}
          </span>
          <span className="break-words opacity-90">{line}</span>
        </div>
      ),
    };
  }

  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild tooltip={tooltip} isActive={active}>
        <Link
          href={item.url}
          aria-label={label ? `${t(item.titleKey)}, ${t("nav.badge.unseen", { count: label })}` : undefined}
        >
          <item.icon />
          <span>{t(item.titleKey)}</span>
        </Link>
      </SidebarMenuButton>
      {label && <SidebarMenuBadge aria-hidden>{label}</SidebarMenuBadge>}
      {/* Sidebar thu gọn (chỉ icon) ẩn số -> chấm nhỏ trên icon báo có mục chưa xem. */}
      {label && (
        <span
          aria-hidden
          className="pointer-events-none absolute top-1 right-1 hidden size-2 rounded-full bg-primary ring-2 ring-sidebar group-data-[collapsible=icon]:block"
        />
      )}
    </SidebarMenuItem>
  );
}

export function AppSidebar(props: React.ComponentProps<typeof Sidebar>) {
  const path = usePathname();
  const t = useT();
  useSidebarBadges(); // ADR-269: nạp + cộng dồn badge "chưa xem"
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
                {/* ADR-237: mọi mục ở đây thuộc dự án đang chọn — mục tầng tài khoản (Cảnh báo, Cài đặt) ở menu tài khoản. */}
                {group.items.map((item) => (
                  <SidebarNavItem key={item.id} item={item} active={isActive(item.url)} />
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
