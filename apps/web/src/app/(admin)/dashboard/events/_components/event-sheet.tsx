"use client";

import { Route } from "lucide-react";
import Link from "next/link";

import { CopyButton, JsonBlock } from "@/components/admin/copy-button";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDateTime } from "@/lib/hub/format";
import { useEventDetail } from "@/lib/hub/queries";
import { useLocale, useT } from "@/lib/i18n/use-t";

import { TraceTimeline } from "./trace-timeline";

function Row({ label, value, copy }: { label: string; value: string; copy?: boolean }) {
  return (
    <div className="grid grid-cols-[7rem_1fr] items-center gap-2 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="flex min-w-0 items-center gap-1">
        <span className="truncate font-mono text-xs" title={value}>
          {value}
        </span>
        {copy && <CopyButton value={value} />}
      </span>
    </div>
  );
}

export function EventSheet({ eventId, open, onClose }: { eventId: string | null; open: boolean; onClose: () => void }) {
  const t = useT();
  const locale = useLocale();
  const { data: ev, isLoading, error } = useEventDetail(eventId);

  return (
    <Sheet open={open && Boolean(eventId)} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full gap-0 overflow-y-auto sm:max-w-xl">
        <SheetHeader>
          <SheetTitle className="font-mono text-base">{ev?.type ?? t("page.events.sheet.title")}</SheetTitle>
          <SheetDescription>
            {t("page.events.sheet.description")}
          </SheetDescription>
          {eventId && (
            <Button asChild size="sm" variant="outline" className="mt-1 w-fit">
              <Link href={`/dashboard/events/${encodeURIComponent(eventId)}`}>
                <Route />
                {t("page.events.sheet.open-journey")}
              </Link>
            </Button>
          )}
        </SheetHeader>

        <div className="space-y-5 px-4 pb-6">
          {isLoading ? (
            <Skeleton className="h-64 w-full" />
          ) : error ? (
            <p className="text-destructive text-sm">{t("page.events.load-error", { message: error.message })}</p>
          ) : !ev ? (
            <p className="text-muted-foreground text-sm">{t("page.events.sheet.not-found")}</p>
          ) : (
            <>
              <section className="space-y-1.5">
                <Row label={t("page.events.sheet.event-id")} value={ev.id} copy />
                <Row label={t("page.events.sheet.correlation")} value={ev.correlationId} copy />
                <Row label={t("page.events.table.source")} value={ev.source} />
                <Row label={t("page.events.table.origin")} value={ev.origin} />
                {ev.subject && <Row label={t("page.events.table.subject")} value={ev.subject} />}
                <Row label={t("page.events.sheet.occurred-at")} value={formatDateTime(ev.occurredAt, locale)} />
                <Row label={t("page.events.sheet.received-at")} value={formatDateTime(ev.receivedAt, locale)} />
                {ev.rawEvent && (
                  <div className="flex flex-wrap gap-2 pt-1">
                    <Badge variant={ev.rawEvent.signatureValid ? "secondary" : "destructive"}>
                      {ev.rawEvent.signatureValid
                        ? t("page.events.sheet.signature-valid")
                        : t("page.events.sheet.signature-invalid")}
                    </Badge>
                    <Badge variant="outline">{t("page.events.sheet.raw-status", { status: ev.rawEvent.status })}</Badge>
                  </div>
                )}
              </section>

              <Separator />
              <section className="space-y-2">
                <h3 className="font-medium text-sm">{t("page.events.sheet.data")}</h3>
                <JsonBlock value={ev.data} />
              </section>

              {ev.rawEvent && (
                <section className="space-y-2">
                  <h3 className="font-medium text-sm">{t("page.events.sheet.headers")}</h3>
                  <JsonBlock value={ev.rawEvent.headers} maxHeight="14rem" />
                </section>
              )}

              <Separator />
              <section className="space-y-2">
                <h3 className="font-medium text-sm">{t("page.events.sheet.trace")}</h3>
                <TraceTimeline ev={ev} />
              </section>
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
