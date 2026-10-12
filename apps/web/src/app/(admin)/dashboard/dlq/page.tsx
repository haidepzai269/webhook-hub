"use client";

import { Suspense, useMemo, useState } from "react";

import { Eye, ListRestart, RotateCcw, X } from "lucide-react";
import { toast } from "sonner";

import { CursorPager } from "@/components/admin/cursor-pager";
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
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { HubApiError } from "@/lib/hub/client";
import { formatDateTime, shortId } from "@/lib/hub/format";
import { ageRange, DLQ_AGE_VALUES, DLQ_ERROR_KIND_VALUES, DLQ_PARAMS, toApiQuery } from "@/lib/hub/list-url";
import { useDestinations, useDlq, useReplayBulk, useReplayDelivery } from "@/lib/hub/queries";
import type { Delivery, ReplayBulkFilter, ReplayBulkResult, ReplaySkipReason } from "@/lib/hub/types";
import { useUrlParams } from "@/lib/hub/use-url-params";

import { deliveryColumns } from "../deliveries/_components/delivery-columns";

const ALL = "__all__";
const REASON_MIN = 5;

/** Loại lỗi (ADR-163) — theo HTTP status của lần thử cuối, khớp DLQ_ERROR_KINDS ở server. */
const ERROR_KIND_LABEL: Record<(typeof DLQ_ERROR_KIND_VALUES)[number], string> = {
  http_4xx: "Đích từ chối (4xx)",
  http_other: "Lỗi phía nhận (5xx/khác)",
  no_response: "Không gọi tới đích (circuit)",
};

const SKIP_LABEL: Record<ReplaySkipReason, string> = {
  not_found: "không còn",
  not_dead: "không còn DEAD",
  already_replayed: "đã được replay",
  destination_unavailable: "đích/subscription đã xoá hoặc đang ngắt",
};

const AGE_LABEL: Record<(typeof DLQ_AGE_VALUES)[number], string> = {
  "1h": "Trong 1 giờ qua",
  "24h": "Trong 24 giờ qua",
  "7d": "Trong 7 ngày qua",
  gt1d: "Cũ hơn 1 ngày",
  gt7d: "Cũ hơn 7 ngày",
};

/**
 * Replay hàng loạt theo ĐÚNG bộ lọc đang xem trên trang DLQ (ADR-163): xem trước đếm cùng tập (đích, loại lỗi,
 * tuổi -> from/to) mà bảng đang lọc — không có bộ lọc riêng lệch với bảng. Tối đa 500.
 */
