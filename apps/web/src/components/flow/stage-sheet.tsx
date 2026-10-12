"use client";

import { useState } from "react";

import type { FlowBranch, StageView } from "@hub/flow";

import { useT } from "@/lib/i18n/use-t";
import { AdminSheetContent } from "@/components/admin/overlay-content";
import { Sheet, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";

import { HeadersCard } from "./detail-cards";
import { JsonViewer } from "./json-viewer";
import { StatusPill } from "./pills";
import { clock, fmtMs } from "./time";

type Tab = "in" | "out" | "detail";

/**
 * Panel phải kiểu n8n khi bấm một node: "Vào" (header đã che, body đã cắt — chặng received/verified),
 * "Ra" (event chuẩn — chặng normalized), "Chi tiết" (mọi thứ server gửi cho chặng đó).
 */
export function StageSheet({ stage, branch, onClose }: { stage: StageView | null; branch?: FlowBranch; onClose: () => void }) {
  const t = useT();
  const [tab, setTab] = useState<Tab>("detail");
  const d = stage?.detail ?? {};
  const hasIn = stage?.key === "received" || stage?.key === "verified";
  const hasOut = stage?.key === "normalized" && d.data !== undefined;
  const effective: Tab = tab === "in" && !hasIn ? "detail" : tab === "out" && !hasOut ? "detail" : tab;

  return (
    <Sheet open={Boolean(stage)} onOpenChange={(o) => !o && onClose()}>
      <AdminSheetContent className="w-full gap-0 overflow-y-auto sm:max-w-xl">
        {stage && (
          <>
            <SheetHeader>
              <SheetTitle className="flex items-center gap-2">
                <span className="text-muted-foreground text-xs uppercase tracking-wide">{t(`flow.stage.${stage.key}`)}</span>
                <StatusPill status={stage.status} />
              </SheetTitle>
              <SheetDescription className="text-foreground text-sm">{stage.title}</SheetDescription>
              <p className="text-muted-foreground text-xs tabular-nums">
                {stage.endedAt
                  ? t("flow.sheet.ended", { time: clock(stage.endedAt) })
                  : stage.startedAt
                    ? t("flow.sheet.started", { time: clock(stage.startedAt) })
                    : t("flow.sheet.not-run")}
                {stage.durationMs !== null ? ` · ${fmtMs(stage.durationMs)}` : ""}
                {branch ? ` · ${branch.destination.name}` : ""}
              </p>
            </SheetHeader>
            <div className="space-y-4 px-4 pb-6">
              {stage.reason && (
                <div className="rounded-lg border px-3 py-2 text-sm" style={{ borderColor: "var(--flow-crashed)" }}>
                  <div className="font-mono text-xs" style={{ color: "var(--flow-crashed)" }}>
                    {stage.reason.code}
                  </div>
                  <div>{stage.reason.message}</div>
                </div>
              )}
              <div className="inline-flex rounded-lg border p-0.5" role="tablist">
                {(
                  [
                    ["in", t("flow.sheet.tab.in"), hasIn],
                    ["out", t("flow.sheet.tab.out"), hasOut],
                    ["detail", t("common.details"), true],
                  ] as const
                ).map(([id, label, enabled]) => (
                  <button
                    key={id}
                    type="button"
                    role="tab"
                    disabled={!enabled}
                    aria-selected={effective === id}
                    onClick={() => setTab(id)}
                    className={`rounded-md px-3 py-1 text-xs disabled:opacity-40 ${effective === id ? "bg-muted font-medium" : "text-muted-foreground"}`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              {effective === "in" && (
                <>
                  <HeadersCard headers={d.headers as Record<string, unknown> | null} />
                  <div className="space-y-1">
                    <h3 className="font-medium text-sm">{t(d.bodyTruncated ? "flow.sheet.body-truncated" : "flow.sheet.body")}</h3>
                    <JsonViewer value={d.body ?? null} maxHeight="20rem" />
                  </div>
                </>
              )}
              {effective === "out" && (
                <div className="space-y-1">
                  <h3 className="font-medium text-sm">
                    {t(d.normalized ? "flow.sheet.normalized-catalog" : "flow.sheet.normalized-raw")}
                  </h3>
                  <JsonViewer value={d.data ?? null} maxHeight="24rem" />
                </div>
              )}
              {effective === "detail" && (
                <JsonViewer
                  value={Object.fromEntries(Object.entries(d).filter(([k]) => !["headers", "body", "data"].includes(k)))}
                  maxHeight="28rem"
                />
              )}
            </div>
          </>
        )}
      </AdminSheetContent>
    </Sheet>
  );
}
