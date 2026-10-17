"use client";

import { useMemo, useState } from "react";

import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";

import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  type ChartConfig,
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import { CardSkeleton } from "@/components/admin/skeletons";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useTimeseries } from "@/lib/hub/queries";
import type { TimeseriesRange } from "@/lib/hub/types";
import { ErrorState } from "@/components/admin/state";
import { chartTimeFormatters } from "@/lib/hub/format";
import { TONE_VAR } from "@/components/flow/tokens";
import { useLocale, useT } from "@/lib/i18n/use-t";

const SERIES = {
  events: { labelKey: "page.dashboard.chart.events", color: "var(--chart-1)" },
  succeeded: { labelKey: "page.dashboard.chart.succeeded", color: TONE_VAR.healthy },
  retrying: { labelKey: "page.dashboard.chart.retrying", color: TONE_VAR.warning },
  dead: { labelKey: "page.dashboard.chart.dead", color: TONE_VAR.crashed },
} as const;

/**
 * Bucket do SERVER cắt theo giờ Việt Nam (`TIMESERIES_TZ = 'Asia/Ho_Chi_Minh'`, libs/database tenant-scoped.repository) —
 * nhãn phải dùng ĐÚNG múi giờ đó (không dùng giờ máy) để ranh giới ngày khớp bucket; hiển thị kèm nhãn múi giờ (ADR-246).
 */
const TZ = "Asia/Ho_Chi_Minh";

export function EventsChart() {
  const t = useT();
  const locale = useLocale();
  const chartConfig = useMemo<ChartConfig>(
    () => Object.fromEntries(Object.entries(SERIES).map(([k, v]) => [k, { label: t(v.labelKey), color: v.color }])),
    [t],
  );
  const { time: hourFmt, day: dayFmt } = chartTimeFormatters(locale, TZ);
  const [range, setRange] = useState<TimeseriesRange>("24h");
  const { data, isLoading, isPlaceholderData, error, refetch } = useTimeseries(range);
  // Định dạng nhãn theo range CỦA DỮ LIỆU đang vẽ, không theo nút vừa bấm — tránh vẽ bucket giờ bằng nhãn ngày.
  const dataRange: TimeseriesRange =
    data && data.length > 1 && new Date(data[1].bucket).getTime() - new Date(data[0].bucket).getTime() > 3_600_000
      ? "7d"
      : "24h";
  const fmt = dataRange === "24h" ? hourFmt : dayFmt;

  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle>{t("page.dashboard.chart.title")}</CardTitle>
        <CardDescription>
          {t(range === "24h" ? "page.dashboard.chart.desc-24h" : "page.dashboard.chart.desc-7d")} ·{" "}
          {t("page.dashboard.chart.desc-note")} · {t("page.dashboard.chart.tz")}
        </CardDescription>
        <CardAction>
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            value={range}
            onValueChange={(v) => v && setRange(v as TimeseriesRange)}
          >
            <ToggleGroupItem value="24h">{t("page.dashboard.chart.range-24h")}</ToggleGroupItem>
            <ToggleGroupItem value="7d">{t("page.dashboard.chart.range-7d")}</ToggleGroupItem>
          </ToggleGroup>
        </CardAction>
      </CardHeader>
      <CardContent>
        {error ? (
          <ErrorState inline message={t("page.dashboard.chart.load-error", { message: error.message })} onRetry={() => void refetch()} />
        ) : isLoading && !data ? (
          <CardSkeleton lines={6} className="h-64" />
        ) : (
          <ChartContainer
            config={chartConfig}
            className={`aspect-auto h-64 w-full transition-opacity ${isPlaceholderData ? "opacity-50" : ""}`}
          >
            <AreaChart data={data ?? []} margin={{ left: -16, right: 8 }}>
              <defs>
                {(Object.keys(SERIES) as (keyof typeof SERIES)[]).map((k) => (
                  <linearGradient key={k} id={`fill-${k}`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={`var(--color-${k})`} stopOpacity={0.5} />
                    <stop offset="95%" stopColor={`var(--color-${k})`} stopOpacity={0.05} />
                  </linearGradient>
                ))}
              </defs>
              <CartesianGrid vertical={false} />
              <XAxis
                dataKey="bucket"
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                minTickGap={24}
                tickFormatter={(v: string) => fmt.format(new Date(v))}
              />
              <YAxis allowDecimals={false} tickLine={false} axisLine={false} width={40} />
              <ChartTooltip
                cursor={false}
                content={
                  <ChartTooltipContent
                    indicator="dot"
                    labelFormatter={(_, payload) => {
                      const b = payload?.[0]?.payload?.bucket as string | undefined;
                      return b
                        ? `${dayFmt.format(new Date(b))} ${dataRange === "24h" ? hourFmt.format(new Date(b)) : ""}`
                        : "";
                    }}
                  />
                }
              />
              <Area dataKey="events" type="monotone" stroke="var(--color-events)" fill="url(#fill-events)" />
              <Area dataKey="succeeded" type="monotone" stroke="var(--color-succeeded)" fill="url(#fill-succeeded)" />
              <Area dataKey="retrying" type="monotone" stroke="var(--color-retrying)" fill="url(#fill-retrying)" />
              <Area dataKey="dead" type="monotone" stroke="var(--color-dead)" fill="url(#fill-dead)" />
              <ChartLegend content={<ChartLegendContent />} />
            </AreaChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  );
}
