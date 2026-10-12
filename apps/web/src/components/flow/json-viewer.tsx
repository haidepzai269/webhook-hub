"use client";

import { type ReactNode, useMemo, useState } from "react";

import { ChevronDown, ChevronRight } from "lucide-react";

import { useT } from "@/lib/i18n/use-t";

import { ICON_SM } from "./tokens";

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

/**
 * JSON viewer kiểu ảnh mẫu: tô màu cú pháp, gập/mở từng khối (`{ 8 props }`), số dòng.
 * Mỗi dòng hiển thị là một <div> để đếm số dòng thật sau khi gập.
 */
export function JsonViewer({ value, maxHeight = "26rem" }: { value: unknown; maxHeight?: string }) {
  const t = useT();
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const toggle = (path: string) =>
    setCollapsed((s) => {
      const n = new Set(s);
      if (n.has(path)) n.delete(path);
      else n.add(path);
      return n;
    });

  const lines = useMemo(() => {
    const out: ReactNode[] = [];
    const pad = (d: number) => <span className="inline-block" style={{ width: d * 14 }} />;
    const prim = (v: Json) => {
      if (typeof v === "string") return <span className="json-string">{JSON.stringify(v)}</span>;
      if (typeof v === "number") return <span className="json-number">{v}</span>;
      return <span className="json-literal">{String(v)}</span>;
    };
    const walk = (v: Json, depth: number, path: string, key: string | null, last: boolean) => {
      const k = key !== null ? (
        <>
          <span className="json-key">{JSON.stringify(key)}</span>
          <span className="text-muted-foreground">: </span>
        </>
      ) : null;
      const comma = last ? null : <span className="text-muted-foreground">,</span>;
      if (v !== null && typeof v === "object") {
        const isArr = Array.isArray(v);
        const entries: [string | null, Json][] = isArr ? (v as Json[]).map((x) => [null, x]) : Object.entries(v as Record<string, Json>);
        const open = isArr ? "[" : "{";
        const close = isArr ? "]" : "}";
        const isCollapsed = collapsed.has(path);
        const count = t(isArr ? "journey.json.items" : "journey.json.props", { n: entries.length });
        out.push(
          <div key={`${path}:open`} className="flex items-center">
            {pad(depth)}
            <button
              type="button"
              onClick={() => toggle(path)}
              className="-ml-3.5 mr-0.5 inline-flex size-3.5 items-center justify-center text-muted-foreground hover:text-foreground"
              aria-label={isCollapsed ? t("journey.json.expand") : t("journey.json.collapse")}
            >
              {isCollapsed ? <ChevronRight {...ICON_SM} /> : <ChevronDown {...ICON_SM} />}
            </button>
            {k}
            <span className="text-muted-foreground">{open}</span>
            {isCollapsed ? (
              <>
                <span className="mx-1 rounded bg-muted px-1 text-[10px] text-muted-foreground">{count}</span>
                <span className="text-muted-foreground">{close}</span>
                {comma}
              </>
            ) : (
              <span className="ml-1.5 text-[10px] text-muted-foreground/70">{count}</span>
            )}
          </div>,
        );
        if (!isCollapsed) {
          entries.forEach(([ck, cv], i) => walk(cv, depth + 1, `${path}.${ck ?? i}`, ck, i === entries.length - 1));
          out.push(
            <div key={`${path}:close`}>
              {pad(depth)}
              <span className="text-muted-foreground">{close}</span>
              {comma}
            </div>,
          );
        }
        return;
      }
      out.push(
        <div key={path} className="break-all">
          {pad(depth)}
          {k}
          {prim(v)}
          {comma}
        </div>,
      );
    };
    walk((value ?? null) as Json, 0, "$", null, true);
    return out;
  }, [value, collapsed, t]);

  return (
    <div className="overflow-auto rounded-lg border bg-muted/30 font-mono text-xs leading-5" style={{ maxHeight }}>
      <div className="grid grid-cols-[auto_1fr]">
        <div className="select-none border-r bg-muted/40 px-2 text-right text-muted-foreground/60 tabular-nums">
          {lines.map((_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: số dòng
            <div key={i}>{i + 1}</div>
          ))}
        </div>
        <div className="min-w-0 py-0 pr-3 pl-5">{lines}</div>
      </div>
    </div>
  );
}
