"use client";

import Link from "next/link";

import { Activity, Cable, CircleCheck, Inbox, Send, Skull } from "lucide-react";

import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useOverview } from "@/lib/hub/queries";
import { ErrorState } from "@/components/admin/state";
import { INTL_LOCALE } from "@/lib/i18n/dictionary";
import { useLocale, useT } from "@/lib/i18n/use-t";

/** `successRate = null` khi chưa có delivery nào (S2-2) — hiện "—", không bịa 100%. */
function formatRate(rate: number | null): string {
  return rate === null ? "—" : `${rate.toFixed(1)}%`;
}

export function KpiCards() {
  const { data, isLoading, error, refetch } = useOverview();
  const t = useT();
  const nf = new Intl.NumberFormat(INTL_LOCALE[useLocale()]);

  const items = [
    { label: t("page.dashboard.kpi.sources"), value: data?.totalSources, icon: Inbox, href: "/dashboard/sources" },
    { label: t("page.dashboard.kpi.destinations"), value: data?.totalDestinations, icon: Cable, href: "/dashboard/destinations" },
    { label: t("page.dashboard.kpi.events"), value: data?.totalEvents, icon: Activity, href: "/dashboard/events" },
    { label: t("page.dashboard.kpi.deliveries"), value: data?.totalDeliveries, icon: Send, href: "/dashboard/deliveries" },
    {
      label: t("page.dashboard.kpi.dead"),
      value: data?.deadDeliveries,
      icon: Skull,
      href: "/dashboard/dlq",
      tone: data && data.deadDeliveries > 0 ? "text-rose-600 dark:text-rose-400" : undefined,
    },
    {
      label: t("page.dashboard.kpi.success-rate"),
      value: data ? formatRate(data.successRate) : undefined,
      icon: CircleCheck,
      href: "/dashboard/deliveries",
      tone:
        data && data.successRate !== null && data.successRate < 95
          ? "text-amber-600 dark:text-amber-400"
          : "text-emerald-600 dark:text-emerald-400",
    },
  ];

  if (error) {
    return <ErrorState message={`${t("page.dashboard.kpi.load-error")}: ${error.message}`} onRetry={() => void refetch()} />;
  }

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:gap-4 xl:grid-cols-6">
      {items.map((it) => (
        <Link key={it.href + it.label} href={it.href} className="group">
          <Card className="h-full transition-colors group-hover:border-primary/40">
            <CardHeader className="gap-2">
              <CardDescription className="flex items-center gap-1.5">
                <it.icon className="size-4" />
                {it.label}
              </CardDescription>
              <CardTitle className={`font-semibold text-2xl tabular-nums ${it.tone ?? ""}`}>
                {isLoading || it.value === undefined ? (
                  <Skeleton className="h-8 w-16" />
                ) : typeof it.value === "number" ? (
                  nf.format(it.value)
                ) : (
                  it.value
                )}
              </CardTitle>
            </CardHeader>
          </Card>
        </Link>
      ))}
    </div>
  );
}
