"use client";

import { Fragment, type ReactNode, useMemo, useState } from "react";

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
import { CellTooltip } from "@/components/ui/cell-tooltip";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { formatDateTime } from "@/lib/hub/format";
import {
  useCreateSubscription,
  useDeleteSubscription,
  useDestinations,
  useSetSubscriptionActive,
  useSubscriptions,
} from "@/lib/hub/queries";
import type { Subscription } from "@/lib/hub/types";
import { describeDeleteConflict } from "@/lib/hub/ui-logic";
import type { Locale, TranslateFn } from "@/lib/i18n/dictionary";
import { useLocale, useT } from "@/lib/i18n/use-t";

/** Câu dịch có chỗ chèn phần tử (`{wildcard}`…): tách theo `{tên}` và thay bằng node tương ứng. */
function rich(template: string, nodes: Record<string, ReactNode>): ReactNode {
  return template.split(/\{(\w+)\}/).map((part, i) =>
    // biome-ignore lint/suspicious/noArrayIndexKey: các mảnh của một câu cố định, thứ tự không đổi
    i % 2 === 1 && part in nodes ? <Fragment key={i}>{nodes[part]}</Fragment> : part,
  );
}

const makeSchema = (t: TranslateFn) =>
  z.object({
    name: z.string().trim().min(1, t("page.subscriptions.form.name-required")).max(255),
    destinationId: z.string().min(1, t("page.subscriptions.form.destination-required")),
    eventTypes: z
      .string()
      .transform((s) =>
        s
          .split(/[\s,]+/)
          .map((x) => x.trim())
          .filter(Boolean),
      )
      .pipe(
        z
          .array(
            // Cùng ngữ pháp với hub (libs/common/src/event-pattern.ts, S3-3).
            z.string().regex(/^(\*|[a-z0-9_]+(\.[a-z0-9_]+)*(\.\*)?)$/, t("page.subscriptions.form.pattern-invalid")),
          )
          .min(1, t("page.subscriptions.form.types-required")),
      ),
    template: z.string(),
    // PK5 khoá 4 (ADR-206): đích tự đồng ý nhận sự kiện chưa xác thực (mặc định không).
    acceptUnverified: z.boolean(),
  });
type FormIn = z.input<ReturnType<typeof makeSchema>>;
type FormOut = z.output<ReturnType<typeof makeSchema>>;

/**
 * Tắt/Bật + Xoá (ADR-054). Xoá bị server chặn 409 khi còn delivery (lịch sử, kể cả DEAD) — toast giải
 * thích và đưa nút "Tắt" ngay trong toast: tắt mới là cách ngừng gửi đúng.
 */
function SubscriptionActions({ sub }: { sub: Subscription }) {
  const t = useT();
  const setActive = useSetSubscriptionActive();
  const del = useDeleteSubscription();
  const busy = setActive.isPending || del.isPending;

  const toggle = (isActive: boolean) =>
    setActive.mutate(
      { id: sub.id, isActive },
      {
        onSuccess: () =>
          toast.success(
            t(isActive ? "page.subscriptions.toast.enabled" : "page.subscriptions.toast.disabled", { name: sub.name }),
          ),
        onError: (e) => toast.error(t("page.subscriptions.toast.toggle-failed", { message: e.message })),
      },
    );

  const remove = () => {
    if (!window.confirm(t("page.subscriptions.delete-confirm", { name: sub.name }))) return;
    del.mutate(sub.id, {
      onSuccess: () => toast.success(t("page.subscriptions.toast.deleted", { name: sub.name })),
      onError: (e) => {
        const conflict = describeDeleteConflict(e, t);
        if (!conflict) return toast.error(t("page.subscriptions.toast.delete-failed", { message: e.message }));
        toast.warning(t("page.subscriptions.toast.delete-blocked"), {
          description: conflict,
          duration: 10_000,
          action: sub.isActive ? { label: t("common.disable"), onClick: () => toggle(false) } : undefined,
        });
      },
    });
  };

  return (
    <div className="flex justify-end gap-1">
      {sub.isActive ? (
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => toggle(false)}
          title={t("page.subscriptions.toggle-off-title")}
        >
          <PowerOff />
          {t("common.disable")}
        </Button>
      ) : (
        <Button size="sm" variant="outline" disabled={busy} onClick={() => toggle(true)}>
          <Power />
          {t("common.enable")}
        </Button>
      )}
      <Button
        size="sm"
        variant="ghost"
        disabled={busy}
        onClick={remove}
        aria-label={t("page.subscriptions.delete-aria", { name: sub.name })}
        title={t("page.subscriptions.delete-title")}
      >
        <Trash2 />
      </Button>
    </div>
  );
}

