"use client";

import { useState } from "react";

import { zodResolver } from "@hookform/resolvers/zod";
import { Plus, Trash2 } from "lucide-react";
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
import { useCreateDestination, useDeleteDestination, useDestinations } from "@/lib/hub/queries";
import { DESTINATION_TYPES, type Destination, type DestinationType } from "@/lib/hub/types";

/** Khung config mẫu theo đúng key mà sender trong hub-worker đọc. */
const CONFIG_TEMPLATE: Record<DestinationType, string> = {
  webhook: '{\n  "url": "https://example.com/hooks/hub"\n}',
  telegram: '{\n  "botToken": "123456:ABC…",\n  "chatId": "-100123456"\n}',
  discord: '{\n  "webhookUrl": "https://discord.com/api/webhooks/…"\n}',
};

const schema = z.object({
  name: z.string().trim().min(1, "Nhập tên đích.").max(255),
  type: z.enum(DESTINATION_TYPES),
  config: z.string().refine((s) => {
    try {
      const v: unknown = JSON.parse(s);
      return v !== null && typeof v === "object" && !Array.isArray(v);
    } catch {
      return false;
    }
  }, "Config phải là một object JSON hợp lệ."),
  signingSecret: z.string(),
  rateLimitRps: z.coerce.number<string>().int("Phải là số nguyên.").min(0, "Không âm.").max(1000),
});
type FormIn = z.input<typeof schema>;
type FormOut = z.output<typeof schema>;

const CIRCUIT_STYLE = {
  CLOSED: "border-emerald-500/40 text-emerald-700 dark:text-emerald-300",
  HALF_OPEN: "border-amber-500/40 text-amber-700 dark:text-amber-300",
  OPEN: "border-rose-500/40 text-rose-700 dark:text-rose-300",
} as const;

const CIRCUIT_DOT = { CLOSED: "bg-emerald-500", HALF_OPEN: "bg-amber-500", OPEN: "bg-rose-500" } as const;

const CIRCUIT_HINT = {
  CLOSED: "Bình thường — gửi như thường.",
  HALF_OPEN: "Hết 60s OPEN — một worker được gửi thử (probe), số còn lại hoãn 1 phút.",
  OPEN: "5 lỗi liên tiếp — hoãn mọi lần gửi 60s (không tính là một lần thử).",
} as const;

/** Xoá đích — server chặn 409 khi còn subscription trỏ vào (ADR-054); toast nói rõ phải tắt/xoá subscription trước. */
function DestinationActions({ dest }: { dest: Destination }) {
  const del = useDeleteDestination();
  const remove = () => {
    if (!window.confirm(`Xoá đích "${dest.name}"? Chỉ xoá được khi không còn subscription nào trỏ vào.`)) return;
    del.mutate(dest.id, {
      onSuccess: () => toast.success(`Đã xoá đích "${dest.name}"`),
      onError: (e) => {
        const conflict = describeDeleteConflict(e);
        if (!conflict) return toast.error(`Xoá thất bại: ${e.message}`);
        toast.warning("Không xoá được đích", { description: conflict, duration: 10_000 });
      },
    });
  };
  return (
    <div className="flex justify-end">
      <Button size="sm" variant="ghost" disabled={del.isPending} onClick={remove} aria-label={`Xoá ${dest.name}`} title="Xoá (bị chặn nếu còn subscription)">
        <Trash2 />
      </Button>
    </div>
  );
}

const columns: HubColumn<Destination>[] = [
  {
    id: "name",
    header: "Tên",
    accessorFn: (d) => d.name,
    cell: ({ row }) => <span className="font-medium">{row.original.name}</span>,
    enableHiding: false,
  },
  {
    id: "type",
    header: "Loại",
    accessorFn: (d) => d.type,
    cell: ({ row }) => <Badge variant="secondary">{row.original.type}</Badge>,
  },
  {
    id: "circuit",
    header: "Circuit breaker",
    accessorFn: (d) => d.circuitState,
    // Cập nhật trực tiếp: socket `circuit.changed` invalidate danh sách đích (S2-5).
    cell: ({ row }) => (
      <Badge
        variant="outline"
        className={`gap-1.5 font-mono text-[11px] ${CIRCUIT_STYLE[row.original.circuitState]}`}
        title={CIRCUIT_HINT[row.original.circuitState]}
      >
        <span
          className={`size-1.5 rounded-full ${CIRCUIT_DOT[row.original.circuitState]} ${row.original.circuitState === "OPEN" ? "animate-pulse" : ""}`}
        />
        {row.original.circuitState}
      </Badge>
    ),
  },
  {
    id: "rateLimit",
    header: "Giới hạn (rps)",
    accessorFn: (d) => String(d.rateLimitRps),
    cell: ({ row }) => (
      <span className="font-mono text-xs">{row.original.rateLimitRps > 0 ? row.original.rateLimitRps : "∞"}</span>
    ),
  },
  {
    id: "signing",
    header: "Ký HMAC",
    accessorFn: (d) => (d.hasSigningSecret ? "yes" : "no"),
    cell: ({ row }) =>
      row.original.hasSigningSecret ? (
        <span className="text-xs">•••••• có</span>
      ) : (
        <span className="text-muted-foreground text-xs">không</span>
      ),
  },
  {
    id: "createdAt",
    header: "Tạo lúc",
    accessorFn: (d) => d.createdAt,
    cell: ({ row }) => <span className="text-xs">{formatDateTime(row.original.createdAt)}</span>,
  },
  {
    id: "actions",
    header: "",
    enableSorting: false,
    enableHiding: false,
    cell: ({ row }) => <DestinationActions dest={row.original} />,
  },
];

