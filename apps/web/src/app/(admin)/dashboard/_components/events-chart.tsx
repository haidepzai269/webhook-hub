"use client";

import { type KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Area, AreaChart, CartesianGrid, ReferenceArea, ReferenceLine, XAxis, YAxis } from "recharts";

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

import {
  bucketLabelFor,
  formatSelection,
  moveIndex,
  overlayIndexes,
  selectionFromLabels,
} from "./chart-selection";
import { useChartSelection } from "./selection-context";

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
  const { selection, select, hoverAt } = useChartSelection();
  const { data, isLoading, isPlaceholderData, error, refetch } = useTimeseries(range);
  // Định dạng nhãn theo range CỦA DỮ LIỆU đang vẽ, không theo nút vừa bấm — tránh vẽ bucket giờ bằng nhãn ngày.
  const dataRange: TimeseriesRange =
    data && data.length > 1 && new Date(data[1].bucket).getTime() - new Date(data[0].bucket).getTime() > 3_600_000
      ? "7d"
      : "24h";
  const fmt = dataRange === "24h" ? hourFmt : dayFmt;

  // ADR-262: chọn khoảng. Kéo chỉ cập nhật `drag` (vẽ lớp phủ, KHÔNG truy vấn); nhả chuột mới ghi URL -> khối bên dưới mới tải.
  const buckets = useMemo(() => (data ?? []).map((d) => d.bucket), [data]);
  const [drag, setDrag] = useState<{ a: string; b: string } | null>(null);
  const dragRef = useRef<{ a: string; b: string } | null>(null);
  const bucketsRef = useRef(buckets);
  bucketsRef.current = buckets;
  const rangeRef = useRef(dataRange);
  rangeRef.current = dataRange;
  const labelOf = (e: { activeLabel?: string | number }) => (typeof e.activeLabel === "string" ? e.activeLabel : null);
  const endDrag = useCallback(() => {
    const d = dragRef.current;
    dragRef.current = null;
    setDrag(null);
    if (!d) return;
    // Cùng bucket (kéo < 1 bucket) = bấm = trọn bucket đó.
    const sel = selectionFromLabels(d.a, d.b, rangeRef.current);
    if (sel) select(sel);
  }, [select]);
  useEffect(() => {
    window.addEventListener("mouseup", endDrag); // nhả chuột ngoài vùng vẽ vẫn chốt
    return () => window.removeEventListener("mouseup", endDrag);
  }, [endDrag]);
  // Bàn phím: mũi tên chọn từng bucket, Shift mở rộng sang phải/trái, Esc bỏ chọn (Esc toàn trang ở selection-context).
  const kbIdx = useRef<number | null>(null);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if ((e.key !== "ArrowLeft" && e.key !== "ArrowRight") || buckets.length === 0) return;
    e.preventDefault();
    const cur = overlayIndexes(buckets, selection);
    const next = moveIndex(kbIdx.current ?? cur?.i2 ?? null, e.key === "ArrowLeft" ? -1 : 1, buckets.length);
    const anchor = e.shiftKey ? (cur?.i1 ?? next) : next;
    kbIdx.current = next;
    const sel = selectionFromLabels(buckets[anchor], buckets[next], dataRange);
    if (sel) select(sel);
  };
  // Đổi 24 giờ / 7 ngày -> xoá vùng chọn (trục khác bucket, giữ lại dễ gây hiểu nhầm).
  const changeRange = (r: TimeseriesRange) => {
    if (r === range) return;
    setRange(r);
    kbIdx.current = null;
    if (selection) select(null);
  };
  const preview = drag ? selectionFromLabels(drag.a, drag.b, dataRange) : selection;
  const ov = overlayIndexes(buckets, preview);
  const hoverLabel = hoverAt ? bucketLabelFor(buckets, hoverAt, dataRange) : null;

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
            onValueChange={(v) => v && changeRange(v as TimeseriesRange)}
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
          <>
          <p className="mb-1 text-muted-foreground text-xs">
            <span className="max-md:hidden">{t("page.dashboard.sel.hint")}</span>
            <span className="md:hidden">{t("page.dashboard.sel.hint-touch")}</span>
          </p>
          {/* Lưu ý bàn phím: vùng vẽ focus được (mũi tên/Shift/Esc); đường thay thế đầy đủ là trang Sự kiện có bộ lọc thời gian. */}
          <div
            role="group"
            tabIndex={0}
            aria-label={t("page.dashboard.sel.chart-label")}
            onKeyDown={onKeyDown}
            className="touch-pan-y select-none rounded-md focus-visible:outline-2 focus-visible:outline-ring"
          >
          <ChartContainer
            config={chartConfig}
            className={`aspect-auto h-64 w-full transition-opacity ${isPlaceholderData ? "opacity-50" : ""}`}
          >
            <AreaChart
              data={data ?? []}
              margin={{ left: -16, right: 8 }}
              onMouseDown={(e, ev) => {
                const l = labelOf(e);
                if (l && (ev as unknown as MouseEvent).button === 0) {
                  dragRef.current = { a: l, b: l };
                  setDrag({ a: l, b: l });
                }
              }}
              onMouseMove={(e) => {
                const l = labelOf(e);
                const d = dragRef.current;
                if (l && d && d.b !== l) {
                  dragRef.current = { a: d.a, b: l };
                  setDrag(dragRef.current);
                }
              }}
            >
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
              {/* Lớp phủ vùng chọn (token, không hex): ngoài vùng mờ đi, trong vùng nhuộm màu chính. */}
              {ov && ov.i1 > 0 && (
                <ReferenceArea x1={buckets[0]} x2={buckets[ov.i1]} fill="var(--background)" fillOpacity={0.6} stroke="none" ifOverflow="visible" />
              )}
              {ov && ov.i2 < buckets.length - 1 && (
                <ReferenceArea x1={buckets[ov.i2]} x2={buckets[buckets.length - 1]} fill="var(--background)" fillOpacity={0.6} stroke="none" ifOverflow="visible" />
              )}
              {ov && (
                <ReferenceArea x1={buckets[ov.i1]} x2={buckets[ov.i2]} fill="var(--primary)" fillOpacity={0.1} stroke="var(--primary)" strokeOpacity={0.5} ifOverflow="visible" />
              )}
              {ov && ov.i1 === ov.i2 && <ReferenceLine x={buckets[ov.i1]} stroke="var(--primary)" strokeWidth={2} />}
              {/* Rê dòng sự kiện bên dưới -> vạch dọc mốc của nó (như Network tab). */}
              {hoverLabel && <ReferenceLine x={hoverLabel} stroke="var(--foreground)" strokeDasharray="3 3" strokeOpacity={0.7} />}
              <ChartLegend content={<ChartLegendContent />} />
            </AreaChart>
          </ChartContainer>
          </div>
          {selection && (
            <p className="sr-only">{t("page.dashboard.sel.area-label", { range: formatSelection(selection) })}</p>
          )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
