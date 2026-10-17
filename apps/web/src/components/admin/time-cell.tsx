"use client";

import { cn } from "cn";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatRelative, formatStamp } from "@/lib/hub/format";
import { useLocale } from "@/lib/i18n/use-t";

/**
 * Ô thời gian MỘT kiểu (ADR-246) — thay `formatDateTime` / `formatRelative` / `title=` tự ráp ở từng cột.
 * - `relative` (mặc định): "5 phút trước", tooltip = mốc tuyệt đối.
 * - `absolute`: "12/10 14:19:38" (24 giờ ở mọi ngôn ngữ), tooltip = tương đối.
 * - `both`: hai dòng (tuyệt đối + tương đối muted), không tooltip.
 * `iso` rỗng/không hợp lệ → "—".
 */
export function TimeCell({
  iso,
  mode = "relative",
  seconds = true,
  className,
}: {
  iso: string | null | undefined;
  mode?: "relative" | "absolute" | "both";
  /** Mốc tuyệt đối có giây (mặc định có). */
  seconds?: boolean;
  className?: string;
}) {
  const locale = useLocale();
  if (!iso || Number.isNaN(new Date(iso).getTime())) return <span className={cn("text-muted-foreground text-xs", className)}>—</span>;
  const abs = formatStamp(iso, { seconds });
  const rel = formatRelative(iso, undefined, locale);
  const base = cn("whitespace-nowrap text-xs tabular-nums", className);
  if (mode === "both") {
    return (
      <span className={base}>
        {abs}
        <span className="block text-[11px] text-muted-foreground">{rel}</span>
      </span>
    );
  }
  const [shown, hint] = mode === "relative" ? [rel, abs] : [abs, rel];
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={base}>{shown}</span>
      </TooltipTrigger>
      <TooltipContent>{hint}</TooltipContent>
    </Tooltip>
  );
}
