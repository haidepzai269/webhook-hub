"use client";

import { cn } from "cn";

import { Badge } from "@/components/ui/badge";
import type { DeliveryStatus } from "@/lib/hub/types";
import type { MessageKey } from "@/lib/i18n/dictionary";
import { useT } from "@/lib/i18n/use-t";

const STATUS_STYLE: Record<DeliveryStatus, string> = {
  PENDING: "border-slate-400/40 bg-slate-500/10 text-slate-700 dark:text-slate-300",
  DELIVERING: "border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300",
  RETRYING: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  SUCCEEDED: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  DEAD: "border-rose-500/40 bg-rose-500/10 text-rose-700 dark:text-rose-300",
};

/** Nhãn dịch của trạng thái; mã gốc (PENDING, DEAD…) để ở `title` cho ai cần đối chiếu với log/DB. */
export const deliveryStatusKey = (status: DeliveryStatus) => `status.delivery.${status.toLowerCase()}` as MessageKey;

export function DeliveryStatusBadge({ status }: { status: DeliveryStatus }) {
  const t = useT();
  return (
    <Badge variant="outline" className={cn("text-[11px]", STATUS_STYLE[status])} title={status}>
      {t(deliveryStatusKey(status))}
    </Badge>
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
        <Badge key={s} variant="outline" className={cn("text-[11px]", STATUS_STYLE[s])} title={s}>
          {n} {t(deliveryStatusKey(s))}
        </Badge>
      ))}
    </div>
  );
}
