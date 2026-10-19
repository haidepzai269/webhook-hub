"use client";

import Link from "next/link";

import { CopyCheck, Info, Skull } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useInsights } from "@/lib/hub/insight-queries";
import { INSIGHT_TONE, insightActions, insightText, type InsightView } from "@/lib/insights/message";
import { useLocale, useT } from "@/lib/i18n/use-t";

const ICON = { "I-dup": CopyCheck, "I-dead": Skull } as const;

/**
 * CB6 (SPEC §7): hai nhận định của trang Tổng quan — `I-dup` (bằng chứng sống BB-2/BB-3) và `I-dead` (+ nút sang DLQ).
 * MỘT lời gọi `/insights?codes=I-dup,I-dead`; câu chữ dựng ở lib/insights/message.ts.
 */
export function InsightsCard() {
  const t = useT();
  const locale = useLocale();
  const { data, isLoading, error } = useInsights(["I-dup", "I-dead"]);
  const now = Date.now();
  // Nhận định là phần phụ: lỗi thì ẩn, không che trang Tổng quan.
  if (error) return null;

  const row = (i: InsightView) => {
    const text = insightText(i, t, { locale, now });
    if (!text || (i.code !== "I-dup" && i.code !== "I-dead")) return null;
    const Icon = ICON[i.code];
    const action = insightActions(i)[0];
    return (
      <div key={i.code} className="flex min-w-0 flex-wrap items-start gap-3 sm:flex-nowrap">
        <Icon className={`mt-0.5 size-5 shrink-0 ${INSIGHT_TONE[text.level]}`} aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 font-medium text-sm">
            <span>{text.label}</span>
            {text.tooltip && (
              <Tooltip delayDuration={150}>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    className="text-muted-foreground hover:text-foreground"
                    aria-label={text.tooltip}
                  >
                    <Info className="size-3.5" aria-hidden />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top" className="max-w-sm">
                  {text.tooltip}
                </TooltipContent>
              </Tooltip>
            )}
          </div>
          {text.detail && <p className="text-muted-foreground text-xs">{text.detail}</p>}
        </div>
        {action && (
          <Button asChild size="sm" variant="outline" className="shrink-0 max-sm:min-h-10 max-sm:w-full">
            <Link href={action.href}>{t(action.labelKey)}</Link>
          </Button>
        )}
      </div>
    );
  };

  return (
    <Card>
      <CardContent className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {isLoading || !data ? (
          <>
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </>
        ) : (
          data.map(row)
        )}
      </CardContent>
    </Card>
  );
}
