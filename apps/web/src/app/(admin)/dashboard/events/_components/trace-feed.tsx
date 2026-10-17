"use client";

import { useEffect, useRef, useState } from "react";

import { Radio } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { useRealtimeStore } from "@/lib/hub/socket";
import { stepToasts } from "@/lib/hub/ui-logic";
import type { TraceIngestedNotice } from "@/lib/hub/types";
import { INTL_LOCALE, type MessageKey, type TranslateFn } from "@/lib/i18n/dictionary";
import { useLocale, useT } from "@/lib/i18n/use-t";
import { type StatusTone, toneBadgeClass } from "@/components/admin/status-badge";

const OUTCOME_TONE: Record<TraceIngestedNotice["outcome"], StatusTone> = {
  ACCEPTED: "ok",
  DUPLICATE: "info",
  REJECTED: "bad",
  RATE_LIMITED: "warn",
  ERROR: "bad",
};

const OUTCOME_LABEL: Record<TraceIngestedNotice["outcome"], MessageKey> = {
  ACCEPTED: "page.events.outcome.accepted",
  DUPLICATE: "page.events.outcome.duplicate",
  REJECTED: "page.events.outcome.rejected",
  RATE_LIMITED: "page.events.outcome.rate-limited",
  ERROR: "page.events.outcome.error",
};

const SHOW = 5;

function showTraceToast(tr: TraceIngestedNotice, more: number, t: TranslateFn) {
  const vars = {
    provider: tr.provider,
    status: tr.httpStatus,
    more: more > 0 ? t("page.events.toast.more", { count: more }) : "",
  };
  if (tr.outcome === "REJECTED") {
    toast.error(t("page.events.toast.rejected", vars), {
      description: t("page.events.toast.correlation", { source: tr.sourceKey, id: tr.correlationId.slice(0, 8) }),
    });
  } else if (tr.outcome === "DUPLICATE") {
    toast.info(t("page.events.toast.duplicate", vars), { description: tr.sourceKey });
  } else if (tr.outcome === "RATE_LIMITED") {
    toast.warning(t("page.events.toast.rate-limited", vars));
  }
}

/**
 * `trace.ingested` (S2-2): chặng ①–④ ở hub-api, phát in-process. Request bị chặn (REJECTED) hay
 * trùng (DUPLICATE) KHÔNG sinh event nên không bao giờ hiện trong bảng — dải này + toast cho thấy chúng.
 */
export function TraceFeed({ toastsOnly = false }: { toastsOnly?: boolean } = {}) {
  const traces = useRealtimeStore((s) => s.traces);
  const t = useT();
  const locale = useLocale();
  // Effect toast không phụ thuộc t (đổi ngôn ngữ không được toast lại) — đọc t mới nhất qua ref.
  const tRef = useRef(t);
  tRef.current = t;
  // Tăng để chạy lại effect khi tới lượt xả phần toast đang dồn.
  const [flushTick, setFlushTick] = useState(0);

  useEffect(() => {
    // Mốc toast nằm trong store (không useRef): mount lại không toast lại trace cũ. Bị dội -> tối đa
    // 1 toast / 2s, kèm "+N" (review SPEC-2 #8, ADR-054).
    void flushTick;
    const { toastCursor } = useRealtimeStore.getState();
    const step = stepToasts(traces, toastCursor, Date.now());
    useRealtimeStore.setState({ toastCursor: step.cursor });
    if (step.toast) showTraceToast(step.toast.trace, step.toast.more, tRef.current);
    if (step.flushInMs === null) return;
    const timer = setTimeout(() => setFlushTick((n) => n + 1), step.flushInMs);
    return () => clearTimeout(timer);
  }, [traces, flushTick]);

  // Bản đồ luồng (toàn màn hình): chỉ toast, không chiếm chỗ của canvas.
  if (toastsOnly || traces.length === 0) return null;

  return (
    <Card className="py-3">
      <CardContent className="space-y-1.5 px-4">
        <div className="flex items-center gap-2 text-muted-foreground text-xs">
          <Radio className="size-3.5" />
          {t("page.events.feed.title")}
        </div>
        <ul className="space-y-1">
          {traces.slice(0, SHOW).map((tr) => (
            <li key={`${tr.correlationId}-${tr.receivedAt}`} className="flex flex-wrap items-center gap-2 text-xs">
              <Badge variant="outline" className={`font-mono text-[11px] ${toneBadgeClass(OUTCOME_TONE[tr.outcome])}`}>
                {tr.outcome}
              </Badge>
              <span className="font-mono">{tr.provider}</span>
              <span className="text-muted-foreground">{t(OUTCOME_LABEL[tr.outcome])}</span>
              <span className="font-mono text-muted-foreground">
                HTTP {tr.httpStatus} · {tr.ms}ms
              </span>
              <span className="ml-auto text-muted-foreground">
                {new Date(tr.receivedAt).toLocaleTimeString(INTL_LOCALE[locale])}
              </span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