export default function DestinationsPage() {
  const { data, isLoading, error } = useDestinations();
  const create = useCreateDestination();
  const [open, setOpen] = useState(false);
  const form = useForm<FormIn, unknown, FormOut>({
    resolver: zodResolver(schema),
    defaultValues: { name: "", type: "webhook", config: CONFIG_TEMPLATE.webhook, signingSecret: "", rateLimitRps: "0" },
  });

  const onSubmit = (v: FormOut) =>
    create
      .mutateAsync({
        name: v.name,
        type: v.type,
        config: JSON.parse(v.config) as Record<string, unknown>,
        signingSecret: v.signingSecret || undefined,
        rateLimitRps: v.rateLimitRps,
      })
      .then(
        (d) => {
          toast.success(`Đã tạo đích "${d.name}"`);
          form.reset();
          setOpen(false);
        },
        (e: Error) => toast.error(`Tạo đích thất bại: ${e.message}`),
      );

  return (
    <>
      <PageHeader
        title="Đích (Destinations)"
        description="Nơi hub giao sự kiện tới. Config và signing secret được mã hoá, không hiển thị lại sau khi tạo."
        actions={
          <Button onClick={() => setOpen(true)}>
            <Plus />
            Thêm đích
          </Button>
        }
      />
      <DataTable
        data={data}
        columns={columns}
        getRowId={(d) => d.id}
        isLoading={isLoading}
        error={error}
        searchPlaceholder="Lọc theo tên, loại…"
        emptyText="Chưa có đích nào."
      />

      <FormDialog
        open={open}
        onOpenChange={setOpen}
        title="Thêm đích giao"
        formId="destination-form"
        submitting={create.isPending}
      >
        <form id="destination-form" noValidate onSubmit={form.handleSubmit(onSubmit)}>
          <FieldGroup className="gap-4">
            <Controller
              control={form.control}
              name="name"
              render={({ field, fieldState }) => (
                <Field className="gap-1.5" data-invalid={fieldState.invalid}>
                  <FieldLabel htmlFor="dst-name">Tên</FieldLabel>
                  <Input
                    {...field}
                    id="dst-name"
                    placeholder="VD: Kênh Telegram kế toán"
                    aria-invalid={fieldState.invalid}
                  />
                  {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
                </Field>
              )}
            />
            <Controller
              control={form.control}
              name="type"
              render={({ field }) => (
                <Field className="gap-1.5">
                  <FieldLabel>Loại</FieldLabel>
                  <Select
                    value={field.value}
                    onValueChange={(v) => {
                      const prev = field.value as DestinationType;
                      field.onChange(v);
                      // Chỉ thay mẫu config khi người dùng chưa sửa gì — không xoá công sức của họ.
                      if (form.getValues("config") === CONFIG_TEMPLATE[prev]) {
                        form.setValue("config", CONFIG_TEMPLATE[v as DestinationType]);
                      }
                    }}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {DESTINATION_TYPES.map((t) => (
                        <SelectItem key={t} value={t}>
                          {t}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
              )}
            />
            <Controller
              control={form.control}
              name="config"
              render={({ field, fieldState }) => (
                <Field className="gap-1.5" data-invalid={fieldState.invalid}>
                  <FieldLabel htmlFor="dst-config">Config (JSON)</FieldLabel>
                  <Textarea
                    {...field}
                    id="dst-config"
                    rows={5}
                    className="font-mono text-xs"
                    spellCheck={false}
                    aria-invalid={fieldState.invalid}
                  />
                  <FieldDescription>URL đích bị chặn nếu trỏ vào mạng nội bộ (SSRF guard ở worker).</FieldDescription>
                  {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
                </Field>
              )}
            />
            <Controller
              control={form.control}
              name="signingSecret"
              render={({ field }) => (
                <Field className="gap-1.5">
                  <FieldLabel htmlFor="dst-secret">Signing secret (tuỳ chọn)</FieldLabel>
                  <Input {...field} id="dst-secret" type="password" autoComplete="off" />
                  <FieldDescription>Có thì hub ký HMAC từng request gửi đi để đích xác thực.</FieldDescription>
                </Field>
              )}
            />
            <Controller
              control={form.control}
              name="rateLimitRps"
              render={({ field, fieldState }) => (
                <Field className="gap-1.5" data-invalid={fieldState.invalid}>
                  <FieldLabel htmlFor="dst-rps">Giới hạn tốc độ (request/giây)</FieldLabel>
                  <Input
                    {...field}
                    value={String(field.value ?? "")}
                    id="dst-rps"
                    type="number"
                    min={0}
                    aria-invalid={fieldState.invalid}
                  />
                  <FieldDescription>0 = không giới hạn.</FieldDescription>
                  {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
                </Field>
              )}
            />
          </FieldGroup>
        </form>
      </FormDialog>
    </>
  );
}
