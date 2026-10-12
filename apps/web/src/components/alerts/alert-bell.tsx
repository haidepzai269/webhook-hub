"use client";

import { useEffect, useRef, useState } from "react";

import Link from "next/link";

import { ArrowRight, Bell, CheckCheck } from "lucide-react";
import { toast } from "sonner";

import { cn } from "cn";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { primaryHref } from "@/lib/alerts/links";
import { ackAllAsOf, bellBadge, groupForBell } from "@/lib/alerts/notify-logic";
import type { AlertView } from "@/lib/alerts/types";
import { useAckAllAlerts, useAlertSummary, useOpenAlertFeed, useSubjectNames } from "@/lib/hub/alert-queries";
import { formatRelative } from "@/lib/hub/format";
import { useIsOperator } from "@/lib/hub/me-store";
import { useLocale, useT } from "@/lib/i18n/use-t";

import { ProjectChip, SeverityDot, useAlertText, useAlertUiStore, useMinuteClock, useOpenAlertTarget } from "./alert-ui";

/**
 * CB4 §8.1: chuông ở header, cạnh nút Ngôn ngữ / sáng-tối — CHỈ operator (người khác không thấy, không gọi `/alerts*`).
 * Badge = số OPEN chưa xem, đỏ nếu có critical CHƯA XEM, hổ phách nếu chỉ warning, không badge khi 0. Popover ~380px nhóm
 * theo project (critical trước rồi mới nhất). Tổng gọi lại khi có `alert.changed` + poll 30s (alert-queries).
 */
export function AlertBell() {
  const operator = useIsOperator();
  if (!operator) return null;
  return <OperatorBell />;
}

