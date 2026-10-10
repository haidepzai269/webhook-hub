"use client";

import { Line, LineChart, YAxis } from "recharts";

import { RealtimeBadge } from "@/components/admin/realtime-badge";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { type ChartConfig, ChartContainer } from "@/components/ui/chart";
import { useRealtimeStore } from "@/lib/hub/socket";

const config = { eventsPerMin: { label: "sự kiện/phút", color: "var(--chart-2)" } } satisfies ChartConfig;

/** Sparkline từ `metrics.tick` (5s/lần, hub đếm trong bộ nhớ — không chạm Redis). */
export function RealtimeCard() {
  const ticks = useRealtimeStore((s) => s.ticks);
  const last = ticks.at(-1);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Realtime</CardTitle>
        <CardDescription>metrics.tick · 5 phút gần nhất</CardDescription>
        <CardAction>
          <RealtimeBadge />
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="flex items-baseline gap-4">
          <div>
            <div className="font-semibold text-2xl tabular-nums">{last ? Math.round(last.eventsPerMin) : "—"}</div>
            <div className="text-muted-foreground text-xs">sự kiện/phút</div>
          </div>
          <div>
            <div className="font-semibold text-2xl tabular-nums">
              {last && last.successRate !== null ? `${last.successRate.toFixed(0)}%` : "—"}
            </div>
            <div className="text-muted-foreground text-xs">giao thành công (5s cuối)</div>
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
          <p className="text-muted-foreground text-xs">Đang chờ tick đầu tiên…</p>
        )}
      </CardContent>
    </Card>
  );
}