const makeColumns = (t: TranslateFn, locale: Locale): HubColumn<Subscription>[] => [
  {
    id: "name",
    header: t("common.name"),
    accessorFn: (s) => s.name,
    cell: ({ row }) => <span className="font-medium">{row.original.name}</span>,
    enableHiding: false,
  },
  {
    id: "eventTypes",
    header: t("page.subscriptions.col.event-types"),
    accessorFn: (s) => s.eventTypes.join(" "),
    cell: ({ row }) => (
      <div className="flex flex-wrap gap-1">
        {row.original.eventTypes.map((type) => (
          <Badge key={type} variant="outline" className="font-mono text-[11px]">
            {type}
          </Badge>
        ))}
      </div>
    ),
  },
  {
    id: "destination",
    header: t("page.subscriptions.col.destination"),
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
    header: t("page.subscriptions.col.template"),
    accessorFn: (s) => s.template ?? "",
    cell: ({ row }) =>
      row.original.template ? (
        <CellTooltip text={row.original.template}>
          <span data-cell-text className="block max-w-56 truncate font-mono text-xs">
            {row.original.template}
          </span>
        </CellTooltip>
      ) : (
        <span className="text-muted-foreground text-xs">{t("page.subscriptions.template-default")}</span>
      ),
  },
  {
    id: "isActive",
    header: t("common.status"),
    accessorFn: (s) => (s.isActive ? "active" : "inactive"),
    cell: ({ row }) => (
      <div className="flex flex-wrap gap-1">
        {row.original.isActive ? (
          <Badge variant="outline">{t("common.enabled")}</Badge>
        ) : (
          <Badge variant="destructive">{t("page.subscriptions.inactive")}</Badge>
        )}
        {/* PK5 khoá 4: subscription nhận cả sự kiện chưa xác thực — nơi nhận phải tự kiểm chữ ký gốc. */}
        {row.original.acceptUnverified && (
          <Badge variant="outline" className="border-amber-500/50 text-amber-700 dark:text-amber-400">
            {t("page.subscriptions.accept-unverified-badge")}
          </Badge>
        )}
      </div>
    ),
  },
  {
    id: "createdAt",
    header: t("common.created-at"),
    accessorFn: (s) => s.createdAt,
    cell: ({ row }) => <span className="text-xs">{formatDateTime(row.original.createdAt, locale)}</span>,
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
  const t = useT();
  const locale = useLocale();
  const columns = useMemo(() => makeColumns(t, locale), [t, locale]);
  const schema = useMemo(() => makeSchema(t), [t]);
  const { data, isLoading, error } = useSubscriptions();
  const destinations = useDestinations();
  const create = useCreateSubscription();
  const [open, setOpen] = useState(false);
  const form = useForm<FormIn, unknown, FormOut>({
    resolver: zodResolver(schema),
    defaultValues: { name: "", destinationId: "", eventTypes: "", template: "", acceptUnverified: false },
  });

  const onSubmit = (v: FormOut) =>
    create
      .mutateAsync({
        name: v.name,
        destinationId: v.destinationId,
        eventTypes: v.eventTypes,
        template: v.template.trim() || undefined,
        ...(v.acceptUnverified ? { acceptUnverified: true } : {}),
      })
      .then(
        (s) => {
          toast.success(t("page.subscriptions.toast.created", { name: s.name }));
          form.reset();
          setOpen(false);
        },
        (e: Error) => toast.error(t("page.subscriptions.toast.create-failed", { message: e.message })),
      );

  return (
    <>
      <PageHeader
        title={t("page.subscriptions.title")}
        description={t("page.subscriptions.description")}
        actions={
          <Button onClick={() => setOpen(true)}>
            <Plus />
            {t("page.subscriptions.add")}
          </Button>
        }
      />
      <DataTable
        data={data}
        columns={columns}
        getRowId={(s) => s.id}
        isLoading={isLoading}
        error={error}
        searchPlaceholder={t("page.subscriptions.search")}
        emptyText={t("page.subscriptions.empty")}
      />

      <FormDialog
        open={open}
        onOpenChange={setOpen}
        title={t("page.subscriptions.add")}
        formId="subscription-form"
        submitting={create.isPending}
      >
        <form id="subscription-form" noValidate onSubmit={form.handleSubmit(onSubmit)}>
          <FieldGroup className="gap-4">
            {/* UI-MS: tên + đích gộp một hàng — form vừa khung không phải cuộn */}
            <div className="grid gap-4 sm:grid-cols-2">
            <Controller
              control={form.control}
              name="name"
              render={({ field, fieldState }) => (
                <Field className="gap-1.5" data-invalid={fieldState.invalid}>
                  <FieldLabel htmlFor="sub-name">{t("common.name")}</FieldLabel>
                  <Input
                    {...field}
                    id="sub-name"
                    placeholder={t("page.subscriptions.form.name-placeholder")}
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
                  <FieldLabel>{t("page.subscriptions.form.destination")}</FieldLabel>
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger className="w-full" aria-invalid={fieldState.invalid}>
                      <SelectValue
                        placeholder={
                          destinations.isLoading
                            ? t("common.loading")
                            : t("page.subscriptions.form.destination-placeholder")
                        }
                      />
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
                    <FieldDescription>{t("page.subscriptions.form.no-destinations")}</FieldDescription>
                  )}
                  {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
                </Field>
              )}
            />
            </div>
            <Controller
              control={form.control}
              name="eventTypes"
              render={({ field, fieldState }) => (
                <Field className="gap-1.5" data-invalid={fieldState.invalid}>
                  <FieldLabel htmlFor="sub-types">{t("page.subscriptions.col.event-types")}</FieldLabel>
                  <Input
                    {...field}
                    id="sub-types"
                    className="font-mono text-xs"
                    placeholder="payment.received, repo.push"
                    aria-invalid={fieldState.invalid}
                  />
                  <FieldDescription>
                    {rich(t("page.subscriptions.form.types-hint"), {
                      wildcard: <code>payment.*</code>,
                      all: <code>*</code>,
                    })}
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
                  <FieldLabel htmlFor="sub-template">{t("page.subscriptions.form.template")}</FieldLabel>
                  <Textarea
                    {...field}
                    id="sub-template"
                    rows={3}
                    className="font-mono text-xs"
                    placeholder={t("page.subscriptions.form.template-placeholder")}
                  />
                  <FieldDescription>{t("page.subscriptions.form.template-hint")}</FieldDescription>
                </Field>
              )}
            />
            <Controller
              control={form.control}
              name="acceptUnverified"
              render={({ field }) => (
                <Field className="gap-1.5">
                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={field.value} onChange={(e) => field.onChange(e.target.checked)} />
                    {t("page.subscriptions.form.accept-unverified")}
                  </label>
                  <FieldDescription>{t("page.subscriptions.form.accept-unverified-hint")}</FieldDescription>
                </Field>
              )}
            />
          </FieldGroup>
        </form>
      </FormDialog>
    </>
  );
}