function OperatorBell() {
  const t = useT();
  const summary = useAlertSummary();
  const feed = useOpenAlertFeed();
  const open = useAlertUiStore((s) => s.bellOpen);
  const setOpen = useAlertUiStore((s) => s.setBellOpen);
  const badge = bellBadge(summary.data);
  // "Đánh dấu đã xem tất cả" chỉ đánh dấu cảnh báo mở TRƯỚC lúc mở chuông (asOf) — cái mới đến sau vẫn chưa xem.
  // Review TB1: chốt lại MỖI LẦN chuông chuyển đóng -> mở, kể cả khi mở bằng code ("+k" của banner), không chỉ khi bấm.
  // Review L2: mốc lấy từ dữ liệu server (cảnh báo mới nhất đang hiện, sau khi gọi lại), không từ đồng hồ máy người xem.
  const [asOf, setAsOf] = useState<string | null>(null);
  const items = useRef(feed.data?.items);
  items.current = feed.data?.items;
  const wasOpen = useRef(false);
  const refetch = feed.refetch;
  useEffect(() => {
    if (open && !wasOpen.current) {
      setAsOf(ackAllAsOf(items.current ?? []));
      void refetch().then((r) => {
        if (r.data) setAsOf(ackAllAsOf(r.data.items));
      });
    }
    wasOpen.current = open;
  }, [open, refetch]);

  const label = badge ? t("alerts.bell.aria", { count: badge.count }) : t("alerts.bell.aria-none");
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
    >
      <PopoverTrigger asChild>
        <Button size="icon" variant="outline" aria-label={label} title={label} className="relative">
          <Bell />
          {badge && (
            <span
              aria-hidden
              className={cn(
                "absolute -top-1.5 -right-1.5 flex h-4 min-w-4 items-center justify-center rounded-full px-1 font-semibold text-[10px] tabular-nums leading-none ring-2 ring-background",
                badge.tone === "critical" && "alert-bell-pulse",
              )}
              style={
                badge.tone === "critical"
                  ? { backgroundColor: "var(--danger-solid)", color: "var(--on-danger-solid)" }
                  : { backgroundColor: "var(--warning-solid)", color: "var(--on-warning-solid)" }
              }
            >
              {badge.label}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={8} className="w-[380px] max-w-[calc(100vw-1rem)] gap-0 p-0">
        <BellPanel asOf={asOf} onNavigate={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  );
}

const STATUS_TEXT = { error: "alerts.bell.error", loading: "common.loading" } as const;

function BellPanel({ asOf, onNavigate }: { asOf: string | null; onNavigate: () => void }) {
  const t = useT();
  const locale = useLocale();
  const now = useMinuteClock();
  const summary = useAlertSummary();
  const feed = useOpenAlertFeed();
  const ackAll = useAckAllAlerts();
  const text = useAlertText();
  const go = useOpenAlertTarget();
  const items = feed.data?.items ?? [];
  const nameOf = useSubjectNames(items);
  const groups = groupForBell(items, summary.data);
  const openCount = summary.data ? summary.data.openBySeverity.critical + summary.data.openBySeverity.warning + summary.data.openBySeverity.info : items.length;
  const unacked = summary.data?.unacked ?? 0;
  let status: "error" | "loading" | "ready" = "ready";
  if (feed.isError && !feed.data) status = "error";
  else if (feed.isLoading) status = "loading";

  const pick = (a: AlertView) => {
    onNavigate();
    go(a.project.id, primaryHref(a));
  };

  return (
    <div className="flex max-h-[min(560px,calc(100vh-6rem))] flex-col">
      <div className="flex items-baseline justify-between gap-2 border-b px-4 py-3">
        <h2 className="font-semibold text-sm">{t("alerts.bell.label")}</h2>
        {openCount > 0 && <span className="text-muted-foreground text-xs">{t("alerts.bell.subtitle", { count: openCount })}</span>}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {status !== "ready" && <p className="px-4 py-6 text-center text-muted-foreground text-sm">{t(STATUS_TEXT[status])}</p>}
        {status === "ready" && groups.length === 0 && <EmptyState />}
        {status === "ready" &&
          groups.map((g) => (
            <section key={g.project.id} className="border-b last:border-b-0">
              <header className="flex items-center gap-2 px-4 pt-3 pb-1">
                <ProjectChip name={g.project.name} />
                <span className="text-muted-foreground text-xs tabular-nums">{g.count}</span>
              </header>
              <ul className="pb-2">
                {g.items.map((a) => {
                  const msg = text(a, nameOf(a.subjectId));
                  return (
                    <li key={a.id}>
                      <button
                        type="button"
                        onClick={() => pick(a)}
                        className={cn(
                          "grid w-full grid-cols-[auto_1fr_auto] items-baseline gap-x-2.5 px-4 py-1.5 text-left hover:bg-muted focus-visible:bg-muted focus-visible:outline-none",
                          a.acknowledgedAt && "opacity-65",
                        )}
                      >
                        <SeverityDot severity={a.severity} className="translate-y-[-1px]" />
                        <span className="truncate text-sm" title={msg.title}>
                          {msg.title}
                        </span>
                        <span className="whitespace-nowrap text-[11px] text-muted-foreground tabular-nums">
                          {formatRelative(a.openedAt, now, locale)}
                        </span>
                        <span />
                        <span className="col-span-2 truncate text-muted-foreground text-xs">
                          {msg.subjectLabel}
                          {a.acknowledgedAt ? ` · ${t("alerts.bell.acked")}` : ""}
                        </span>
                      </button>
                    </li>
                  );
                })}
                {g.more > 0 && (
                  <li className="px-4 pt-0.5 pb-1">
                    <Link
                      href={`/dashboard/alerts?project=${encodeURIComponent(g.project.id)}&state=OPEN`}
                      onClick={onNavigate}
                      className="text-muted-foreground text-xs underline-offset-2 hover:underline"
                    >
                      {t("alerts.bell.more", { count: g.more })}
                    </Link>
                  </li>
                )}
              </ul>
            </section>
          ))}
      </div>

      <div className="flex items-center justify-between gap-2 border-t px-2 py-1.5">
        <Button
          size="sm"
          variant="ghost"
          disabled={unacked === 0 || !asOf || ackAll.isPending}
          onClick={() =>
            asOf &&
            ackAll.mutate(
              { asOf },
              { onSuccess: (r) => toast.success(t("alerts.bell.ack-all-done", { count: r.acknowledged })) },
            )
          }
        >
          <CheckCheck />
          {t("alerts.bell.ack-all")}
        </Button>
        <Button size="sm" variant="ghost" asChild>
          <Link href="/dashboard/alerts" onClick={onNavigate}>
            {t("alerts.bell.view-all")}
            <ArrowRight />
          </Link>
        </Button>
      </div>
    </div>
  );
}

/** Trống: minh hoạ nhỏ vẽ tay bằng SVG (không ảnh nặng) + câu trấn an. */
function EmptyState() {
  const t = useT();
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-8 text-center">
      <svg width="64" height="56" viewBox="0 0 64 56" aria-hidden className="text-muted-foreground">
        <circle cx="32" cy="28" r="26" fill="currentColor" opacity="0.08" />
        <path
          d="M32 12c-6.1 0-11 4.9-11 11v7.5l-3 4.5h28l-3-4.5V23c0-6.1-4.9-11-11-11Z"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinejoin="round"
        />
        <path d="M28.5 38.5a3.5 3.5 0 0 0 7 0" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        <circle cx="45" cy="15" r="7" fill="var(--ok)" />
        <path d="m41.8 15 2.2 2.2 4-4.2" fill="none" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <p className="font-medium text-sm">{t("alerts.bell.empty-title")}</p>
      <p className="text-muted-foreground text-xs">{t("alerts.bell.empty-body")}</p>
    </div>
  );
}
