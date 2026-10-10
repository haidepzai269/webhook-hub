"use client";

import { useMemo, useState } from "react";

import { ChevronDown, ChevronUp, Pause, Play, Search, Terminal } from "lucide-react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useExecutions } from "@/lib/hub/queries";

import { EXECUTION_LABEL, EXECUTION_TONE, FailedAt, MiniPipeline } from "./execution-bits";
import { ProviderIcon } from "./provider-icon";
import { ICON, TONE_VAR } from "./tokens";

function time(iso: string) {
  const d = new Date(iso);
  return `${d.toLocaleTimeString("vi-VN", { hour12: false })}.${String(d.getMilliseconds()).padStart(3, "0")}`;
}

/**
 * Nhật ký sự kiện trực tiếp (SPEC §0A.C): ngăn dưới kiểu console trên V3. Mỗi dòng = một hành trình
 * rút gọn (cùng `/flow/executions` với V2), màu theo kết quả, bấm → V1. Cập nhật bằng invalidate
 * socket (không tự ghép trạng thái); "Tạm dừng" ngừng nhận dòng mới để đọc.
 */
export function EventLog() {
  const [open, setOpen] = useState(true);
  const [paused, setPaused] = useState(false);
  const [q, setQ] = useState("");
  const { data, isLoading } = useExecutions({}, { paused });
  const items = useMemo(() => {
    const all = data?.pages.flatMap((p) => p.items) ?? [];
    const needle = q.trim().toLowerCase();
    const rows = needle
      ? all.filter((i) => [i.type, i.provider, i.sourceName, i.subject, i.id].some((v) => v?.toLowerCase().includes(needle)))
      : all;
    return rows.slice(0, 60);
  }, [data, q]);

  return (
    <div className="flow-surface flex min-h-0 flex-col overflow-hidden rounded-xl">
      <div className="flex items-center gap-2 border-b px-3 py-1.5" style={{ borderColor: "var(--flow-card-border)" }}>
        <Terminal {...ICON} className="text-muted-foreground" aria-hidden />
        <span className="font-medium text-sm">Nhật ký sự kiện</span>
        <span className="text-muted-foreground text-xs">{paused ? "đã tạm dừng" : "trực tiếp"}</span>
        <div className="ml-auto flex items-center gap-1.5">
          {open && (
            <div className="relative">
              <Search size={14} strokeWidth={1.75} className="-translate-y-1/2 absolute top-1/2 left-2 text-muted-foreground" aria-hidden />
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Lọc type, provider, id…" className="h-7 w-52 pl-7 text-xs" />
            </div>
          )}
          <Button variant="ghost" size="sm" onClick={() => setPaused((p) => !p)} aria-pressed={paused}>
            {paused ? <Play {...ICON} /> : <Pause {...ICON} />}
            {paused ? "Tiếp tục" : "Tạm dừng"}
          </Button>
          <Button variant="ghost" size="icon-sm" onClick={() => setOpen((o) => !o)} aria-label={open ? "Thu gọn" : "Mở rộng"}>
            {open ? <ChevronDown {...ICON} /> : <ChevronUp {...ICON} />}
          </Button>
        </div>
      </div>
      {open && (
        <div className="max-h-32 min-h-20 overflow-y-auto font-mono text-[12px]">
          {isLoading && <div className="px-3 py-2 text-muted-foreground">Đang tải…</div>}
          {!isLoading && items.length === 0 && <div className="px-3 py-2 text-muted-foreground">Chưa có hành trình nào.</div>}
          {items.map((i) => {
            const color = TONE_VAR[EXECUTION_TONE[i.status]];
            return (
              <Link
                key={i.id}
                href={`/dashboard/events/${encodeURIComponent(i.id)}`}
                className="grid grid-cols-[6.5rem_6.5rem_auto_minmax(8rem,14rem)_1fr] items-center gap-3 border-l-2 px-3 py-1 hover:bg-muted/50"
                style={{ borderLeftColor: color }}
              >
                <span className="text-muted-foreground tabular-nums">{time(i.receivedAt)}</span>
                <span className="inline-flex items-center gap-1.5 truncate">
                  <span className="text-muted-foreground">
                    <ProviderIcon provider={i.provider} size={14} />
                  </span>
                  {i.providerLabel}
                </span>
                <MiniPipeline summary={i.summary} />
                <span className="truncate" title={i.type ?? undefined}>
                  {i.type ?? <span style={{ color }}>{EXECUTION_LABEL[i.status]}</span>}
                </span>
                <span className="min-w-0">
                  {i.failedAt ? (
                    <FailedAt failedAt={i.failedAt} status={i.status} />
                  ) : (
                    <span style={{ color }} className="font-sans text-xs">
                      {EXECUTION_LABEL[i.status]}
                    </span>
                  )}
                </span>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
