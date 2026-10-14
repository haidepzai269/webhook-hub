"use client";

import { Suspense, useMemo, useState } from "react";

import { Eye, ListRestart, RotateCcw, X } from "lucide-react";
import { toast } from "sonner";

import { AdminDialogContent } from "@/components/admin/overlay-content";
import { CursorPager } from "@/components/admin/cursor-pager";
import { DataTable, type HubColumn } from "@/components/admin/data-table";
import { PageHeader } from "@/components/admin/page-header";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogBody,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
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
import type { MessageKey } from "@/lib/i18n/dictionary";
import { useLocale, useT } from "@/lib/i18n/use-t";

import { useDeliveryColumns } from "../deliveries/_components/delivery-columns";

const ALL = "__all__";
const REASON_MIN = 5;

/** Loại lỗi (ADR-163) — theo HTTP status của lần thử cuối, khớp DLQ_ERROR_KINDS ở server. */
const ERROR_KIND_LABEL: Record<(typeof DLQ_ERROR_KIND_VALUES)[number], MessageKey> = {
  http_4xx: "page.dlq.error-kind.http-4xx",
  http_other: "page.dlq.error-kind.http-other",
  no_response: "page.dlq.error-kind.no-response",
};

const SKIP_LABEL: Record<ReplaySkipReason, MessageKey> = {
  not_found: "page.dlq.skip.not-found",
  not_dead: "page.dlq.skip.not-dead",
  already_replayed: "page.dlq.skip.already-replayed",
  destination_unavailable: "page.dlq.skip.destination-unavailable",
  unverified_not_accepted: "page.dlq.skip.unverified-not-accepted",
  event_trimmed: "page.dlq.skip.event-trimmed",
};