function BulkReplayDialog({
  open,
  onOpenChange,
  filter,
  summary,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  filter: ReplayBulkFilter;
  summary: string[];
}) {
  const destinations = useDestinations();
  const bulk = useReplayBulk();
  const [reason, setReason] = useState("");
  const [preview, setPreview] = useState<Extract<ReplayBulkResult, { dryRun: true }> | null>(null);
  // Bộ lọc của trang đổi -> bản xem trước không còn đúng tập -> bắt xem trước lại.
  const filterKey = JSON.stringify(filter);
  const [previewFor, setPreviewFor] = useState(filterKey);
  if (previewFor !== filterKey) {
    setPreviewFor(filterKey);
    setPreview(null);
  }

  const reasonOk = reason.trim().length >= REASON_MIN;
  const destName = (id: string) => destinations.data?.find((d) => d.id === id)?.name ?? shortId(id);

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
    preview &&
    bulk.mutate(
      // Đúng tập đã xem trước — server kiểm lại từng id, bỏ cái đã đổi trạng thái kèm lý do.
      { reason: reason.trim(), dryRun: false, ids: preview.ids },
      {
        onSuccess: (res) => {
          if (res.dryRun) return;
          const skipped = res.skipped?.count ?? 0;
          toast.success(`Đã replay ${res.count} delivery`, {
            description: skipped
              ? `Bỏ qua ${skipped} (${Object.entries(res.skipped.byReason)
                  .map(([k, n]) => `${SKIP_LABEL[k as ReplaySkipReason] ?? k}: ${n}`)
                  .join(", ")}) — đã đổi trạng thái sau lúc xem trước.`
              : "Tất cả delivery mới + outbox + 1 dòng audit được ghi trong MỘT transaction.",
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
            Mọi delivery DEAD chưa bị replay khớp bộ lọc đang xem (tối đa 500 — không chỉ trang hiện tại). Mỗi cái được
            tạo lại ở generation mới; lịch sử thất bại giữ nguyên.
          </DialogDescription>
        </DialogHeader>
        <FieldGroup className="gap-4">
          <div className="rounded-md border p-3 text-sm">
            <span className="text-muted-foreground">Bộ lọc: </span>
            {summary.length ? summary.join(" · ") : "toàn bộ DLQ"}
          </div>
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

function DlqView() {
  const url = useUrlParams(DLQ_PARAMS);
  const v = url.values;
  const destinations = useDestinations();
  // Tuổi là preset tương đối -> from/to tính một lần mỗi khi chọn (query key ổn định); CÙNG cặp đi vào xem trước replay.
  const range = useMemo(() => ageRange(v.age, Date.now()), [v.age]);
  const bulkFilter: ReplayBulkFilter = useMemo(
    () => ({ destinationId: v.destination, errorKind: v.errorKind, ...range }),
    [v.destination, v.errorKind, range],
  );
  const { data, isLoading, isPlaceholderData, error } = useDlq(
    toApiQuery({ destination: v.destination, errorKind: v.errorKind, ...range, before: v.before, after: v.after }),
  );
  const filtered = Boolean(v.destination || v.errorKind || v.age);
  const summary = [
    v.destination && `đích ${destinations.data?.find((d) => d.id === v.destination)?.name ?? shortId(v.destination)}`,
    v.errorKind && ERROR_KIND_LABEL[v.errorKind as keyof typeof ERROR_KIND_LABEL],
    v.age && AGE_LABEL[v.age as keyof typeof AGE_LABEL].toLowerCase(),
  ].filter((x): x is string => Boolean(x));
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
          <Button onClick={() => setBulkOpen(true)} disabled={!data?.items.length}>
            <ListRestart />
            Replay hàng loạt
          </Button>
        }
      />
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Select value={v.destination ?? ALL} onValueChange={(d) => url.setFilter({ destination: d === ALL ? null : d })}>
          <SelectTrigger size="sm" className="w-52" aria-label="Đích">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Mọi đích</SelectItem>
            {(destinations.data ?? []).map((d) => (
              <SelectItem key={d.id} value={d.id}>
                {d.name} · {d.type}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={v.errorKind ?? ALL} onValueChange={(k) => url.setFilter({ errorKind: k === ALL ? null : k })}>
          <SelectTrigger size="sm" className="w-56" aria-label="Loại lỗi">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Mọi loại lỗi</SelectItem>
            {DLQ_ERROR_KIND_VALUES.map((k) => (
              <SelectItem key={k} value={k}>
                {ERROR_KIND_LABEL[k]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={v.age ?? ALL} onValueChange={(a) => url.setFilter({ age: a === ALL ? null : a })}>
          <SelectTrigger size="sm" className="w-44" aria-label="Tuổi">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Mọi thời điểm</SelectItem>
            {DLQ_AGE_VALUES.map((a) => (
              <SelectItem key={a} value={a}>
                {AGE_LABEL[a]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {filtered && (
          <Button variant="ghost" size="sm" onClick={url.clear}>
            <X />
            Bỏ lọc
          </Button>
        )}
      </div>
      <DataTable
        data={data?.items}
        columns={columns}
        getRowId={(d) => d.id}
        isLoading={isLoading}
        isStale={isPlaceholderData}
        error={error}
        pageSize={false}
        searchPlaceholder="Lọc trong trang này…"
        emptyText={filtered ? "Không có delivery DEAD nào khớp bộ lọc." : "DLQ trống — không có delivery nào chết."}
        toolbar={
          <CursorPager
            next={data?.next}
            prev={data?.prev}
            loading={isPlaceholderData}
            onNext={(c) => url.setCursor({ before: c })}
            onPrev={(c) => url.setCursor({ after: c })}
            onNewest={() => url.setCursor({})}
          />
        }
      />

      <BulkReplayDialog open={bulkOpen} onOpenChange={setBulkOpen} filter={bulkFilter} summary={summary} />

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

export default function DlqPage() {
  return (
    <Suspense fallback={<Skeleton className="h-96 w-full" />}>
      <DlqView />
    </Suspense>
  );
}
