"use client";

import { useState } from "react";

import { zodResolver } from "@hookform/resolvers/zod";
import { Plus, Power, PowerOff, Trash2 } from "lucide-react";
import { Controller, useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";

import { DataTable, type HubColumn } from "@/components/admin/data-table";
import { FormDialog } from "@/components/admin/form-dialog";
import { PageHeader } from "@/components/admin/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { formatDateTime } from "@/lib/hub/format";
import { describeDeleteConflict } from "@/lib/hub/ui-logic";
import {
  useCreateSubscription,
  useDeleteSubscription,
  useDestinations,
  useSetSubscriptionActive,
  useSubscriptions,
} from "@/lib/hub/queries";
import type { Subscription } from "@/lib/hub/types";

const schema = z.object({
  name: z.string().trim().min(1, "Nhập tên subscription.").max(255),
  destinationId: z.string().min(1, "Chọn một đích."),
  eventTypes: z
    .string()
    .transform((s) =>
      s
        .split(/[\s,]+/)
        .map((t) => t.trim())
        .filter(Boolean),
    )
    .pipe(
      z
        .array(
          // Cùng ngữ pháp với hub (libs/common/src/event-pattern.ts, S3-3).
          z.string().regex(/^(\*|[a-z0-9_]+(\.[a-z0-9_]+)*(\.\*)?)$/, "Mẫu không hợp lệ (vd payment.*, repo.push, *)."),
        )
        .min(1, "Nhập ít nhất một loại sự kiện."),
    ),
  template: z.string(),
});
type FormIn = z.input<typeof schema>;
type FormOut = z.output<typeof schema>;

/**
 * Tắt/Bật + Xoá (ADR-054). Xoá bị server chặn 409 khi còn delivery (lịch sử, kể cả DEAD) — toast giải
 * thích và đưa nút "Tắt" ngay trong toast: tắt mới là cách ngừng gửi đúng.
 */
function SubscriptionActions({ sub }: { sub: Subscription }) {
  const setActive = useSetSubscriptionActive();
  const del = useDeleteSubscription();
  const busy = setActive.isPending || del.isPending;

  const toggle = (isActive: boolean) =>
    setActive.mutate(
      { id: sub.id, isActive },
      {
        onSuccess: () => toast.success(isActive ? `Đã bật "${sub.name}"` : `Đã tắt "${sub.name}" — sự kiện mới không còn được giao`),
        onError: (e) => toast.error(`Không đổi được trạng thái: ${e.message}`),
      },
    );

  const remove = () => {
    if (!window.confirm(`Xoá subscription "${sub.name}"? Chỉ xoá được khi chưa có delivery nào.`)) return;
    del.mutate(sub.id, {
      onSuccess: () => toast.success(`Đã xoá "${sub.name}"`),
      onError: (e) => {
        const conflict = describeDeleteConflict(e);
        if (!conflict) return toast.error(`Xoá thất bại: ${e.message}`);
        toast.warning("Không xoá được subscription", {
          description: conflict,
          duration: 10_000,
          action: sub.isActive ? { label: "Tắt", onClick: () => toggle(false) } : undefined,
        });
      },
    });
  };

  return (
    <div className="flex justify-end gap-1">
      {sub.isActive ? (
        <Button size="sm" variant="outline" disabled={busy} onClick={() => toggle(false)} title="Ngừng gửi, giữ lịch sử">
          <PowerOff />
          Tắt
        </Button>
      ) : (
        <Button size="sm" variant="outline" disabled={busy} onClick={() => toggle(true)}>
          <Power />
          Bật
        </Button>
      )}
      <Button size="sm" variant="ghost" disabled={busy} onClick={remove} aria-label={`Xoá ${sub.name}`} title="Xoá (bị chặn nếu đã có delivery)">
        <Trash2 />
      </Button>
    </div>
  );
}

const columns: HubColumn<Subscription>[] = [
  {
    id: "name",
    header: "Tên",
    accessorFn: (s) => s.name,
    cell: ({ row }) => <span className="font-medium">{row.original.name}</span>,
    enableHiding: false,
  },
  {
    id: "eventTypes",
    header: "Loại sự kiện",
    accessorFn: (s) => s.eventTypes.join(" "),
    cell: ({ row }) => (
      <div className="flex flex-wrap gap-1">
        {row.original.eventTypes.map((t) => (
          <Badge key={t} variant="outline" className="font-mono text-[11px]">
            {t}
          </Badge>
        ))}
      </div>
    ),
  },
  {
    id: "destination",
    header: "→ Đích",
    accessorFn: (s) => s.destination?.name ?? "",
    cell: ({ row }) => (
      <span className="text-sm">
        {row.original.destination?.name ?? "—"}
        {row.original.destination?.type && (
          <span className="ml-1 text-muted-foreground text-xs">({row.original.destination.type})</span>
        )}
      </span>
    ),
  },
  {
    id: "template",
    header: "Template",
    accessorFn: (s) => s.template ?? "",
    cell: ({ row }) =>
      row.original.template ? (
        <span className="block max-w-56 truncate font-mono text-xs" title={row.original.template}>
          {row.original.template}
        </span>
      ) : (
        <span className="text-muted-foreground text-xs">mặc định (JSON)</span>
      ),
  },
  {
    id: "isActive",
    header: "Trạng thái",
    accessorFn: (s) => (s.isActive ? "active" : "inactive"),
    cell: ({ row }) =>
      row.original.isActive ? <Badge variant="outline">Đang bật</Badge> : <Badge variant="destructive">Tắt</Badge>,
  },
  {
    id: "createdAt",
    header: "Tạo lúc",
    accessorFn: (s) => s.createdAt,
    cell: ({ row }) => <span className="text-xs">{formatDateTime(row.original.createdAt)}</span>,
  },
  {
    id: "actions",
    header: "",
    enableSorting: false,
    enableHiding: false,
    cell: ({ row }) => <SubscriptionActions sub={row.original} />,
  },
];

export default function SubscriptionsPage() {
  const { data, isLoading, error } = useSubscriptions();
  const destinations = useDestinations();
  const create = useCreateSubscription();
  const [open, setOpen] = useState(false);
  const form = useForm<FormIn, unknown, FormOut>({
    resolver: zodResolver(schema),
    defaultValues: { name: "", destinationId: "", eventTypes: "", template: "" },
  });

  const onSubmit = (v: FormOut) =>
    create
      .mutateAsync({
        name: v.name,
        destinationId: v.destinationId,
        eventTypes: v.eventTypes,
        template: v.template.trim() || undefined,
      })
      .then(
        (s) => {
          toast.success(`Đã tạo subscription "${s.name}"`);
          form.reset();
          setOpen(false);
        },
        (e: Error) => toast.error(`Tạo subscription thất bại: ${e.message}`),
      );

  return (
    <>
      <PageHeader
        title="Subscriptions"
        description="Quy tắc định tuyến: sự kiện thuộc loại X → giao tới đích Y, tuỳ chọn qua template."
        actions={
          <Button onClick={() => setOpen(true)}>
            <Plus />
            Thêm subscription
          </Button>
        }
      />
      <DataTable
        data={data}
        columns={columns}
        getRowId={(s) => s.id}
        isLoading={isLoading}
        error={error}
        searchPlaceholder="Lọc theo tên, loại sự kiện, đích…"
        emptyText="Chưa có subscription nào — sự kiện sẽ không được giao đi đâu."
      />

      <FormDialog
        open={open}
        onOpenChange={setOpen}
        title="Thêm subscription"
        formId="subscription-form"
        submitting={create.isPending}
      >
        <form id="subscription-form" noValidate onSubmit={form.handleSubmit(onSubmit)}>
          <FieldGroup className="gap-4">
            <Controller
              control={form.control}
              name="name"
              render={({ field, fieldState }) => (
                <Field className="gap-1.5" data-invalid={fieldState.invalid}>
                  <FieldLabel htmlFor="sub-name">Tên</FieldLabel>
                  <Input
                    {...field}
                    id="sub-name"
                    placeholder="VD: Thanh toán → Telegram"
                    aria-invalid={fieldState.invalid}
                  />
                  {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
                </Field>
              )}
            />
            <Controller
              control={form.control}
              name="destinationId"
              render={({ field, fieldState }) => (
                <Field className="gap-1.5" data-invalid={fieldState.invalid}>
                  <FieldLabel>Đích</FieldLabel>
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger className="w-full" aria-invalid={fieldState.invalid}>
                      <SelectValue placeholder={destinations.isLoading ? "Đang tải…" : "Chọn đích"} />
                    </SelectTrigger>
                    <SelectContent>
                      {(destinations.data ?? []).map((d) => (
                        <SelectItem key={d.id} value={d.id}>
                          {d.name} ({d.type})
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {!destinations.isLoading && !destinations.data?.length && (
                    <FieldDescription>Chưa có đích nào — tạo ở trang Đích trước.</FieldDescription>
                  )}
                  {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
                </Field>
              )}
            />
            <Controller
              control={form.control}
              name="eventTypes"
              render={({ field, fieldState }) => (
                <Field className="gap-1.5" data-invalid={fieldState.invalid}>
                  <FieldLabel htmlFor="sub-types">Loại sự kiện</FieldLabel>
                  <Input
                    {...field}
                    id="sub-types"
                    className="font-mono text-xs"
                    placeholder="payment.received, repo.push"
                    aria-invalid={fieldState.invalid}
                  />
                  <FieldDescription>
                    Phân tách bằng dấu phẩy hoặc khoảng trắng. <code>payment.*</code> = mọi sự kiện thanh toán;{" "}
                    <code>*</code> = mọi sự kiện.
                  </FieldDescription>
                  {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
                </Field>
              )}
            />
            <Controller
              control={form.control}
              name="template"
              render={({ field }) => (
                <Field className="gap-1.5">
                  <FieldLabel htmlFor="sub-template">Template (tuỳ chọn)</FieldLabel>
                  <Textarea
                    {...field}
                    id="sub-template"
                    rows={3}
                    className="font-mono text-xs"
                    placeholder="Nhận {{data.amount}} {{data.currency}} — {{data.memo}}"
                  />
                  <FieldDescription>Để trống: gửi nguyên sự kiện dạng JSON.</FieldDescription>
                </Field>
              )}
            />
          </FieldGroup>
        </form>
      </FormDialog>
    </>
  );
}
