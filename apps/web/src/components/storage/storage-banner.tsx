"use client";

import { useEffect, useState } from "react";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { HardDrive, X } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useFlowProjectStore } from "@/lib/hub/flow-project";
import { useCanReadStorage, useStorage } from "@/lib/hub/storage-queries";
import { useT } from "@/lib/i18n/use-t";
import { storageBannerFor } from "@/lib/storage/storage-logic";

/**
 * QT7 (SPEC-han-muc-dung-luong §3, §9 + E1/E5): banner dung lượng của DỰ ÁN ĐANG CHỌN, dính đầu vùng nội dung (cùng chỗ với
 * banner cảnh báo CB). 70% vàng (ẩn được trong phiên), 85% vàng + toast một lần mỗi phiên, 95% đỏ không tắt được, LOCKED /
 * HARD_LOCKED đỏ với HAI nút "Dọn theo gợi ý" + "Liên hệ người vận hành". Cờ khoá tắt -> câu nói thật. Không có "Nâng cấp".
 * Thành viên không có `storage:read` (viewer) -> không gọi API, không hiện gì (server vẫn 403 nếu có gọi).
 */
const SESSION_KEY = (projectId: string, level: string) => `hub:storage-banner:${projectId}:${level}`;
const session = {
  get(k: string): string | null {
    try {
      return typeof window === "undefined" ? null : window.sessionStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k: string, v: string) {
    try {
      window.sessionStorage.setItem(k, v);
    } catch {
      /* bộ nhớ phiên bị chặn: banner hiện lại, không sao */
    }
  },
};

export function StorageBanner() {
  const t = useT();
  const pathname = usePathname();
  const projectId = useFlowProjectStore((s) => s.projectId);
  const canRead = useCanReadStorage(projectId); // L9: viewer không gọi GET storage (không 403 thừa)
  const { data } = useStorage(canRead ? projectId : null);
  const [hidden, setHidden] = useState(false);
  const banner = data ? storageBannerFor(data.level, data.lockEnabled) : null;
  const key = projectId && data ? SESSION_KEY(projectId, data.level) : null;

  useEffect(() => {
    setHidden(!!key && session.get(`${key}:hidden`) === "1");
  }, [key]);

  // §3: 85% -> toast mỗi lần mở console (một lần mỗi phiên trình duyệt cho mỗi dự án).
  useEffect(() => {
    if (!banner?.toastOnOpen || !key || !data) return;
    if (session.get(`${key}:toast`) === "1") return;
    session.set(`${key}:toast`, "1");
    toast.warning(t(banner.messageKey, { pct: Math.round(data.usedPct) }));
  }, [banner, key, data, t]);

  if (!banner || !data || (hidden && banner.dismissible)) return null;
  const onStoragePage = pathname?.startsWith("/dashboard/storage");
  const color = banner.tone === "danger" ? "danger" : "warning";
  return (
    <div
      role={banner.tone === "danger" ? "alert" : "status"}
      className="mb-4 flex flex-col gap-2 rounded-md border-l-4 px-3 py-2 text-sm sm:flex-row sm:items-center sm:justify-between"
      style={{ backgroundColor: `var(--${color}-subtle)`, color: `var(--${color}-fg)`, borderLeftColor: `var(--${color})` }}
    >
      <div className="flex items-start gap-2">
        <HardDrive className="mt-0.5 size-4 shrink-0" aria-hidden />
        <span>{t(banner.messageKey, { pct: Math.round(data.usedPct) })}</span>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        {banner.actions.includes("open") && !onStoragePage && (
          <Button asChild size="sm" variant="outline">
            <Link href="/dashboard/storage">{t("page.storage.banner.open")}</Link>
          </Button>
        )}
        {banner.actions.includes("clean") && (
          <Button asChild size="sm">
            <Link href="/dashboard/storage#suggestions">{t("page.storage.banner.clean")}</Link>
          </Button>
        )}
        {banner.actions.includes("contact") && (
          <Popover>
            <PopoverTrigger asChild>
              <Button size="sm" variant="outline">
                {t("page.storage.banner.contact")}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-72 text-sm">{t("page.storage.banner.contact-hint")}</PopoverContent>
          </Popover>
        )}
        {banner.dismissible && (
          <Button
            size="icon"
            variant="ghost"
            className="size-7"
            aria-label={t("page.storage.banner.dismiss")}
            onClick={() => {
              if (key) session.set(`${key}:hidden`, "1");
              setHidden(true);
            }}
          >
            <X className="size-4" aria-hidden />
          </Button>
        )}
      </div>
    </div>
  );
}
