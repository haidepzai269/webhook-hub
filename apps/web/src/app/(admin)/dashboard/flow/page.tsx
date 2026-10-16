"use client";

import { useEffect, useMemo, useState } from "react";

import { TOPOLOGY_WINDOWS, type TopologyWindow } from "@hub/flow";
import { ChevronDown, PowerOff, SlidersHorizontal } from "lucide-react";

import { EventLog } from "@/components/flow/event-log";
import { ProjectPicker } from "@/components/flow/project-picker";
import { HealthPill, TonePill } from "@/components/flow/pills";
import { ProviderIcon } from "@/components/flow/provider-icon";
import { ICON, ICON_SM } from "@/components/flow/tokens";
import { TopologyCanvas } from "@/components/flow/topology-canvas";
import { unusedDestinationIds } from "@/components/flow/unused-destinations";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { useTopology } from "@/lib/hub/queries";
import { useRealtimeProject } from "@/lib/hub/socket";
import { useFlowProjectStore } from "@/lib/hub/flow-project";
import { useT } from "@/lib/i18n/use-t";

import { TraceFeed } from "../events/_components/trace-feed";

const WINDOW_BTN: Record<TopologyWindow, string> = { "15m": "15M", "1h": "1H", "24h": "24H" };

/**
 * V3 — Bản đồ luồng (SPEC-event-flow-ui §4, §0A.A): cấu hình ĐANG SỐNG Source → Cổng xác thực →
 * Normalize → Subscription → Destination. Sức khoẻ node/cạnh do server tính (healthOf); UI chỉ tô màu.
 */
