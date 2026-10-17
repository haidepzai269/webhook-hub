"use client";

import type { ReactNode } from "react";

import { DeliveryStatusBadge, toneTextClass } from "@/components/admin/status-badge";
import { SignatureBadge } from "@/components/flow/unverified-badge";
import { Badge } from "@/components/ui/badge";
import { formatDateTime, httpTone } from "@/lib/hub/format";
import type { HubEventDetail } from "@/lib/hub/types";
import { isUnverified, SIGNATURE_VIEW, signatureView } from "@/lib/hub/unverified";
import { useLocale, useT } from "@/lib/i18n/use-t";

import { RetryCountdown } from "../../deliveries/_components/delivery-columns";

type Tone = "ok" | "bad" | "warn" | "muted";

const DOT: Record<Tone, string> = {
  ok: "bg-emerald-500",
  bad: "bg-rose-500",
  warn: "bg-amber-500",
  muted: "bg-muted-foreground/40",
};

function Step({
  n,
  title,
  tone,
  time,
  children,
}: {
  n: string;
  title: string;
  tone: Tone;
  time?: string;
  children?: ReactNode;
}) {
  return (
    <li className="relative pb-4 pl-6 last:pb-0">
      <span className={`absolute top-1 left-[-5px] size-2.5 rounded-full ring-4 ring-background ${DOT[tone]}`} />
      <div className="flex flex-wrap items-baseline justify-between gap-x-2">
        <span className="font-medium text-sm">
          <span className="mr-1 text-muted-foreground">{n}</span>
          {title}
        </span>
        {time && <span className="font-mono text-2xs text-muted-foreground">{time}</span>}
      </div>
      {children && <div className="mt-1 space-y-1 text-xs">{children}</div>}
    </li>
  );
}

function fanoutTone(deliveries: HubEventDetail["deliveries"] & object): Tone {
  if (deliveries.length === 0) return "muted";
  if (deliveries.some((d) => d.status === "DEAD")) return "bad";
  if (deliveries.every((d) => d.status === "SUCCEEDED")) return "ok";
  return "warn";
}

/**
 * Dòng thời gian của MỘT webhook (S2-5): ① nhận → ② COMMIT + ACK → ③ chuẩn hoá → ④ toả ra N đích,
 * mỗi nhánh kèm từng lần thử. Dữ liệu từ `GET /api/v1/events/:id`; socket `delivery.attempt`
 * invalidate query ["event", …] nên các nhánh cập nhật trực tiếp.
 */
export function TraceTimeline({ ev }: { ev: HubEventDetail }) {
  const t = useT();
  const locale = useLocale();
  const raw = ev.rawEvent;
  // REVIEW-PK5-R2 TB-1b: nguồn `unverified` có signatureValid=true — trạng thái chữ ký phải đi qua isUnverified (event HOẶC raw).
  const sig = SIGNATURE_VIEW[signatureView(ev)];
  const unverified = isUnverified(ev) || isUnverified(raw);
  const deliveries = [...(ev.deliveries ?? [])].sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.attemptGeneration - b.attemptGeneration,
  );

  return (
    <ol className="ml-1.5 border-l">
      {raw ? (
        <>
          <Step
            n="①"
            title={t("page.events.trace.received")}
            tone={sig.tone}
            time={formatDateTime(raw.receivedAt, locale)}
          >
            <div className="flex flex-wrap gap-1.5">
              <SignatureBadge view={sig} title={unverified ? t("page.events.unverified-hint") : undefined} />
              <Badge variant="outline">{t("page.events.sheet.raw-status", { status: raw.status })}</Badge>
            </div>
          </Step>
          <Step n="②" title={t("page.events.trace.commit")} tone="ok">
            <p className="text-muted-foreground">{t("page.events.trace.commit-hint")}</p>
          </Step>
        </>
      ) : (
        <Step n="①" title={t("page.events.trace.no-raw", { origin: ev.origin })} tone="muted" />
      )}
      <Step n="③" title={t("page.events.trace.normalized")} tone="ok" time={formatDateTime(ev.receivedAt, locale)}>
        <p>
          <span className="font-mono">{ev.type}</span> <span className="text-muted-foreground">{t("page.events.trace.from-source", { source: ev.source })}</span>
        </p>
      </Step>
      <Step n="④" title={t("page.events.trace.fanout", { count: deliveries.length })} tone={fanoutTone(deliveries)}>
        {deliveries.length === 0 ? (
          <p className="text-muted-foreground">{t("page.events.trace.no-subscription")}</p>
        ) : (
          <ul className="mt-1 space-y-2">
            {deliveries.map((d) => {
              const dest = d.subscription?.destination;
              const attempts = [...(d.attempts ?? [])].sort((a, b) => a.attemptNo - b.attemptNo);
              return (
                <li key={d.id} className="rounded-md border p-2.5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium text-sm">
                      {dest?.name ?? d.subscription?.name ?? "—"}
                      {dest?.type && <span className="ml-1 text-muted-foreground text-xs">({dest.type})</span>}
                    </span>
                    <span className="flex items-center gap-2">
                      {d.attemptGeneration > 1 && (
                        <Badge size="sm" variant="outline" className="font-mono">
                          {t("page.events.trace.generation", { n: d.attemptGeneration })}
                        </Badge>
                      )}
                      <DeliveryStatusBadge status={d.status} />
                    </span>
                  </div>
                  {attempts.length === 0 ? (
                    <p className="mt-1 text-muted-foreground">{t("page.events.trace.no-attempts")}</p>
                  ) : (
                    <ol className="mt-1.5 space-y-0.5 font-mono text-2xs">
                      {attempts.map((a) => (
                        <li key={a.id} className="flex flex-wrap gap-x-2">
                          <span className="text-muted-foreground">#{a.attemptNo}</span>
                          <span className={toneTextClass(httpTone(a.responseStatus ?? 0))}>HTTP {a.responseStatus || "—"}</span>
                          <span>{a.durationMs ?? "—"}ms</span>
                          <span className="text-muted-foreground">{formatDateTime(a.createdAt, locale)}</span>
                          {a.error && <span className="basis-full break-all text-destructive">{a.error}</span>}
                        </li>
                      ))}
                    </ol>
                  )}
                  {(d.status === "RETRYING" || d.status === "PENDING") && d.nextAttemptAt && (
                    <div className="mt-1 flex items-center gap-1 text-muted-foreground">
                      {t("page.events.trace.retry-in")} <RetryCountdown iso={d.nextAttemptAt} />
                    </div>
                  )}
                  {d.status === "DEAD" && d.lastError && <p className="mt-1 break-all text-destructive">{d.lastError}</p>}
                </li>
              );
            })}
          </ul>
        )}
      </Step>
    </ol>
  );
}
