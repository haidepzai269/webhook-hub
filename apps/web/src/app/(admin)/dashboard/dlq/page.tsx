"use client";

import { useMemo, useState } from "react";

import { Eye, ListRestart, RotateCcw } from "lucide-react";
import { toast } from "sonner";

import { DataTable, type HubColumn } from "@/components/admin/data-table";
import { PageHeader } from "@/components/admin/page-header";
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { HubApiError } from "@/lib/hub/client";
import { formatDateTime, shortId } from "@/lib/hub/format";
import { useDestinations, useDlq, useReplayBulk, useReplayDelivery } from "@/lib/hub/queries";
import type { Delivery, ReplayBulkResult } from "@/lib/hub/types";

import { deliveryColumns } from "../deliveries/_components/delivery-columns";

const ALL = "__all__";
const REASON_MIN = 5;

/** `datetime-local` (giờ máy người dùng) -> ISO; rỗng -> undefined. */
function toIso(local: string): string | undefined {
  if (!local) return undefined;
  const d = new Date(local);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

function BulkReplayDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const destinations = useDestinations();
  const bulk = useReplayBulk();
  const [destinationId, setDestinationId] = useState(ALL);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [errorContains, setErrorContains] = useState("");
  const [reason, setReason] = useState("");
  const [preview, setPreview] = useState<Extract<ReplayBulkResult, { dryRun: true }> | null>(null);

  const filter = {
    destinationId: destinationId === ALL ? undefined : destinationId,
    from: toIso(from),
    to: toIso(to),
    errorContains: errorContains.trim() || undefined,
  };
  const reasonOk = reason.trim().length >= REASON_MIN;
  const destName = (id: string) => destinations.data?.find((d) => d.id === id)?.name ?? shortId(id);

  // Đổi bộ lọc thì bản xem trước không còn đúng -> bắt xem trước lại.
  const resetPreview = () => setPreview(null);

  const close = (o: boolean) => {
    if (bulk.isPending) return;
    onOpenChange(o);
    if (!o) {
      setPreview(null);
      setReason("");
    }
  };

  const runPreview = () =>
    bulk.mutate(
      { ...filter, reason: reason.trim(), dryRun: true },
      {
        onSuccess: (res) => res.dryRun && setPreview(res),
        onError: (e) => toast.error(`Xem trước thất bại: ${e.message}`),
      },
    );

  const runReplay = () =>
    bulk.mutate(
      { ...filter, reason: reason.trim(), dryRun: false },
      {
        onSuccess: (res) => {
          toast.success(`Đã replay ${res.count} delivery`, {
            description: "Tất cả delivery mới + outbox + 1 dòng audit được ghi trong MỘT transaction.",
          });
          close(false);
        },
        onError: (e) =>
          e instanceof HubApiError && e.status === 409
            ? toast.info(e.message, { description: "Không có gì được ghi. Xem trước lại rồi thử lần nữa." })
            : toast.error(`Replay thất bại: ${e.message}`),
        onSettled: () => setPreview(null),
      },
    );

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Replay hàng loạt</DialogTitle>
          <DialogDescription>
            Chọn delivery DEAD chưa bị replay theo bộ lọc (tối đa 500). Mỗi cái được tạo lại ở generation mới; lịch sử
            thất bại giữ nguyên.
          </DialogDescription>
        </DialogHeader>
        <FieldGroup className="gap-4">
          <Field className="gap-1.5">
            <FieldLabel>Đích</FieldLabel>
            <Select
              value={destinationId}
              onValueChange={(v) => {
                setDestinationId(v);
                resetPreview();
              }}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>Tất cả đích</SelectItem>
                {(destinations.data ?? []).map((d) => (
                  <SelectItem key={d.id} value={d.id}>
                    {d.name} · {d.type}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field className="gap-1.5">
              <FieldLabel htmlFor="bulk-from">Từ</FieldLabel>
              <Input
                id="bulk-from"
                type="datetime-local"
                value={from}
                onChange={(e) => {
                  setFrom(e.target.value);
                  resetPreview();
                }}
              />
            </Field>
            <Field className="gap-1.5">
              <FieldLabel htmlFor="bulk-to">Đến</FieldLabel>
              <Input
                id="bulk-to"
                type="datetime-local"
                value={to}
                onChange={(e) => {
                  setTo(e.target.value);
                  resetPreview();
                }}
              />
            </Field>
          </div>
          <Field className="gap-1.5">
            <FieldLabel htmlFor="bulk-err">Lỗi chứa</FieldLabel>
            <Input
              id="bulk-err"
              placeholder="VD: 500, timeout, ECONNREFUSED"
              value={errorContains}
              onChange={(e) => {
                setErrorContains(e.target.value);
                resetPreview();
              }}
            />
          </Field>
          <Field className="gap-1.5" data-invalid={reason.length > 0 && !reasonOk}>
            <FieldLabel htmlFor="bulk-reason">Lý do (bắt buộc)</FieldLabel>
            <Textarea
              id="bulk-reason"
              rows={2}
              value={reason}
              placeholder="VD: Đích Discord đã sống lại sau sự cố 10/10"
              onChange={(e) => setReason(e.target.value)}
              aria-invalid={reason.length > 0 && !reasonOk}
            />
            <FieldDescription>Ít nhất {REASON_MIN} ký tự — ghi vào audit log cùng transaction.</FieldDescription>
          </Field>

          {preview && (
            <div className="space-y-2 rounded-md border p-3 text-sm">
              <p>
                <span className="font-semibold tabular-nums">{preview.count}</span> delivery sẽ được replay
                {preview.truncated ? ` (chạm trần ${preview.limit} — lọc hẹp hơn để lấy phần còn lại)` : ""}.
              </p>
              {preview.sample.length > 0 && (
                <ul className="space-y-0.5 font-mono text-[11px] text-muted-foreground">
                  {preview.sample.map((r) => (
                    <li key={r.id} className="truncate" title={r.lastError ?? ""}>
                      {formatDateTime(r.createdAt)} · {r.eventType} → {destName(r.destinationId)} · {r.lastError ?? "—"}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </FieldGroup>
        <DialogFooter>
          <Button type="button" variant="outline" disabled={bulk.isPending} onClick={() => close(false)}>
            Huỷ
          </Button>
          <Button type="button" variant="secondary" disabled={!reasonOk || bulk.isPending} onClick={runPreview}>
            <Eye />
            Xem trước
          </Button>
          <Button
            type="button"
            disabled={!reasonOk || !preview || preview.count === 0 || bulk.isPending}
            onClick={runReplay}
          >
            <ListRestart />
            {bulk.isPending ? "Đang chạy…" : `Replay ${preview?.count ?? "N"} delivery`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function DlqPage() {
  const { data, isLoading, error } = useDlq();
  const replay = useReplayDelivery();
  const [target, setTarget] = useState<Delivery | null>(null);
  const [reason, setReason] = useState("");
  const [bulkOpen, setBulkOpen] = useState(false);

  const columns = useMemo<HubColumn<Delivery>[]>(
    () => [
      ...deliveryColumns,
      {
        id: "actions",
        header: "",
        enableHiding: false,
        cell: ({ row }) => (
          <Button size="sm" variant="outline" onClick={() => setTarget(row.original)}>
            <RotateCcw />
            Replay
          </Button>
        ),
      },
    ],
    [],
  );

  const confirmReplay = () => {
    if (!target) return;
    const d = target;
    replay.mutate(
      { id: d.id, reason: reason.trim() || undefined },
      {
        onSuccess: (res) => {
          if (res.success) {
            toast.success(`Đã replay — delivery mới ở generation ${res.generation}`, {
              description: "Worker sẽ gửi lại qua outbox. Theo dõi ở trang Deliveries.",
            });
          } else {
            toast.error(res.message ?? "Replay thất bại");
          }
        },
        onError: (e) =>
          e instanceof HubApiError && e.status === 409
            ? toast.info(e.message, { description: "Danh sách DLQ đã được làm mới." })
            : toast.error(`Replay thất bại: ${e.message}`),
        onSettled: () => {
          setTarget(null);
          setReason("");
        },
      },
    );
  };

  return (
    <>
      <PageHeader
        title="Dead Letter Queue"
        description="Delivery đã hết lượt retry (DEAD). Replay KHÔNG sửa bản ghi cũ mà tạo delivery mới với attempt_generation + 1 — lịch sử thất bại được giữ nguyên."
        actions={
          <Button onClick={() => setBulkOpen(true)} disabled={!data?.length}>
            <ListRestart />
            Replay hàng loạt
          </Button>
        }
      />
      <DataTable
        data={data}
        columns={columns}
        getRowId={(d) => d.id}
        isLoading={isLoading}
        error={error}
        searchPlaceholder="Lọc theo đích, lỗi…"
        emptyText="DLQ trống — không có delivery nào chết."
      />

      <BulkReplayDialog open={bulkOpen} onOpenChange={setBulkOpen} />

      <AlertDialog
        open={Boolean(target)}
        onOpenChange={(open) => {
          if (!open && !replay.isPending) {
            setTarget(null);
            setReason("");
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Replay delivery này?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm">
                <p>
                  Gửi lại sự kiện <span className="font-mono">{target?.event?.type}</span> tới{" "}
                  <span className="font-medium">{target?.subscription?.destination?.name ?? "đích"}</span>.
                </p>
                <p>
                  Hub tạo delivery mới với <span className="font-mono">attempt_generation</span> ={" "}
                  <span className="font-mono">{(target?.attemptGeneration ?? 0) + 1}</span> (bản cũ giữ trạng thái
                  DEAD). Nếu đích không idempotent, nó có thể nhận sự kiện hai lần.
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Field className="gap-1.5">
            <FieldLabel htmlFor="replay-reason">Lý do (không bắt buộc)</FieldLabel>
            <Input
              id="replay-reason"
              value={reason}
              placeholder="Ghi vào audit log"
              onChange={(e) => setReason(e.target.value)}
              disabled={replay.isPending}
            />
          </Field>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={replay.isPending}>Huỷ</AlertDialogCancel>
            <AlertDialogAction
              disabled={replay.isPending}
              onClick={(e) => {
                e.preventDefault();
                confirmReplay();
              }}
            >
              {replay.isPending ? "Đang replay…" : "Replay"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
