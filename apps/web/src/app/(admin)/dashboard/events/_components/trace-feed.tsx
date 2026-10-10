"use client";

import { useEffect, useState } from "react";

import { Radio } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { useRealtimeStore } from "@/lib/hub/socket";
import { stepToasts } from "@/lib/hub/ui-logic";
import type { TraceIngestedNotice } from "@/lib/hub/types";

const OUTCOME_STYLE: Record<TraceIngestedNotice["outcome"], string> = {
  ACCEPTED: "border-emerald-500/40 text-emerald-700 dark:text-emerald-300",
  DUPLICATE: "border-sky-500/40 text-sky-700 dark:text-sky-300",
  REJECTED: "border-rose-500/40 text-rose-700 dark:text-rose-300",
  RATE_LIMITED: "border-amber-500/40 text-amber-700 dark:text-amber-300",
  ERROR: "border-rose-500/40 text-rose-700 dark:text-rose-300",
};

const OUTCOME_LABEL: Record<TraceIngestedNotice["outcome"], string> = {
  ACCEPTED: "nhận",
  DUPLICATE: "trùng — bỏ qua",
  REJECTED: "chữ ký sai — bị chặn",
  RATE_LIMITED: "vượt rate limit",
  ERROR: "lỗi lưu",
};

const SHOW = 5;

function showTraceToast(t: TraceIngestedNotice, more: number) {
  const extra = more > 0 ? ` (+${more} cảnh báo khác)` : "";
  if (t.outcome === "REJECTED") {
    toast.error(`Webhook ${t.provider} bị chặn: chữ ký sai (HTTP ${t.httpStatus})${extra}`, {
      description: `${t.sourceKey} · correlation ${t.correlationId.slice(0, 8)}…`,
    });
  } else if (t.outcome === "DUPLICATE") {
    toast.info(`Webhook ${t.provider} trùng — hub trả ${t.httpStatus}, không tạo sự kiện mới${extra}`, {
      description: t.sourceKey,
    });
  } else if (t.outcome === "RATE_LIMITED") {
    toast.warning(`Webhook ${t.provider} vượt rate limit (HTTP ${t.httpStatus})${extra}`);
  }
}

/**
 * `trace.ingested` (S2-2): chặng ①–④ ở hub-api, phát in-process. Request bị chặn (REJECTED) hay
 * trùng (DUPLICATE) KHÔNG sinh event nên không bao giờ hiện trong bảng — dải này + toast cho thấy chúng.
 */
export function TraceFeed() {
  const traces = useRealtimeStore((s) => s.traces);
  // Tăng để chạy lại effect khi tới lượt xả phần toast đang dồn.
  const [flushTick, setFlushTick] = useState(0);

  useEffect(() => {
    // Mốc toast nằm trong store (không useRef): mount lại không toast lại trace cũ. Bị dội -> tối đa
    // 1 toast / 2s, kèm "+N" (review SPEC-2 #8, ADR-054).
    void flushTick;
    const { toastCursor } = useRealtimeStore.getState();
    const step = stepToasts(traces, toastCursor, Date.now());
    useRealtimeStore.setState({ toastCursor: step.cursor });
    if (step.toast) showTraceToast(step.toast.trace, step.toast.more);
    if (step.flushInMs === null) return;
    const t = setTimeout(() => setFlushTick((n) => n + 1), step.flushInMs);
    return () => clearTimeout(t);
  }, [traces, flushTick]);

  if (traces.length === 0) return null;

  return (
    <Card className="py-3">
      <CardContent className="space-y-1.5 px-4">
        <div className="flex items-center gap-2 text-muted-foreground text-xs">
          <Radio className="size-3.5" />
          Vừa nhận (trace.ingested, trực tiếp từ hub-api)
        </div>
        <ul className="space-y-1">
          {traces.slice(0, SHOW).map((t) => (
            <li key={`${t.correlationId}-${t.receivedAt}`} className="flex flex-wrap items-center gap-2 text-xs">
              <Badge variant="outline" className={`font-mono text-[11px] ${OUTCOME_STYLE[t.outcome]}`}>
                {t.outcome}
              </Badge>
              <span className="font-mono">{t.provider}</span>
              <span className="text-muted-foreground">{OUTCOME_LABEL[t.outcome]}</span>
              <span className="font-mono text-muted-foreground">
                HTTP {t.httpStatus} · {t.ms}ms
              </span>
              <span className="ml-auto text-muted-foreground">
                {new Date(t.receivedAt).toLocaleTimeString("vi-VN")}
              </span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
