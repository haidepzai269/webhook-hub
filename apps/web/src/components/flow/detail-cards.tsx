"use client";

import { type ReactNode, useState } from "react";

import type { FlowBranch, StageView } from "@hub/flow";
import { ChevronDown, ChevronRight, History, RotateCcw } from "lucide-react";

import { CopyButton } from "@/components/admin/copy-button";
import { deliveryStatusKey } from "@/components/admin/status-badge";
import type { DeliveryStatus } from "@/lib/hub/types";
import type { TranslateFn } from "@/lib/i18n/dictionary";
import { useLocale, useT } from "@/lib/i18n/use-t";

import { JsonViewer } from "./json-viewer";
import { HttpPill, StatusPill, TonePill } from "./pills";
import { destinationIcon, ICON_SM, STATUS_TONE, StatusGlyph, TONE_VAR, toneStyle } from "./tokens";
import { clock, countdown, fmtMs, fullDate, useNow } from "./time";

export function FlowCard({ title, right, children, className }: { title: ReactNode; right?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`flow-surface min-w-0 rounded-2xl ${className ?? ""}`}>
      <header className="flex items-center justify-between gap-2 px-4 pt-3.5 pb-2">
        <h2 className="font-semibold text-[15px]">{title}</h2>
        {right}
      </header>
      <div className="px-4 pb-4">{children}</div>
    </section>
  );
}

