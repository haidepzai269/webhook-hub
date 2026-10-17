"use client";

import { cn } from "cn";
import type { ReactNode } from "react";

import "@/components/flow/flow.css";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { HttpToneName } from "@/lib/hub/format";
import type { DeliveryStatus } from "@/lib/hub/types";
import type { MessageKey } from "@/lib/i18n/dictionary";
import { useT } from "@/lib/i18n/use-t";

/** Bộ tone trạng thái DUY NHẤT của admin (dựa trên `--flow-*` — có sẵn bản dark). */
export type StatusTone = HttpToneName;

const TONE_CLASS: Record<StatusTone, string> = {
  ok: "tone-badge [--tone:var(--flow-healthy)]",
  warn: "tone-badge [--tone:var(--flow-warning)]",
  bad: "tone-badge [--tone:var(--flow-crashed)]",
  info: "tone-badge [--tone:var(--flow-progress)]",
  idle: "tone-badge [--tone:var(--flow-idle)]",
  progress: "tone-badge [--tone:var(--flow-progress)]",
};

const TONE_TEXT: Record<StatusTone, string> = {
  ok: "tone-text [--tone:var(--flow-healthy)]",
  warn: "tone-text [--tone:var(--flow-warning)]",
  bad: "tone-text [--tone:var(--flow-crashed)]",
  info: "tone-text [--tone:var(--flow-progress)]",
  idle: "text-muted-foreground",
  progress: "tone-text [--tone:var(--flow-progress)]",
};

/** Class chữ màu theo tone (số liệu/mã trạng thái trong ô bảng, không cần viền). */
export const toneTextClass = (tone: StatusTone) => TONE_TEXT[tone];

/** Class cho Badge/pill bất kỳ cần màu trạng thái (viền + nền nhạt + chữ theo tone). */
export const toneBadgeClass = (tone: StatusTone) => TONE_CLASS[tone];

export interface StatusBadgeProps {
  tone: StatusTone;
  children: ReactNode;
  /** Chấm tròn đầu nhãn (màu không đứng một mình: luôn kèm chữ). */
  dot?: boolean;
  /** Chấm nhấp nháy — đang xử lý (tắt khi prefers-reduced-motion). */
  pulse?: boolean;
  /** Giải thích khi hover (Radix tooltip, không phải `title=`). */
  tooltip?: ReactNode;
  className?: string;
}

/** Nhãn trạng thái dùng chung: `<StatusBadge tone="ok" dot>Hoạt động</StatusBadge>`. */
export function StatusBadge({ tone, children, dot, pulse, tooltip, className }: StatusBadgeProps) {
  const badge = (
    <Badge size="sm" variant="outline" className={cn(toneBadgeClass(tone), className)}>
      {dot || pulse ? <span aria-hidden className={cn("size-1.5 rounded-full bg-(--tone)", pulse && "animate-pulse")} /> : null}
      {children}
    </Badge>
  );
  if (!tooltip) return badge;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{badge}</TooltipTrigger>
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  );
}

const DELIVERY_TONE: Record<DeliveryStatus, StatusTone> = {
  PENDING: "idle",
  DELIVERING: "info",
  RETRYING: "warn",
  SUCCEEDED: "ok",
  DEAD: "bad",
};

/** Nhãn dịch của trạng thái; mã gốc (PENDING, DEAD…) để ở `title` cho ai cần đối chiếu với log/DB. */
export const deliveryStatusKey = (status: DeliveryStatus) => `status.delivery.${status.toLowerCase()}` as MessageKey;

export function DeliveryStatusBadge({ status }: { status: DeliveryStatus }) {
  const t = useT();
  return (
    <StatusBadge tone={DELIVERY_TONE[status]} tooltip={status}>
      {t(deliveryStatusKey(status))}
    </StatusBadge>
  );
}

/** Tóm tắt trạng thái các delivery của một event: "2✓ 1✗" — đủ để quét mắt trên bảng. */
export function DeliverySummary({ statuses }: { statuses: DeliveryStatus[] }) {
  const t = useT();
  if (!statuses.length) return <span className="text-muted-foreground text-xs">{t("status.delivery.none")}</span>;
  const counts = statuses.reduce<Partial<Record<DeliveryStatus, number>>>((acc, s) => {
    acc[s] = (acc[s] ?? 0) + 1;
    return acc;
  }, {});
  return (
    <div className="flex flex-wrap gap-1">
      {(Object.entries(counts) as [DeliveryStatus, number][]).map(([s, n]) => (
        <StatusBadge key={s} tone={DELIVERY_TONE[s]} tooltip={s}>
          {n} {t(deliveryStatusKey(s))}
        </StatusBadge>
      ))}
    </div>
  );
}
