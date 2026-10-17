"use client";

import { useMemo, useState } from "react";

import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";

import { AdminSheetContent } from "@/components/admin/overlay-content";
import { SimpleTable } from "@/components/admin/simple-table";
import { EmptyState, ErrorState } from "@/components/admin/state";
import {
  type ChartConfig,
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import { Sheet, SheetBody, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { CardSkeleton } from "@/components/admin/skeletons";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { HubApiError } from "@/lib/hub/client";
import { useSourceTraffic } from "@/lib/hub/traffic-queries";
import type { Source } from "@/lib/hub/types";
import { formatNumber, chartTimeFormatters } from "@/lib/hub/format";
import type { MessageKey } from "@/lib/i18n/dictionary";
import { useLocale, useT } from "@/lib/i18n/use-t";
import { INSIGHT_DOT, INSIGHT_TONE } from "@/lib/insights/message";
import {
  blockedNowText,
  TRAFFIC_OUTCOMES,
  type TrafficOutcome,
  type TrafficRange,
  trafficInsightText,
} from "@/lib/traffic/message";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";


/** Màu từng kết quả — cùng bảng màu với biểu đồ Tổng quan (xanh = nhận, đỏ = lỗi, hổ phách = vượt trần). */
const SERIES: Record<TrafficOutcome, { key: MessageKey; color: string }> = {
  ACCEPTED: { key: "traffic.outcome.accepted", color: "oklch(0.65 0.15 155)" },
  DUPLICATE: { key: "traffic.outcome.duplicate", color: "var(--chart-2)" },
  REJECTED: { key: "traffic.outcome.rejected", color: "oklch(0.63 0.22 25)" },
  RATE_LIMITED: { key: "traffic.outcome.rate-limited", color: "oklch(0.75 0.15 75)" },
  BLOCKED: { key: "traffic.outcome.blocked", color: "oklch(0.55 0.2 300)" },
  // QT7 (E2): request bị 507 vì dự án đầy dung lượng (bytes 0) — xám đậm, khác lỗi chữ ký và vượt trần.
  STORAGE_FULL: { key: "traffic.outcome.storage-full", color: "oklch(0.45 0.03 260)" },
};

/**
 * EG5 (SPEC-chong-qua-tai §6.2, ADR-181): khối "Lưu lượng" của MỘT nguồn — mở từ dòng của bảng Nguồn (không có trang mới).
 * Câu nhận định ở đầu, dòng "đang tạm chặn" (ước lượng của một máy chủ), biểu đồ cột xếp chồng theo kết quả, bảng IP.
 * 403 (developer/viewer) -> câu giải thích thay cho dữ liệu.
 */
export function TrafficSheet({ source, onClose }: { source: Source | null; onClose: () => void }) {
  const t = useT();
  return (
    <Sheet open={Boolean(source)} onOpenChange={(o) => !o && onClose()}>
      <AdminSheetContent size="lg">
        {source && (
          <>
            <SheetHeader>
              <SheetTitle>{t("traffic.title", { name: source.name })}</SheetTitle>
              <SheetDescription>{t("traffic.description")}</SheetDescription>
            </SheetHeader>
            <SheetBody>
              <TrafficBlock sourceId={source.id} />
            </SheetBody>
          </>
        )}
      </AdminSheetContent>
    </Sheet>
  );
}

function TrafficBlock({ sourceId }: { sourceId: string }) {
  const t = useT();
  const locale = useLocale();
  const [range, setRange] = useState<TrafficRange>("1h");
  const { data, isLoading, isPlaceholderData, error, refetch } = useSourceTraffic(sourceId, range);
  const chartConfig = useMemo<ChartConfig>(
    () => Object.fromEntries(TRAFFIC_OUTCOMES.map((k) => [k, { label: t(SERIES[k].key), color: SERIES[k].color }])),
    [t],
  );
  // Bucket lưu lượng cắt theo epoch (UTC, không theo múi giờ cố định) → nhãn theo giờ máy người xem (ADR-246).
  const { time: timeFmt, day: dayFmt } = chartTimeFormatters(locale);
  const dataRange = data?.range ?? range;
  const tick = (v: string) => (dataRange === "7d" ? dayFmt.format(new Date(v)) : timeFmt.format(new Date(v)));

  const forbidden = error instanceof HubApiError && error.status === 403;
  const text = data ? trafficInsightText(data.insight, t, locale, dataRange) : null;
  const blocked = blockedNowText(data?.blockedNow, t);

  return (
    <div className="space-y-4 px-4 pt-4 pb-6">
      <ToggleGroup
        type="single"
        variant="outline"
        size="sm"
        value={range}
        onValueChange={(v) => v && setRange(v as TrafficRange)}
        aria-label={t("traffic.button")}
      >
        {(["1h", "24h", "7d"] as const).map((r) => (
          <ToggleGroupItem key={r} value={r}>
            {t(`traffic.range.${r}`)}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>

      {forbidden ? (
        <EmptyState size="sm" className="rounded-lg border" title={t("traffic.forbidden")} />
      ) : error ? (
        <ErrorState message={t("traffic.load-error", { message: error.message })} onRetry={() => void refetch()} />
      ) : isLoading && !data ? (
        <CardSkeleton lines={6} />
      ) : data && text ? (
        <div className={`space-y-4 transition-opacity ${isPlaceholderData ? "opacity-50" : ""}`}>
          <div className="space-y-1" data-testid="traffic-insight">
            <p className={`flex items-start gap-2 font-medium text-sm ${INSIGHT_TONE[text.level]}`}>
              <span className={`mt-1.5 size-2 shrink-0 rounded-full ${INSIGHT_DOT[text.level]}`} aria-hidden />
              <span>{text.label}</span>
            </p>
            <p className="text-muted-foreground text-xs">{text.detail}</p>
          </div>

          {blocked && (
            <Alert variant="warning">
              <AlertTitle>{blocked}</AlertTitle>
              <AlertDescription className="text-xs">{t("traffic.blocked-now-estimate")}</AlertDescription>
            </Alert>
          )}

          {!text.empty && (
            <>
              <ChartContainer
                config={chartConfig}
                className="aspect-auto h-60 w-full"
                aria-label={t("traffic.chart.aria")}
                role="img"
              >
                <BarChart data={data.buckets} margin={{ left: -16, right: 8 }}>
                  <CartesianGrid vertical={false} />
                  <XAxis
                    dataKey="t"
                    tickLine={false}
                    axisLine={false}
                    tickMargin={8}
                    minTickGap={24}
                    tickFormatter={tick}
                  />
                  <YAxis allowDecimals={false} tickLine={false} axisLine={false} width={40} />
                  <ChartTooltip
                    cursor={false}
                    content={
                      <ChartTooltipContent
                        indicator="dot"
                        labelFormatter={(_, payload) => {
                          const v = payload?.[0]?.payload?.t as string | undefined;
                          return v ? `${dayFmt.format(new Date(v))} ${timeFmt.format(new Date(v))}` : "";
                        }}
                      />
                    }
                  />
                  {TRAFFIC_OUTCOMES.map((k) => (
                    <Bar key={k} dataKey={k} stackId="a" fill={`var(--color-${k})`} isAnimationActive={false} />
                  ))}
                  <ChartLegend content={<ChartLegendContent />} itemSorter={null} />
                </BarChart>
              </ChartContainer>

              {data.topIps.length > 0 && (
                <div className="space-y-1">
                  <h3 className="font-medium text-sm">{t("traffic.top-ips.title")}</h3>
                  <SimpleTable
                    rows={data.topIps}
                    getRowKey={(r) => r.ip}
                    columns={[
                      { key: "ip", header: t("traffic.top-ips.col.ip"), cell: (r) => <span className="font-mono text-xs">{r.ip}</span> },
                      { key: "count", header: t("traffic.top-ips.col.count"), align: "right", className: "tabular-nums", cell: (r) => formatNumber(r.count, locale) },
                      {
                        key: "rejected",
                        header: t("traffic.top-ips.col.rejected"),
                        align: "right",
                        className: "tabular-nums",
                        cell: (r) => (r.count > 0 ? `${Math.round((r.rejected / r.count) * 100)}%` : "—"),
                      },
                      {
                        key: "last",
                        header: t("traffic.top-ips.col.last"),
                        className: "text-xs tabular-nums",
                        cell: (r) => `${dayFmt.format(new Date(r.lastSeen))} ${timeFmt.format(new Date(r.lastSeen))}`,
                      },
                    ]}
                  />
                  <p className="text-muted-foreground text-xs">{t("traffic.top-ips.note")}</p>
                </div>
              )}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