function Tabs<T extends string>({ value, onChange, items }: { value: T; onChange: (v: T) => void; items: { id: T; label: string; disabled?: boolean }[] }) {
  return (
    <div className="inline-flex rounded-lg border p-0.5" role="tablist">
      {items.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          aria-selected={value === t.id}
          disabled={t.disabled}
          onClick={() => onChange(t.id)}
          className={`rounded-md px-2.5 py-1 text-xs transition-colors disabled:opacity-40 ${value === t.id ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:text-foreground"}`}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

/** Card Payload: tab "Chuẩn hoá (data)" và "Gốc (raw)". Body > 16KB đã bị server cắt, có cờ. */
export function PayloadCard({ data, raw, rawTruncated, dataTruncated }: { data: unknown; raw: unknown; rawTruncated?: boolean; dataTruncated?: boolean }) {
  const t = useT();
  const hasData = data !== undefined && data !== null;
  const [tab, setTab] = useState<"data" | "raw">(hasData ? "data" : "raw");
  const value = tab === "data" ? data : raw;
  const truncated = tab === "data" ? dataTruncated : rawTruncated;
  return (
    <FlowCard
      title={t("flow.card.payload")}
      right={
        <div className="flex items-center gap-2">
          <Tabs
            value={tab}
            onChange={setTab}
            items={[
              { id: "data", label: t("flow.card.payload.normalized"), disabled: !hasData },
              { id: "raw", label: t("flow.card.payload.raw"), disabled: raw === undefined || raw === null },
            ]}
          />
          <CopyButton value={typeof value === "string" ? value : JSON.stringify(value, null, 2)} label={t("flow.card.payload.copy")} />
        </div>
      }
    >
      {truncated && (
        <p className="mb-2 text-xs" style={{ color: "var(--flow-warning)" }}>
          {t("flow.card.payload.truncated")}
        </p>
      )}
      {value === undefined || value === null ? (
        <p className="text-muted-foreground text-sm">{t("flow.card.no-data")}</p>
      ) : typeof value === "string" ? (
        <pre className="max-h-[26rem] overflow-auto rounded-lg border bg-muted/30 p-3 font-mono text-xs">{value}</pre>
      ) : (
        <JsonViewer value={value} />
      )}
    </FlowCard>
  );
}

const SENSITIVE = /^(authorization|cookie|set-cookie|x-api-key|apikey|x-.*-signature|webhook-signature|.*token.*|.*secret.*)$/i;

/** Card Headers: khoá–giá trị; header nhạy cảm (đã che ở server, ADR-051) hiện `***`. */
export function HeadersCard({ headers }: { headers: Record<string, unknown> | null | undefined }) {
  const t = useT();
  const entries = Object.entries(headers ?? {});
  return (
    <FlowCard title={t("flow.card.headers")} right={<CopyButton value={JSON.stringify(headers ?? {}, null, 2)} label={t("flow.card.headers.copy")} />}>
      {entries.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t("flow.card.headers.empty")}</p>
      ) : (
        <div className="max-h-[26rem] overflow-auto rounded-lg border">
          {entries.map(([k, v]) => {
            const text = typeof v === "string" ? v : JSON.stringify(v);
            const masked = /REDACTED/i.test(text) || SENSITIVE.test(k);
            return (
              <div key={k} className="border-b px-3 py-1.5 last:border-b-0">
                <div className="font-medium text-xs">{k}</div>
                <div className="break-all font-mono text-[11.5px] text-muted-foreground">{masked ? "***" : text}</div>
              </div>
            );
          })}
        </div>
      )}
    </FlowCard>
  );
}

function AttemptRow({ attempt }: { attempt: StageView }) {
  const t = useT();
  const [open, setOpen] = useState<"response" | "request" | null>(null);
  const d = attempt.detail ?? {};
  const http = d.httpStatus as number | null | undefined;
  const label = t(attempt.status === "ok" ? "flow.attempt.ok" : attempt.status === "in_progress" ? "flow.attempt.sending" : "flow.attempt.failed");
  return (
    <div className="rounded-lg border px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <span style={{ color: TONE_VAR[STATUS_TONE[attempt.status]] }}>
          <StatusGlyph status={attempt.status} />
        </span>
        <span className="font-medium text-sm">{t("flow.attempt.title", { no: String(d.attemptNo ?? "?") })}</span>
        <StatusPill status={attempt.status} label={label} />
        {attempt.status !== "in_progress" && <HttpPill status={http} />}
        {attempt.reason && <span className="truncate text-xs" style={{ color: TONE_VAR[STATUS_TONE[attempt.status]] }}>{attempt.reason.message}</span>}
        <div className="ml-auto flex items-center gap-3 text-muted-foreground text-xs tabular-nums">
          <span>{fmtMs(attempt.durationMs)}</span>
          <span>{clock(attempt.endedAt ?? attempt.startedAt)}</span>
          {(["response", "request"] as const).map((k) => (
            <button
              key={k}
              type="button"
              className="inline-flex items-center gap-0.5 hover:text-foreground"
              onClick={() => setOpen((o) => (o === k ? null : k))}
              aria-expanded={open === k}
            >
              {t(k === "response" ? "flow.attempt.response" : "flow.attempt.request")}
              {open === k ? <ChevronDown {...ICON_SM} /> : <ChevronRight {...ICON_SM} />}
            </button>
          ))}
        </div>
      </div>
      {open && (
        <div className="mt-2">
          {open === "response" ? (
            <pre className="max-h-60 overflow-auto rounded-md border bg-muted/30 p-2 font-mono text-[11.5px]">
              {String(d.response ?? d.error ?? t("flow.attempt.empty"))}
            </pre>
          ) : (
            <div className="space-y-1.5">
              {d.request !== null && d.request !== undefined ? (
                <JsonViewer value={d.request} maxHeight="16rem" />
              ) : (
                <p className="text-muted-foreground text-xs">{t("flow.attempt.no-body")}</p>
              )}
              {/* §6A "header gửi đi": delivery_attempts chỉ lưu body đã gửi, KHÔNG lưu header — không bịa lại. */}
              <p className="text-muted-foreground text-[11px]">{t("flow.attempt.headers-note")}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const DELIVERY_STATUSES = new Set(["PENDING", "DELIVERING", "RETRYING", "SUCCEEDED", "DEAD"]);
/** Trạng thái của lượt cũ: mã DeliveryStatus thì dịch, lạ thì giữ nguyên. */
function historyStatus(status: string, t: TranslateFn): string {
  return DELIVERY_STATUSES.has(status) ? t(deliveryStatusKey(status as DeliveryStatus)) : status;
}

/** Card Delivery Attempts: mỗi đích một nhóm, mỗi lần thử một dòng; lần chờ có đếm ngược. */
export function AttemptsCard({ branches, onReplay, replaying }: { branches: FlowBranch[]; onReplay: (b: FlowBranch) => void; replaying: string | null }) {
  const t = useT();
  const now = useNow(1000);
  const total = branches.reduce((a, b) => a + b.stages.filter((s) => s.id.includes(":attempt:")).length, 0);
  return (
    <FlowCard
      title={t("flow.attempts.title")}
      right={<span className="text-muted-foreground text-xs tabular-nums">{t("flow.attempts.total", { count: total })}</span>}
    >
      {branches.length === 0 && <p className="text-muted-foreground text-sm">{t("flow.attempts.empty")}</p>}
      <div className="space-y-4">
        {branches.map((b) => {
          const done = b.stages[b.stages.length - 1];
          const attempts = b.stages.filter((s) => s.id.includes(":attempt:"));
          const D = destinationIcon(b.destination.type);
          const nextAt = typeof done.detail?.nextAttemptAt === "string" ? (done.detail.nextAttemptAt as string) : null;
          const cd = countdown(nextAt, now, t("journey.due"));
          const due = nextAt !== null && Date.parse(nextAt) <= now;
          const canReplay = done.actions?.includes("replay_delivery");
          return (
            <div key={b.deliveryId} className="space-y-1.5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="flow-icon-box grid size-6 place-items-center rounded-md" style={toneStyle(STATUS_TONE[done.status])}>
                  <D size={14} strokeWidth={1.75} />
                </span>
                <span className="font-medium text-sm">{b.destination.name}</span>
                <StatusPill status={done.status} label={done.title} />
                <span className="text-muted-foreground text-xs">
                  {b.subscription.name} · {t("flow.attempts.gen", { gen: b.generation })}
                </span>
                {b.history.length > 0 && (
                  <TonePill tone="idle" icon={<History {...ICON_SM} aria-hidden />}>
                    {t("flow.attempts.history", {
                      count: b.history.length,
                      list: b.history.map((h) => `${t("flow.attempts.gen", { gen: h.generation })} ${historyStatus(h.status, t)}`).join(", "),
                    })}
                  </TonePill>
                )}
                {canReplay && (
                  <button
                    type="button"
                    disabled={replaying === b.deliveryId}
                    onClick={() => onReplay(b)}
                    className="flow-replay-btn ml-auto inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 font-medium text-xs disabled:opacity-60"
                  >
                    <RotateCcw {...ICON_SM} aria-hidden />
                    {t("flow.attempts.replay")}
                  </button>
                )}
              </div>
              {attempts.map((a) => (
                <AttemptRow key={a.id} attempt={a} />
              ))}
              {nextAt && (
                <div className="flex items-center gap-2 rounded-lg border border-dashed px-3 py-2 text-xs tabular-nums" style={{ color: TONE_VAR[STATUS_TONE[done.status]] }}>
                  <StatusGlyph status={done.status} small />
                  <span className="font-medium">{done.title}</span>
                  <span>
                    {due ? t("flow.attempts.retry-due") : t("flow.attempts.retry-in", { countdown: cd ?? "" })}
                    {typeof done.detail?.tier === "string" ? ` · ${t("flow.attempts.tier", { tier: done.detail.tier })}` : ""} ·{" "}
                    {t("flow.attempts.at", { time: clock(nextAt, false) })}
                  </span>
                  {done.reason && <span className="text-muted-foreground">· {done.reason.message}</span>}
                </div>
              )}
              {attempts.length === 0 && !nextAt && (
                <div className="rounded-lg border border-dashed px-3 py-2 text-muted-foreground text-xs">{done.title}</div>
              )}
            </div>
          );
        })}
      </div>
    </FlowCard>
  );
}

/** Waterfall: mỗi chặng một thanh trên trục thời gian từ lúc nhận — nhìn là biết chậm ở đâu. */
export function Waterfall({ stages, branches }: { stages: StageView[]; branches: FlowBranch[] }) {
  const t = useT();
  const locale = useLocale();
  const rows: { id: string; label: string; s: StageView }[] = [
    ...stages.map((s) => ({ id: s.id, label: s.title, s })),
    ...branches.flatMap((b) =>
      b.stages.filter((s) => s.id.includes(":attempt:")).map((s) => ({ id: s.id, label: `${b.destination.name} · ${s.title}`, s })),
    ),
  ];
  const origin = Math.min(...rows.map((r) => (r.s.startedAt ? Date.parse(r.s.startedAt) : Number.POSITIVE_INFINITY)));
  const end = Math.max(...rows.map((r) => (r.s.endedAt ? Date.parse(r.s.endedAt) : r.s.startedAt ? Date.parse(r.s.startedAt) : 0)));
  const span = Math.max(1, end - origin);
  if (!Number.isFinite(origin)) return null;
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-[10.5px] text-muted-foreground tabular-nums">
        <span>{fullDate(new Date(origin).toISOString(), locale)}</span>
        <span>{t("flow.waterfall.total", { ms: fmtMs(span) })}</span>
      </div>
      {rows.map((r) => {
        const st = r.s.startedAt ? Date.parse(r.s.startedAt) : origin;
        const en = r.s.endedAt ? Date.parse(r.s.endedAt) : st;
        const left = ((st - origin) / span) * 100;
        const width = Math.max(((en - st) / span) * 100, 0.4);
        const color = TONE_VAR[STATUS_TONE[r.s.status]];
        return (
          <div key={r.id} className="grid grid-cols-[minmax(9rem,16rem)_1fr_4.5rem] items-center gap-2 text-[11.5px]">
            <span className="inline-flex min-w-0 items-center gap-1" style={{ color }}>
              <StatusGlyph status={r.s.status} small />
              <span className="truncate text-foreground" title={r.label}>
                {r.label}
              </span>
            </span>
            <div className="relative h-3 rounded bg-muted/50">
              <div className="absolute top-0 h-3 rounded" style={{ left: `${left}%`, width: `${width}%`, minWidth: 3, background: color }} />
            </div>
            <span className="text-right text-muted-foreground tabular-nums">{fmtMs(r.s.durationMs)}</span>
          </div>
        );
      })}
    </div>
  );
}

