"use client";

import { type ReactNode, useEffect, useState } from "react";

import { MonitorSmartphone } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useT } from "@/lib/i18n/use-t";

import { decideGuard, guardStorageKey } from "./screen-guard-logic";
import { StatusScreen } from "./status-screen";

/** Bề rộng viewport (px CSS) — null cho tới khi đo xong. Cập nhật khi kéo cửa sổ và khi xoay (resize + orientationchange). */
function useViewportWidth(): number | null {
  const [width, setWidth] = useState<number | null>(null);
  useEffect(() => {
    const read = () => setWidth(window.innerWidth);
    read();
    window.addEventListener("resize", read);
    window.addEventListener("orientationchange", read);
    return () => {
      window.removeEventListener("resize", read);
      window.removeEventListener("orientationchange", read);
    };
  }, []);
  return width;
}

/** Giá trị đổi chậm lại `ms` — dòng aria-live không đọc liên tục khi đang kéo cửa sổ. */
function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
}

/**
 * Trang tầng C (cấu hình nặng: canvas, form dài) không đủ chỗ trên màn hẹp — thay vì vỡ layout, hiện màn xin lỗi (ADR-261).
 * `minWidth` do từng trang tự khai theo layout thật. Chưa đo xong → khung chờ (không vẽ trang rồi mới đổi).
 * "Vẫn tiếp tục" nhớ theo trang trong sessionStorage (tablet / người cố ý).
 */
export function ScreenGuard({ minWidth, children }: { minWidth: number; children: ReactNode }) {
  const t = useT();
  const path = usePathname();
  const width = useViewportWidth();
  const shownWidth = useDebounced(width, 400);
  // null = chưa đọc sessionStorage: coi như đang đo, để không chớp màn xin lỗi rồi mới vào trang khi đã "Vẫn tiếp tục".
  const [override, setOverride] = useState<boolean | null>(null);
  useEffect(() => {
    try {
      setOverride(sessionStorage.getItem(guardStorageKey(path)) === "1");
    } catch {
      setOverride(false);
    }
  }, [path]);

  const state = decideGuard(override === null ? null : width, minWidth, override === true);
  if (state === "measuring") return <Skeleton className="h-64 w-full rounded-xl" aria-hidden />;
  if (state === "ok") return <>{children}</>;

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      toast.success(t("mobile.guard.copied"));
    } catch {
      toast.error(t("mobile.guard.copy-failed"));
    }
  };
  const proceed = () => {
    try {
      sessionStorage.setItem(guardStorageKey(path), "1");
    } catch {}
    setOverride(true);
  };

  return (
    <StatusScreen
      icon={MonitorSmartphone}
      className="min-h-[calc(100dvh-8rem)]"
      title={t("mobile.guard.title")}
      description={
        <>
          <p>{t("mobile.guard.desc", { min: minWidth })}</p>
          <p className="mt-2">{t("mobile.guard.hint")}</p>
          <p className="mt-3 font-mono text-foreground text-xs tabular-nums" aria-live="polite" role="status">
            {t("mobile.guard.width", { width: shownWidth ?? width ?? 0, min: minWidth })}
          </p>
        </>
      }
    >
      <Button asChild className="min-h-10">
        <Link href="/dashboard">{t("mobile.guard.home")}</Link>
      </Button>
      <Button type="button" variant="outline" className="min-h-10" onClick={() => void copyLink()}>
        {t("mobile.guard.copy")}
      </Button>
      <button type="button" onClick={proceed} className="min-h-10 cursor-pointer px-2 text-muted-foreground text-xs underline underline-offset-4 hover:text-foreground">
        {t("mobile.guard.continue")}
      </button>
    </StatusScreen>
  );
}