export default function FlowMapPage() {
  const t = useT();
  const [window, setWindow] = useState<TopologyWindow>("15m");
  const [sourceFilter, setSourceFilter] = useState<string | null>(null);
  const [showPulses, setShowPulses] = useState(true);
  const [collapseSubs, setCollapseSubs] = useState(false);
  const [showSubscriptions, setShowSubscriptions] = useState(false);
  const [showUnused, setShowUnused] = useState(true);
  const [layoutVersion, setLayoutVersion] = useState(0);
  const { data, error, isLoading } = useTopology(window);
  // ADR-161 (L5): source đang lọc vừa bị Xoá (lưu trữ) khỏi bản đồ -> bỏ lọc, không để bản đồ trống không lý do.
  useEffect(() => {
    if (sourceFilter && data && !data.nodes.some((n) => n.id === `src:${sourceFilter}`)) setSourceFilter(null);
  }, [sourceFilter, data]);
  useRealtimeProject(useFlowProjectStore((st) => st.projectId)); // R-5: socket theo project đang xem

  const sources = data?.nodes.filter((n) => n.kind === "source") ?? [];
  // Đích "không dùng" (không còn subscription bật) không tính vào crashed/warning — đếm riêng, luôn hiện ở header.
  const unused = useMemo(() => (data ? unusedDestinationIds(data) : new Set<string>()), [data]);
  const counts = { crashed: 0, warning: 0, healthy: 0, idle: 0 };
  for (const n of data?.nodes ?? []) if (!unused.has(n.id)) counts[n.health]++;
  const sourceName = sourceFilter ? sources.find((s) => s.id === `src:${sourceFilter}`)?.label : null;

  return (
    <div className="-m-4 md:-m-6 flex h-[calc(100svh-3rem)] flex-col gap-3 p-3 md:p-4">
      {/* P2: webhook trùng / chữ ký sai không thành chấm trên bản đồ -> toast trực tiếp từ trace.ingested. */}
      <TraceFeed toastsOnly />
      <div className="flow-canvas relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border" style={{ borderColor: "var(--flow-card-border)" }}>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3" style={{ borderColor: "var(--flow-card-border)", background: "color-mix(in oklch, var(--flow-card-solid) 70%, transparent)" }}>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="font-semibold text-lg tracking-tight">{t("nav.item.flow-map")}</h1>
            <div className="flex flex-wrap items-center gap-1.5">
              {counts.crashed > 0 && <HealthPill health="crashed" label={t("flow.health-count.crashed", { count: counts.crashed })} />}
              {counts.warning > 0 && <HealthPill health="warning" label={t("flow.health-count.warning", { count: counts.warning })} />}
              <HealthPill health="healthy" label={t("flow.health-count.healthy", { count: counts.healthy })} />
              <HealthPill health="idle" label={t("flow.health-count.idle", { count: counts.idle })} />
              {unused.size > 0 && (
                <button
                  type="button"
                  onClick={() => setShowUnused((v) => !v)}
                  aria-pressed={!showUnused}
                  title={t(showUnused ? "flow.unused.hide-hint" : "flow.unused.show-hint")}
                >
                  <TonePill tone="idle" icon={<PowerOff {...ICON_SM} aria-hidden />}>
                    {t(showUnused ? "flow.unused.count" : "flow.unused.count-hidden", { count: unused.size })}
                  </TonePill>
                </button>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <ProjectPicker className="bg-[var(--flow-card)] backdrop-blur" />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="bg-[var(--flow-card)] backdrop-blur" aria-label={t("flow.window.label")}>
                  {WINDOW_BTN[window]}
                  <ChevronDown {...ICON} />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuLabel>{t("flow.window.label")}</DropdownMenuLabel>
                <DropdownMenuRadioGroup value={window} onValueChange={(v) => setWindow(v as TopologyWindow)}>
                  {(Object.keys(TOPOLOGY_WINDOWS) as TopologyWindow[]).map((w) => (
                    <DropdownMenuRadioItem key={w} value={w}>
                      {t(`flow.window.${w}`)}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="bg-[var(--flow-card)] backdrop-blur">
                  {sourceName ?? t("flow.filter.all-sources")}
                  <ChevronDown {...ICON} />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => setSourceFilter(null)}>{t("flow.filter.all-sources")}</DropdownMenuItem>
                <DropdownMenuSeparator />
                {sources.map((s) => (
                  <DropdownMenuItem key={s.id} onSelect={() => setSourceFilter(s.id.slice(4))}>
                    <ProviderIcon provider={"provider" in s ? s.provider : ""} name={s.label} />
                    {s.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="bg-[var(--flow-card)] backdrop-blur">
                  <SlidersHorizontal {...ICON} />
                  {t("flow.options")}
                  <ChevronDown {...ICON} />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuCheckboxItem checked={showPulses} onCheckedChange={(v) => setShowPulses(Boolean(v))}>
                  {t("flow.options.pulses")}
                </DropdownMenuCheckboxItem>
                <DropdownMenuCheckboxItem checked={showSubscriptions} onCheckedChange={(v) => setShowSubscriptions(Boolean(v))}>
                  {t("flow.options.subscriptions")}
                </DropdownMenuCheckboxItem>
                <DropdownMenuCheckboxItem checked={showUnused} onCheckedChange={(v) => setShowUnused(Boolean(v))}>
                  {t("flow.options.unused")}
                </DropdownMenuCheckboxItem>
                <DropdownMenuCheckboxItem checked={collapseSubs} onCheckedChange={(v) => setCollapseSubs(Boolean(v))}>
                  {t("flow.options.collapse")}
                </DropdownMenuCheckboxItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onSelect={() => {
                    try {
                      localStorage.removeItem("flow:v3:positions");
                    } catch {}
                    setLayoutVersion((v) => v + 1);
                  }}
                >
                  {t("flow.options.relayout")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
        <div className="relative min-h-0 flex-1">
        {isLoading ? (
          <div className="grid h-full place-items-center">
            <Skeleton className="h-40 w-2/3" />
          </div>
        ) : error ? (
          <div className="grid h-full place-items-center text-destructive text-sm">{t("flow.load-error", { message: error.message })}</div>
        ) : data ? (
          <TopologyCanvas
            topology={data}
            showPulses={showPulses}
            collapseSubs={collapseSubs}
            sourceFilter={sourceFilter}
            layoutVersion={layoutVersion}
            showSubscriptions={showSubscriptions}
            showUnused={showUnused}
          />
        ) : null}
        </div>
      </div>
      <EventLog />
    </div>
  );
}
