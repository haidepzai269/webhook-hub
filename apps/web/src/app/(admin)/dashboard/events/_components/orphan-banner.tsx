"use client";

import { useState } from "react";

import { RotateCcw, TriangleAlert } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ConfirmDialog } from "@/components/admin/confirm-dialog";
import { useOrphanRawEvents, useRenormalizeRawEvents } from "@/lib/hub/queries";
import { useT } from "@/lib/i18n/use-t";
import { Alert, AlertAction, AlertDescription, } from "@/components/ui/alert";

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
      <Alert variant="warning" className="mb-4 has-data-[slot=alert-action]:pr-44">
        <TriangleAlert />
        <AlertDescription>
          <span>
            <span className="font-medium">{total}</span> {t("page.events.orphan.banner")}
          </span>
        </AlertDescription>
        <AlertAction className="top-1/2 -translate-y-1/2">
          <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
            <RotateCcw />
            {t("page.events.orphan.action")}
          </Button>
        </AlertAction>
      </Alert>

      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={t("page.events.orphan.confirm-title", { count: Math.min(total, 500) })}
        description={
          <>
            {t("page.events.orphan.confirm-before")} <span className="font-mono">event.received</span> {t("page.events.orphan.confirm-after")}
          </>
        }
        confirmLabel={renormalize.isPending ? t("page.events.orphan.queuing") : t("page.events.orphan.action")}
        pending={renormalize.isPending}
        confirmDisabled={reason.trim() === ""}
        onConfirm={submit}
      >
        <Textarea
          placeholder={t("page.events.orphan.reason-placeholder")}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </ConfirmDialog>
    </>
  );
}
