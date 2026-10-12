"use client";

import { Line, LineChart, YAxis } from "recharts";

import { RealtimeBadge } from "@/components/admin/realtime-badge";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { type ChartConfig, ChartContainer } from "@/components/ui/chart";
import { useRealtimeStore } from "@/lib/hub/socket";
import { useT } from "@/lib/i18n/use-t";

/** Sparkline từ `metrics.tick` (5s/lần, hub đếm trong bộ nhớ — không chạm Redis). */
export function RealtimeCard() {
  const ticks = useRealtimeStore((s) => s.ticks);
  const last = ticks.at(-1);
  const t = useT();
  const config = {
    eventsPerMin: { label: t("page.dashboard.realtime.per-min"), color: "var(--chart-2)" },
  } satisfies ChartConfig;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("page.dashboard.realtime.title")}</CardTitle>
        <CardDescription>{t("page.dashboard.realtime.desc")}</CardDescription>
        <CardAction>
          <RealtimeBadge />
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="flex items-baseline gap-4">
          <div>
            <div className="font-semibold text-2xl tabular-nums">{last ? Math.round(last.eventsPerMin) : "—"}</div>
            <div className="text-muted-foreground text-xs">{t("page.dashboard.realtime.per-min")}</div>
          </div>
          <div>
            <div className="font-semibold text-2xl tabular-nums">
              {last && last.successRate !== null ? `${last.successRate.toFixed(0)}%` : "—"}
            </div>
            <div className="text-muted-foreground text-xs">{t("page.dashboard.realtime.success")}</div>
          </div>
        </div>
        {ticks.length > 1 ? (
          <ChartContainer config={config} className="aspect-auto h-16 w-full">
            <LineChart data={ticks} margin={{ top: 4, bottom: 4, left: 0, right: 0 }}>
              <YAxis hide domain={[0, "auto"]} />
              <Line
                dataKey="eventsPerMin"
                type="monotone"
                stroke="var(--color-eventsPerMin)"
                strokeWidth={2}
                dot={false}
                isAnimationActive={false}
              />
            </LineChart>
          </ChartContainer>
        ) : (
          <p className="text-muted-foreground text-xs">{t("page.dashboard.realtime.waiting")}</p>
        )}
      </CardContent>
    </Card>
  );
}
