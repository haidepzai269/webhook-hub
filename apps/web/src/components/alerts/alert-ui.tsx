"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { useRouter } from "next/navigation";

import { CircleCheck, Info, OctagonAlert, TriangleAlert } from "lucide-react";
import { create } from "zustand";

import { cn } from "cn";

import { buildAlertText } from "@/lib/alerts/message";
import { type BannerState, createFeedMemory, emptyBanner, type FeedMemory } from "@/lib/alerts/notify-logic";
import type { AlertSeverity, AlertView } from "@/lib/alerts/types";
import { useProjectStore } from "@/lib/hub/project-store";
import { useLocale, useT } from "@/lib/i18n/use-t";

/**
 * CB4: mảnh dùng chung của chuông / banner / toast / trang Cảnh báo — màu theo mức (token ở styles/alerts.css), chip
 * project, dựng câu theo ngôn ngữ, mở đúng trang của cảnh báo (đổi project trước nếu cần), store giao diện.
 */

export const SEVERITY_COLOR: Record<AlertSeverity, string> = {
  critical: "var(--danger)",
  warning: "var(--warning)",
  info: "var(--info)",
};

export function SeverityDot({ severity, className }: { severity: AlertSeverity; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn("inline-block size-2 shrink-0 rounded-full", className)}
      style={{ backgroundColor: SEVERITY_COLOR[severity] }}
    />
  );
}

const SEVERITY_ICON = { critical: OctagonAlert, warning: TriangleAlert, info: Info } as const;

export function SeverityIcon({ severity, resolved, className }: { severity: AlertSeverity; resolved?: boolean; className?: string }) {
  const Icon = resolved ? CircleCheck : SEVERITY_ICON[severity];
  return <Icon aria-hidden className={cn("size-4 shrink-0", className)} style={{ color: resolved ? "var(--ok)" : SEVERITY_COLOR[severity] }} />;
}

/** Chip tên project — dùng cùng một hình ở mọi nơi để mắt nhận ra "cảnh báo này của project nào". */
export function ProjectChip({ name, className }: { name: string; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex max-w-40 shrink-0 items-center truncate rounded-sm border border-border bg-muted px-1.5 py-px font-medium text-[11px] text-foreground/80 leading-4",
        className,
      )}
      title={name}
    >
      {name}
    </span>
  );
}

/** Dựng câu cho cảnh báo theo ngôn ngữ đang chọn; `now` làm tươi mỗi phút để "im lặng 3 giờ" không đứng yên. */
export function useAlertText() {
  const t = useT();
  const locale = useLocale();
  const now = useMinuteClock();
  return useCallback((a: AlertView, subjectName?: string | null) => buildAlertText(a, t, { locale, now, subjectName }), [t, locale, now]);
}

export function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);
  return now;
}

/** Bấm vào cảnh báo: đổi sang project của nó (nếu đang ở project khác) rồi mở trang có bộ lọc. */
export function useOpenAlertTarget() {
  const router = useRouter();
  return useCallback(
    (projectId: string, href: string) => {
      const store = useProjectStore.getState();
      if (store.projectId !== projectId) store.setProjectId(projectId);
      router.push(href);
    },
    [router],
  );
}

export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(mq.matches);
    const on = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return reduced;
}

/** Trạng thái giao diện cảnh báo của phiên: banner, bộ nhớ "vừa đến", chuông đang mở. Sống qua chuyển trang (layout). */
interface AlertUiState {
  banner: BannerState;
  mem: FeedMemory;
  bellOpen: boolean;
  setBanner: (fn: (s: BannerState) => BannerState) => void;
  setBellOpen: (open: boolean) => void;
}

export const useAlertUiStore = create<AlertUiState>((set) => ({
  banner: emptyBanner(),
  mem: createFeedMemory(),
  bellOpen: false,
  setBanner: (fn) => set((st) => ({ banner: fn(st.banner) })),
  setBellOpen: (bellOpen) => set({ bellOpen }),
}));

/** Chọn bộ màu nền/chữ/viền cho khối nổi bật theo mức (banner, toast). */
export function useToneStyle(kind: "danger" | "warning" | "ok") {
  return useMemo(
    () => ({
      backgroundColor: `var(--${kind}-subtle)`,
      color: `var(--${kind}-fg)`,
      borderLeftColor: `var(--${kind})`,
    }),
    [kind],
  );
}