const AGE_LABEL: Record<(typeof DLQ_AGE_VALUES)[number], MessageKey> = {
  "1h": "page.dlq.age.1h",
  "24h": "page.dlq.age.24h",
  "7d": "page.dlq.age.7d",
  gt1d: "page.dlq.age.gt1d",
  gt7d: "page.dlq.age.gt7d",
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
  const t = useT();
  const locale = useLocale();
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
        onError: (e) => toast.error(t("page.dlq.bulk.preview-failed", { message: e.message })),
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
          toast.success(t("page.dlq.bulk.done", { count: res.count }), {
            description: skipped
              ? t("page.dlq.bulk.skipped", {
                  count: skipped,
                  reasons: Object.entries(res.skipped.byReason)
                    .map(([k, n]) => {
                      const key = SKIP_LABEL[k as ReplaySkipReason];
                      return `${key ? t(key) : k}: ${n}`;
                    })
                    .join(", "),
                })
              : t("page.dlq.bulk.atomic"),
          });
          close(false);
        },
        onError: (e) =>
          e instanceof HubApiError && e.status === 409
            ? toast.info(e.message, { description: t("page.dlq.bulk.nothing-written") })
            : toast.error(t("page.dlq.replay-failed-msg", { message: e.message })),
        onSettled: () => setPreview(null),
      },
    );

  return (
    <Dialog open={open} onOpenChange={close}>
      <AdminDialogContent size="md">
        <DialogHeader>
          <DialogTitle>{t("page.dlq.bulk")}</DialogTitle>
          <DialogDescription>{t("page.dlq.bulk.description")}</DialogDescription>
        </DialogHeader>
        <DialogBody>
        <FieldGroup className="gap-4">
          <div className="rounded-md border p-3 text-sm">
            <span className="text-muted-foreground">{t("page.dlq.bulk.filters")}</span>
            {summary.length ? summary.join(" · ") : t("page.dlq.bulk.whole")}
          </div>
          <Field className="gap-1.5" data-invalid={reason.length > 0 && !reasonOk}>
            <FieldLabel htmlFor="bulk-reason">{t("page.dlq.bulk.reason")}</FieldLabel>
            <Textarea
              id="bulk-reason"
              rows={2}
              value={reason}
              placeholder={t("page.dlq.bulk.reason-placeholder")}
              onChange={(e) => setReason(e.target.value)}
              aria-invalid={reason.length > 0 && !reasonOk}
            />
            <FieldDescription>{t("page.dlq.bulk.reason-hint", { min: REASON_MIN })}</FieldDescription>
          </Field>

          {preview && (
            <div className="space-y-2 rounded-md border p-3 text-sm">
              <p>
                <span className="font-semibold tabular-nums">{preview.count}</span> {t("page.dlq.bulk.will-replay")}
                {preview.truncated ? t("page.dlq.bulk.truncated", { limit: preview.limit }) : ""}.
              </p>
              {preview.sample.length > 0 && (
                <ul className="space-y-0.5 font-mono text-[11px] text-muted-foreground">
                  {preview.sample.map((r) => (
                    <li key={r.id} className="truncate" title={r.lastError ?? ""}>
                      {formatDateTime(r.createdAt, locale)} · {r.eventType} → {destName(r.destinationId)} · {r.lastError ?? "—"}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </FieldGroup>
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="outline" disabled={bulk.isPending} onClick={() => close(false)}>
            {t("common.cancel")}
          </Button>
          <Button type="button" variant="secondary" disabled={!reasonOk || bulk.isPending} onClick={runPreview}>
            <Eye />
            {t("page.dlq.bulk.preview")}
          </Button>
          <Button
            type="button"
            disabled={!reasonOk || !preview || preview.count === 0 || bulk.isPending}
            onClick={runReplay}
          >
            <ListRestart />
            {bulk.isPending ? t("page.dlq.bulk.running") : t("page.dlq.bulk.run", { count: preview?.count ?? "N" })}
          </Button>
        </DialogFooter>
      </AdminDialogContent>
    </Dialog>
  );
}

function DlqView() {
  const t = useT();
  const deliveryColumns = useDeliveryColumns();
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
    v.destination &&
      t("page.dlq.filter.destination-summary", {
        name: destinations.data?.find((d) => d.id === v.destination)?.name ?? shortId(v.destination),
      }),
    v.errorKind && t(ERROR_KIND_LABEL[v.errorKind as keyof typeof ERROR_KIND_LABEL]),
    v.age && t(AGE_LABEL[v.age as keyof typeof AGE_LABEL]).toLowerCase(),
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
            {t("page.dlq.replay")}
          </Button>
        ),
      },
    ],
    [deliveryColumns, t],
  );

  const confirmReplay = () => {
    if (!target) return;
    const d = target;
    replay.mutate(
      { id: d.id, reason: reason.trim() || undefined },
      {
        onSuccess: (res) => {
          if (res.success) {
            toast.success(t("page.dlq.replayed", { generation: res.generation ?? "—" }), {
              description: t("page.dlq.replayed-hint"),
            });
          } else {
            toast.error(res.message ?? t("page.dlq.replay-failed"));
          }
        },
        onError: (e) =>
          e instanceof HubApiError && e.status === 409
            ? toast.info(e.message, { description: t("page.dlq.conflict-refreshed") })
            : toast.error(t("page.dlq.replay-failed-msg", { message: e.message })),
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
        title={t("page.dlq.title")}
        description={t("page.dlq.description")}
        actions={
          <Button onClick={() => setBulkOpen(true)} disabled={!data?.items.length}>
            <ListRestart />
            {t("page.dlq.bulk")}
          </Button>
        }
      />
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Select value={v.destination ?? ALL} onValueChange={(d) => url.setFilter({ destination: d === ALL ? null : d })}>
          <SelectTrigger size="sm" className="w-52" aria-label={t("page.dlq.filter.destination")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{t("page.dlq.filter.all-destinations")}</SelectItem>
            {(destinations.data ?? []).map((d) => (
              <SelectItem key={d.id} value={d.id}>
                {d.name} · {d.type}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={v.errorKind ?? ALL} onValueChange={(k) => url.setFilter({ errorKind: k === ALL ? null : k })}>
          <SelectTrigger size="sm" className="w-56" aria-label={t("page.dlq.filter.error-kind")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{t("page.dlq.filter.all-error-kinds")}</SelectItem>
            {DLQ_ERROR_KIND_VALUES.map((k) => (
              <SelectItem key={k} value={k}>
                {t(ERROR_KIND_LABEL[k])}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={v.age ?? ALL} onValueChange={(a) => url.setFilter({ age: a === ALL ? null : a })}>
          <SelectTrigger size="sm" className="w-44" aria-label={t("page.dlq.filter.age")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{t("page.dlq.filter.all-ages")}</SelectItem>
            {DLQ_AGE_VALUES.map((a) => (
              <SelectItem key={a} value={a}>
                {t(AGE_LABEL[a])}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {filtered && (
          <Button variant="ghost" size="sm" onClick={url.clear}>
            <X />
            {t("common.filters.clear")}
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
        searchPlaceholder={t("page.dlq.search")}
        emptyText={filtered ? t("page.dlq.no-match") : t("page.dlq.empty")}
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
          <AlertDialogBody>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("page.dlq.confirm.title")}</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm">
                <p>
                  {t("page.dlq.confirm.send")} <span className="font-mono">{target?.event?.type}</span>{" "}
                  {t("page.dlq.confirm.to")}{" "}
                  <span className="font-medium">
                    {target?.subscription?.destination?.name ?? t("page.dlq.confirm.destination")}
                  </span>
                  .
                </p>
                <p>
                  {t("page.dlq.confirm.new")} <span className="font-mono">attempt_generation</span> ={" "}
                  <span className="font-mono">{(target?.attemptGeneration ?? 0) + 1}</span>{" "}
                  {t("page.dlq.confirm.idempotent")}
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Field className="gap-1.5">
            <FieldLabel htmlFor="replay-reason">{t("page.dlq.reason-optional")}</FieldLabel>
            <Input
              id="replay-reason"
              value={reason}
              placeholder={t("page.dlq.reason-placeholder")}
              onChange={(e) => setReason(e.target.value)}
              disabled={replay.isPending}
            />
          </Field>
          </AlertDialogBody>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={replay.isPending}>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              disabled={replay.isPending}
              onClick={(e) => {
                e.preventDefault();
                confirmReplay();
              }}
            >
              {replay.isPending ? t("page.dlq.replaying") : t("page.dlq.replay")}
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
