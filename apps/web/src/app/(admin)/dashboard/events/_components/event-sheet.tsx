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
  const { data: ev, isLoading, error } = useEventDetail(eventId);

  return (
    <Sheet open={open && Boolean(eventId)} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full gap-0 overflow-y-auto sm:max-w-xl">
        <SheetHeader>
          <SheetTitle className="font-mono text-base">{ev?.type ?? "Chi tiết sự kiện"}</SheetTitle>
          <SheetDescription>
            Sự kiện đã chuẩn hoá + dấu vết từ lúc nhận tới từng đích (cập nhật trực tiếp).
          </SheetDescription>
          {eventId && (
            <Button asChild size="sm" variant="outline" className="mt-1 w-fit">
              <Link href={`/dashboard/events/${encodeURIComponent(eventId)}`}>
                <Route />
                Mở hành trình đầy đủ
              </Link>
            </Button>
          )}
        </SheetHeader>

        <div className="space-y-5 px-4 pb-6">
          {isLoading ? (
            <Skeleton className="h-64 w-full" />
          ) : error ? (
            <p className="text-destructive text-sm">Không tải được: {error.message}</p>
          ) : !ev ? (
            <p className="text-muted-foreground text-sm">Không tìm thấy sự kiện (có thể thuộc tenant khác).</p>
          ) : (
            <>
              <section className="space-y-1.5">
                <Row label="Event ID" value={ev.id} copy />
                <Row label="Correlation" value={ev.correlationId} copy />
                <Row label="Nguồn" value={ev.source} />
                <Row label="Origin" value={ev.origin} />
                {ev.subject && <Row label="Subject" value={ev.subject} />}
                <Row label="Xảy ra lúc" value={formatDateTime(ev.occurredAt)} />
                <Row label="Hub nhận lúc" value={formatDateTime(ev.receivedAt)} />
                {ev.rawEvent && (
                  <div className="flex flex-wrap gap-2 pt-1">
                    <Badge variant={ev.rawEvent.signatureValid ? "secondary" : "destructive"}>
                      Chữ ký {ev.rawEvent.signatureValid ? "hợp lệ" : "KHÔNG hợp lệ"}
                    </Badge>
                    <Badge variant="outline">raw: {ev.rawEvent.status}</Badge>
                  </div>
                )}
              </section>

              <Separator />
              <section className="space-y-2">
                <h3 className="font-medium text-sm">Payload chuẩn hoá (data)</h3>
                <JsonBlock value={ev.data} />
              </section>

              {ev.rawEvent && (
                <section className="space-y-2">
                  <h3 className="font-medium text-sm">Header gốc từ provider</h3>
                  <JsonBlock value={ev.rawEvent.headers} maxHeight="14rem" />
                </section>
              )}

              <Separator />
              <section className="space-y-2">
                <h3 className="font-medium text-sm">Dấu vết</h3>
                <TraceTimeline ev={ev} />
              </section>
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
