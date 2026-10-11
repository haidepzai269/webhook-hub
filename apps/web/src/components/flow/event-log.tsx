"use client";

import { type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ChevronDown, ChevronUp, Pause, Play, Search, Terminal } from "lucide-react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useExecutions } from "@/lib/hub/queries";

import { EXECUTION_LABEL, EXECUTION_TONE, FailedAt, failedAtText, MiniPipeline } from "./execution-bits";
import {
  clampLogHeight,
  LOG_COLUMNS,
  logGridTemplate,
  logHeightAria,
  readLogHeight,
  stepLogHeight,
  writeLogHeight,
} from "./log-layout";
import { ProviderIcon } from "./provider-icon";
import { ICON, TONE_VAR } from "./tokens";

/** localStorage có thể ném (chế độ riêng tư, site data bị chặn) → null, trang vẫn chạy. */
function viewerStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

const GRID_TEMPLATE = logGridTemplate();

function time(iso: string) {
  const d = new Date(iso);
  return `${d.toLocaleTimeString("vi-VN", { hour12: false })}.${String(d.getMilliseconds()).padStart(3, "0")}`;
}

/**
 * Nhật ký sự kiện trực tiếp (SPEC §0A.C): ngăn dưới kiểu console trên V3. Mỗi dòng = một hành trình
 * rút gọn (cùng `/flow/executions` với V2), màu theo kết quả, bấm → V1. Cập nhật bằng invalidate
 * socket (không tự ghép trạng thái); "Tạm dừng" ngừng nhận dòng mới để đọc.
 * Kéo mép trên để đổi chiều cao (25%–85% viewport, nhớ theo người xem); lưới cột cố định (log-layout.ts).
 */
export function EventLog() {
  const [open, setOpen] = useState(true);
  const [paused, setPaused] = useState(false);
  const [q, setQ] = useState("");
  const { data, isLoading } = useExecutions({}, { paused });
  const [height, setHeight] = useState<number | null>(null);
  const heightRef = useRef<number | null>(null);
  heightRef.current = height;
  const drag = useRef<{ startY: number; startH: number } | null>(null);
  const [viewportH, setViewportH] = useState<number | null>(null);

  // Đọc chiều cao đã nhớ sau khi mount (tránh lệch hydrate); viewport đổi → kẹp lại trong 25–85%.
  useEffect(() => {
    setHeight(readLogHeight(viewerStorage(), window.innerHeight));
    setViewportH(window.innerHeight);
    const onResize = () => {
      setViewportH(window.innerHeight);
      setHeight((h) => (h === null ? h : clampLogHeight(h, window.innerHeight)));
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const onDragStart = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { startY: e.clientY, startH: heightRef.current ?? window.innerHeight * 0.25 };
    setOpen(true);
  }, []);
  const onDragMove = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    setHeight(clampLogHeight(d.startH + (d.startY - e.clientY), window.innerHeight));
  }, []);
  const onDragEnd = useCallback(() => {
    if (!drag.current) return;
    drag.current = null;
    if (heightRef.current !== null) writeLogHeight(viewerStorage(), heightRef.current);
  }, []);
  /** Bàn phím (L-B3): ↑/↓ 5% viewport, Home/End = min/max; nhớ ngay như khi thả chuột. */
  const onResizeKey = useCallback((e: ReactKeyboardEvent<HTMLDivElement>) => {
    const vh = window.innerHeight;
    const next = stepLogHeight(heightRef.current ?? vh * 0.25, e.key, vh);
    if (next === null) return;
    e.preventDefault();
    setOpen(true);
    setHeight(next);
    writeLogHeight(viewerStorage(), next);
  }, []);
  const aria = height !== null && viewportH ? logHeightAria(height, viewportH) : null;
  const items = useMemo(() => {
    const all = data?.pages.flatMap((p) => p.items) ?? [];
    const needle = q.trim().toLowerCase();
    const rows = needle
      ? all.filter((i) => [i.type, i.provider, i.sourceName, i.subject, i.id].some((v) => v?.toLowerCase().includes(needle)))
      : all;
    return rows.slice(0, 60);
  }, [data, q]);

  return (
    <div
      className="flow-surface relative flex min-h-0 shrink-0 flex-col overflow-hidden rounded-xl"
      style={open ? { height: height ?? "25svh" } : undefined}
    >
      {/* Tay kéo mép trên: hover hiện con trỏ row-resize + vạch nhỏ. */}
      {/* biome-ignore lint/a11y/useSemanticElements: <hr> không nhận pointer kéo; separator ngang là vai trò đúng */}
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label="Kéo để đổi chiều cao nhật ký"
        aria-valuenow={aria?.now}
        aria-valuemin={aria?.min}
        aria-valuemax={aria?.max}
        aria-valuetext={aria ? `${aria.now}% chiều cao màn hình` : undefined}
        tabIndex={0}
        title="Kéo (hoặc ↑/↓) để đổi chiều cao"
        className="flow-log-resizer absolute inset-x-0 top-0 z-10 h-2 cursor-row-resize touch-none"
        onPointerDown={onDragStart}
        onPointerMove={onDragMove}
        onPointerUp={onDragEnd}
        onPointerCancel={onDragEnd}
        onKeyDown={onResizeKey}
      />
      <div className="flex shrink-0 items-center gap-2 border-b px-3 py-1.5" style={{ borderColor: "var(--flow-card-border)" }}>
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
        <div className="min-h-0 flex-1 overflow-y-auto font-mono text-[12px]">
          <div
            className="sticky top-0 z-[1] grid items-center gap-3 border-b border-l-2 border-l-transparent px-3 py-1 font-sans text-[11px] text-muted-foreground uppercase tracking-wide"
            style={{ gridTemplateColumns: GRID_TEMPLATE, borderBottomColor: "var(--flow-card-border)", background: "var(--flow-card-solid)" }}
          >
            {LOG_COLUMNS.map((c) => (
              <span key={c.key} className="truncate">
                {c.label}
              </span>
            ))}
          </div>
          {isLoading && <div className="px-3 py-2 text-muted-foreground">Đang tải…</div>}
          {!isLoading && items.length === 0 && <div className="px-3 py-2 text-muted-foreground">Chưa có hành trình nào.</div>}
          {items.map((i) => {
            const color = TONE_VAR[EXECUTION_TONE[i.status]];
            return (
              <Link
                key={i.id}
                href={`/dashboard/events/${encodeURIComponent(i.id)}`}
                className="grid items-center gap-3 border-l-2 px-3 py-1 hover:bg-muted/50"
                style={{ gridTemplateColumns: GRID_TEMPLATE, borderLeftColor: color }}
              >
                <span className="truncate text-muted-foreground tabular-nums">{time(i.receivedAt)}</span>
                <span className="flex min-w-0 items-center gap-1.5" title={i.providerLabel}>
                  <span className="shrink-0 text-muted-foreground">
                    <ProviderIcon provider={i.provider} size={14} />
                  </span>
                  <span className="truncate">{i.providerLabel}</span>
                </span>
                <span className="min-w-0 overflow-hidden">
                  <MiniPipeline summary={i.summary} />
                </span>
                <span className="truncate" title={i.type ?? EXECUTION_LABEL[i.status]}>
                  {i.type ?? <span style={{ color }}>{EXECUTION_LABEL[i.status]}</span>}
                </span>
                <span className="min-w-0 truncate" title={failedAtText(i.failedAt) ?? EXECUTION_LABEL[i.status]}>
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
