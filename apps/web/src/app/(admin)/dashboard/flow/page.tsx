"use client";

import { useState } from "react";

import { TOPOLOGY_WINDOWS, type TopologyWindow } from "@hub/flow";
import { ChevronDown, SlidersHorizontal } from "lucide-react";

import { EventLog } from "@/components/flow/event-log";
import { HealthPill } from "@/components/flow/pills";
import { ProviderIcon } from "@/components/flow/provider-icon";
import { ICON } from "@/components/flow/tokens";
import { TopologyCanvas } from "@/components/flow/topology-canvas";
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

const WINDOW_BTN: Record<TopologyWindow, string> = { "15m": "15M", "1h": "1H", "24h": "24H" };

/**
 * V3 — Bản đồ luồng (SPEC-event-flow-ui §4, §0A.A): cấu hình ĐANG SỐNG Source → Cổng xác thực →
 * Normalize → Subscription → Destination. Sức khoẻ node/cạnh do server tính (healthOf); UI chỉ tô màu.
 */
export default function FlowMapPage() {
  const [window, setWindow] = useState<TopologyWindow>("15m");
  const [sourceFilter, setSourceFilter] = useState<string | null>(null);
  const [showPulses, setShowPulses] = useState(true);
  const [collapseSubs, setCollapseSubs] = useState(false);
  const [hideInactive, setHideInactive] = useState(true);
  const [showSubscriptions, setShowSubscriptions] = useState(false);
  const [layoutVersion, setLayoutVersion] = useState(0);
  const { data, error, isLoading } = useTopology(window);

  const sources = data?.nodes.filter((n) => n.kind === "source") ?? [];
  const counts = { crashed: 0, warning: 0, healthy: 0, idle: 0 };
  for (const n of data?.nodes ?? []) counts[n.health]++;
  const sourceName = sourceFilter ? sources.find((s) => s.id === `src:${sourceFilter}`)?.label : null;

  return (
    <div className="-m-4 md:-m-6 flex h-[calc(100svh-3rem)] flex-col gap-3 p-3 md:p-4">
      <div className="flow-canvas relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border" style={{ borderColor: "var(--flow-card-border)" }}>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3" style={{ borderColor: "var(--flow-card-border)", background: "color-mix(in oklch, var(--flow-card-solid) 70%, transparent)" }}>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="font-semibold text-lg tracking-tight">Bản đồ luồng</h1>
            <div className="flex flex-wrap items-center gap-1.5">
              {counts.crashed > 0 && <HealthPill health="crashed" label={`${counts.crashed} crashed`} />}
              {counts.warning > 0 && <HealthPill health="warning" label={`${counts.warning} warning`} />}
              <HealthPill health="healthy" label={`${counts.healthy} healthy`} />
              <HealthPill health="idle" label={`${counts.idle} idle`} />
            </div>
          </div>
          <div className="flex items-center gap-2">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="bg-[var(--flow-card)] backdrop-blur" aria-label="Cửa sổ thời gian">
                  {WINDOW_BTN[window]}
                  <ChevronDown {...ICON} />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuLabel>Cửa sổ thời gian</DropdownMenuLabel>
                <DropdownMenuRadioGroup value={window} onValueChange={(v) => setWindow(v as TopologyWindow)}>
                  {(Object.keys(TOPOLOGY_WINDOWS) as TopologyWindow[]).map((w) => (
                    <DropdownMenuRadioItem key={w} value={w}>
                      {TOPOLOGY_WINDOWS[w].label}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="bg-[var(--flow-card)] backdrop-blur">
                  {sourceName ?? "Tất cả source"}
                  <ChevronDown {...ICON} />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => setSourceFilter(null)}>Tất cả source</DropdownMenuItem>
                <DropdownMenuSeparator />
                {sources.map((s) => (
                  <DropdownMenuItem key={s.id} onSelect={() => setSourceFilter(s.id.slice(4))}>
                    <ProviderIcon provider={"provider" in s ? s.provider : ""} />
                    {s.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="bg-[var(--flow-card)] backdrop-blur">
                  <SlidersHorizontal {...ICON} />
                  Tuỳ chọn
                  <ChevronDown {...ICON} />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuCheckboxItem checked={showPulses} onCheckedChange={(v) => setShowPulses(Boolean(v))}>
                  Chấm chạy theo sự kiện
                </DropdownMenuCheckboxItem>
                <DropdownMenuCheckboxItem checked={showSubscriptions} onCheckedChange={(v) => setShowSubscriptions(Boolean(v))}>
                  Hiện cột Subscription (mặc định gộp vào nhãn cạnh)
                </DropdownMenuCheckboxItem>
                <DropdownMenuCheckboxItem checked={!hideInactive} onCheckedChange={(v) => setHideInactive(!v)}>
                  Hiện subscription đang tắt
                </DropdownMenuCheckboxItem>
                <DropdownMenuCheckboxItem checked={collapseSubs} onCheckedChange={(v) => setCollapseSubs(Boolean(v))}>
                  Gộp subscription cùng đích
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
                  Sắp lại bố cục tự động
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
          <div className="grid h-full place-items-center text-destructive text-sm">Không tải được bản đồ: {error.message}</div>
        ) : data ? (
          <TopologyCanvas
            topology={data}
            showPulses={showPulses}
            collapseSubs={collapseSubs}
            sourceFilter={sourceFilter}
            layoutVersion={layoutVersion}
            hideInactive={hideInactive}
            showSubscriptions={showSubscriptions}
          />
        ) : null}
        </div>
      </div>
      <EventLog />
    </div>
  );
}
