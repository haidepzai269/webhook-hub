"use client";

import { useState } from "react";

import { RotateCcw, TriangleAlert } from "lucide-react";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useOrphanRawEvents, useRenormalizeRawEvents } from "@/lib/hub/queries";
import { useT } from "@/lib/i18n/use-t";

/**
 * S1-3: dải cảnh báo "N sự kiện thô chưa được chuẩn hoá". Nguồn là Postgres (raw_events ACCEPTED
 * không sinh event nào), không phải DLQ của RabbitMQ. Ẩn khi N = 0.
 */
export function OrphanBanner() {
  const t = useT();
  const { data } = useOrphanRawEvents();
  const renormalize = useRenormalizeRawEvents();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");

  const total = data?.total ?? 0;
  if (total === 0) return null;

  const submit = () => {
    renormalize.mutate(
      { reason: reason.trim() },
      {
        onSuccess: (res) => {
          toast.success(t("page.events.orphan.queued", { count: res.queued }), {
            description: t("page.events.orphan.queued-hint"),
          });
          setOpen(false);
          setReason("");
        },
        onError: (e) => toast.error(t("page.events.orphan.failed", { message: e.message })),
      },
    );
  };

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm">
        <div className="flex items-center gap-2">
          <TriangleAlert className="size-4 text-amber-600" />
          <span>
            <span className="font-medium">{total}</span> {t("page.events.orphan.banner")}
          </span>
        </div>
        <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
          <RotateCcw />
          {t("page.events.orphan.action")}
        </Button>
      </div>

      <AlertDialog open={open} onOpenChange={(o) => !renormalize.isPending && setOpen(o)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("page.events.orphan.confirm-title", { count: Math.min(total, 500) })}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("page.events.orphan.confirm-before")} <span className="font-mono">event.received</span>{" "}
              {t("page.events.orphan.confirm-after")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Textarea
            placeholder={t("page.events.orphan.reason-placeholder")}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <AlertDialogFooter>
            <AlertDialogCancel disabled={renormalize.isPending}>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              disabled={renormalize.isPending || reason.trim() === ""}
              onClick={(e) => {
                e.preventDefault();
                submit();
              }}
            >
              {renormalize.isPending ? t("page.events.orphan.queuing") : t("page.events.orphan.action")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
