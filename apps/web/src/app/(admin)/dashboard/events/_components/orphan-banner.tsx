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

/**
 * S1-3: dải cảnh báo "N sự kiện thô chưa được chuẩn hoá". Nguồn là Postgres (raw_events ACCEPTED
 * không sinh event nào), không phải DLQ của RabbitMQ. Ẩn khi N = 0.
 */
export function OrphanBanner() {
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
          toast.success(`Đã xếp ${res.queued} sự kiện thô vào hàng chuẩn hoá lại`, {
            description: "Worker xử lý qua outbox như lần đầu. Danh sách sẽ tự làm mới.",
          });
          setOpen(false);
          setReason("");
        },
        onError: (e) => toast.error(`Chuẩn hoá lại thất bại: ${e.message}`),
      },
    );
  };

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm">
        <div className="flex items-center gap-2">
          <TriangleAlert className="size-4 text-amber-600" />
          <span>
            <span className="font-medium">{total}</span> sự kiện thô chưa được chuẩn hoá (đã nhận và lưu, nhưng chưa
            sinh event).
          </span>
        </div>
        <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
          <RotateCcw />
          Chuẩn hoá lại
        </Button>
      </div>

      <AlertDialog open={open} onOpenChange={(o) => !renormalize.isPending && setOpen(o)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Chuẩn hoá lại {Math.min(total, 500)} sự kiện thô?</AlertDialogTitle>
            <AlertDialogDescription>
              Hub ghi lại outbox <span className="font-mono">event.received</span> cho từng raw event mồ côi (tối đa 500
              mỗi lần). Hành động được ghi vào audit log kèm lý do.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Textarea
            placeholder="Lý do (bắt buộc), vd: Postgres chập chờn lúc 10:05"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <AlertDialogFooter>
            <AlertDialogCancel disabled={renormalize.isPending}>Huỷ</AlertDialogCancel>
            <AlertDialogAction
              disabled={renormalize.isPending || reason.trim() === ""}
              onClick={(e) => {
                e.preventDefault();
                submit();
              }}
            >
              {renormalize.isPending ? "Đang xếp hàng…" : "Chuẩn hoá lại"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
