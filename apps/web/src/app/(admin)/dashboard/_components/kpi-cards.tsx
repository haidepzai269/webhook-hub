"use client";

import Link from "next/link";

import { Activity, Cable, CircleCheck, Inbox, Send, Skull } from "lucide-react";

import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useOverview } from "@/lib/hub/queries";

const nf = new Intl.NumberFormat("vi-VN");

/** `successRate = null` khi chưa có delivery nào (S2-2) — hiện "—", không bịa 100%. */
function formatRate(rate: number | null): string {
  return rate === null ? "—" : `${rate.toFixed(1)}%`;
}

export function KpiCards() {
  const { data, isLoading, error } = useOverview();

  const items = [
    { label: "Nguồn", value: data?.totalSources, icon: Inbox, href: "/dashboard/sources" },
    { label: "Đích", value: data?.totalDestinations, icon: Cable, href: "/dashboard/destinations" },
    { label: "Sự kiện", value: data?.totalEvents, icon: Activity, href: "/dashboard/events" },
    { label: "Deliveries", value: data?.totalDeliveries, icon: Send, href: "/dashboard/deliveries" },
    {
      label: "DLQ (DEAD)",
      value: data?.deadDeliveries,
      icon: Skull,
      href: "/dashboard/dlq",
      tone: data && data.deadDeliveries > 0 ? "text-rose-600 dark:text-rose-400" : undefined,
    },
    {
      label: "Tỉ lệ thành công",
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
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-destructive text-base">Không tải được số liệu tổng quan</CardTitle>
          <CardDescription>{error.message}</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:gap-4 xl:grid-cols-6">
      {items.map((it) => (
        <Link key={it.label} href={it.href} className="group">
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
