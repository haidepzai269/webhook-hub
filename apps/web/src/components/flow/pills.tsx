"use client";

import type { ReactNode } from "react";

import { cn } from "cn";

import type { Health, StageStatus } from "@hub/flow";

import { httpTone, type HttpToneName } from "@/lib/hub/format";
import { useT } from "@/lib/i18n/use-t";

import { HEALTH_TONE, HealthGlyph, healthKey, STATUS_TONE, StatusGlyph, stageStatusKey, type Tone, toneStyle } from "./tokens";

export function TonePill({ tone, icon, children, className }: { tone: Tone; icon?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <span
      className={cn("flow-pill inline-flex h-5 items-center gap-1 rounded-full px-2 font-medium text-[11px] leading-none", className)}
      style={toneStyle(tone)}
    >
      {icon}
      {children}
    </span>
  );
}

/** Pill trạng thái chặng: màu + icon + chữ (không bao giờ chỉ có màu). */
export function StatusPill({ status, label }: { status: StageStatus; label?: string }) {
  const t = useT();
  return (
    <TonePill tone={STATUS_TONE[status]} icon={<StatusGlyph status={status} small />}>
      {label ?? t(stageStatusKey(status))}
    </TonePill>
  );
}

export function HealthPill({ health, label }: { health: Health; label?: string }) {
  const t = useT();
  return (
    <TonePill tone={HEALTH_TONE[health]} icon={<HealthGlyph health={health} small />}>
      {label ?? t(healthKey(health))}
    </TonePill>
  );
}

const HTTP_TONE: Record<HttpToneName, Tone> = { ok: "healthy", warn: "warning", bad: "crashed", info: "progress", idle: "idle", progress: "progress" };

/** Pill HTTP: 2xx xanh, 4xx/5xx đỏ, không phản hồi xám. */
export function HttpPill({ status }: { status: number | null | undefined }) {
  const t = useT();
  const tone: Tone = HTTP_TONE[httpTone(status)];
  return (
    <TonePill tone={tone} className="font-mono">
      {status ? `HTTP ${status}` : t("journey.http.no-response")}
    </TonePill>
  );
}

/** Chấm tròn có màu + vòng ngoài — dùng cạnh chữ "Healthy", "99.1%". */
export function ToneDot({ tone }: { tone: Tone }) {
  return <span className="inline-block size-1.5 shrink-0 rounded-full" style={{ background: `var(--flow-${tone === "skipped" ? "idle" : tone})` }} />;
}
