"use client";

import type { ReactNode } from "react";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { BellRing, FolderKanban, LogOut, Settings, Settings2 } from "lucide-react";

import { LanguageSwitcher } from "@/components/admin/language-switcher";
import { ThemeSwitcher } from "@/components/admin/theme-switcher";
import { AlertBell } from "@/components/alerts/alert-bell";
import { initials } from "@/components/flow/brand-fallback";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { APP_CONFIG } from "@/config/app-config";
import { ACCOUNT_ROUTES, type AccountMenuId, accountMenuItems } from "@/lib/hub/account-routes";
import { logout as serverLogout } from "@/lib/hub/client";
import { useMeStore } from "@/lib/hub/me-store";
import type { MessageKey } from "@/lib/i18n/dictionary";
import { useT } from "@/lib/i18n/use-t";

const ACCOUNT_ICON: Record<AccountMenuId, typeof BellRing> = { alerts: BellRing, settings: Settings };

/**
 * Menu tài khoản (avatar) — tầng TÀI KHOẢN (ADR-234/237), dùng chung ở thanh trên của dashboard dự án lẫn `/projects`,
 * `/alerts`, `/settings`. Nhóm "Xuyên dự án" (Cảnh báo, Cài đặt) hiện theo vai trò — `accountMenuItems` (hàm thuần).
 */
export function AccountMenu({ demo = false }: { demo?: boolean }) {
  const t = useT();
  const me = useMeStore((s) => s.me);
  const name = me?.user.name || (demo ? "Admin (demo)" : "");
  const email = me?.user.email ?? (demo ? "admin@demo.local" : "");
  // Demo (không /auth/me): hiện như người vận hành để xem đủ bố cục; link thật vẫn qua AuthGuard.
  const items = accountMenuItems(me ?? (demo ? { user: { isOperator: true } } : null));
  const logout = () => {
    void serverLogout().finally(() => window.location.replace("/login"));
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="rounded-full"
          aria-label={t("page.projects.home.account")}
          title={email}
        >
          {/* ADR-238: chưa có /auth/me (AuthGuard đang chờ) -> khung chờ tròn cùng cỡ, không hiện "?". */}
          {me || demo ? (
            <span className="flex size-8 items-center justify-center rounded-full bg-primary font-semibold text-primary-foreground text-xs">
              {initials(name || email || "?")}
            </span>
          ) : (
            <Skeleton className="size-8 rounded-full" />
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuLabel className="flex flex-col gap-0.5">
          <span className="truncate font-medium text-foreground text-sm">{name}</span>
          <span className="truncate font-normal text-muted-foreground text-xs">{email}</span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem className="cursor-pointer" asChild>
          <Link href={demo ? `${ACCOUNT_ROUTES.projects}?demo=1` : ACCOUNT_ROUTES.projects}>
            <FolderKanban />
            {t("page.projects.home.all-projects")}
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem className="cursor-pointer" asChild>
          <Link href="/dashboard/projects">
            <Settings2 />
            {t("page.projects.home.manage")}
          </Link>
        </DropdownMenuItem>
        {items.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuLabel className="font-normal text-muted-foreground text-xs">
                {t("nav.account.cross-project")}
              </DropdownMenuLabel>
              {items.map((i) => {
                const Icon = ACCOUNT_ICON[i.id];
                return (
                  <DropdownMenuItem key={i.id} className="cursor-pointer" asChild>
                    <Link href={i.url}>
                      <Icon />
                      {t(i.titleKey)}
                    </Link>
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuGroup>
          </>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem className="cursor-pointer" onSelect={logout}>
          <LogOut />
          {t("nav.footer.logout")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Tên mục tầng tài khoản trên breadcrumb của thanh trên, theo đường đang mở. */
const SECTION_KEY: Record<string, MessageKey> = {
  [ACCOUNT_ROUTES.projects]: "page.projects.home.title",
  [ACCOUNT_ROUTES.alerts]: "nav.item.alerts",
  [ACCOUNT_ROUTES.settings]: "nav.item.settings",
};

/** Thanh trên tầng TÀI KHOẢN — không sidebar dự án (phân cấp: Hub ⊃ Tài khoản ⊃ Dự án, ADR-234/237). */
export function AccountTopBar({ demo = false }: { demo?: boolean }) {
  const t = useT();
  const path = usePathname();
  const sectionKey = SECTION_KEY[path] ?? "page.projects.home.title";
  return (
    <header className="sticky top-0 z-40 border-b bg-background/80 backdrop-blur-md">
      <div className="mx-auto flex h-14 w-full max-w-6xl items-center justify-between gap-2 px-4 md:px-6">
        <Link
          href={demo ? `${ACCOUNT_ROUTES.projects}?demo=1` : ACCOUNT_ROUTES.projects}
          className="flex min-w-0 cursor-pointer items-center gap-2"
        >
          <Image src="/brand/webhook-hub-mark.png" alt="" width={24} height={24} className="size-6 shrink-0" />
          <span className="truncate font-semibold">{APP_CONFIG.name}</span>
          <span className="hidden text-muted-foreground sm:inline">/</span>
          <span className="hidden truncate text-muted-foreground text-sm sm:inline">{t(sectionKey)}</span>
        </Link>
        <div className="flex items-center gap-2">
          {/* Chuông tự ẩn với người không xem được cảnh báo (và ở demo — chưa có /auth/me). */}
          <AlertBell />
          <LanguageSwitcher />
          <ThemeSwitcher />
          <AccountMenu demo={demo} />
        </div>
      </div>
    </header>
  );
}

/** Khung trang tầng tài khoản: thanh trên + vùng nội dung giữa (cùng bề rộng với `/projects`). */
export function AccountShell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-background">
      <AccountTopBar />
      {/* Mọi nút bấm được trong trang (lọc, xoá lọc, ô chọn của Cài đặt) có con trỏ tay; nút disabled giữ con trỏ mặc định. */}
      <main className="mx-auto w-full max-w-6xl px-4 py-8 md:px-6 [&_button:not(:disabled)]:cursor-pointer">
        {children}
      </main>
    </div>
  );
}
