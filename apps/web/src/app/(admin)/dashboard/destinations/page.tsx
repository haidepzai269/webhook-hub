"use client";

import { createContext, useContext, useMemo, useState } from "react";

import { zodResolver } from "@hookform/resolvers/zod";
import { Eye, Plus, Trash2, Webhook } from "lucide-react";
import { Controller, useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";

import { DataTable, type HubColumn } from "@/components/admin/data-table";
import { FormDialog } from "@/components/admin/form-dialog";
import { InsightCell, InsightRowsProvider } from "@/components/admin/insight-cell";
import { PageHeader } from "@/components/admin/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { formatDateTime } from "@/lib/hub/format";
import { useCreateDestination, useDeleteDestination, useDestinations } from "@/lib/hub/queries";
import { DESTINATION_TYPES, type Destination, type DestinationType } from "@/lib/hub/types";
import { describeDeleteConflict, describeVerification } from "@/lib/hub/ui-logic";
import type { Locale, MessageKey, TranslateFn } from "@/lib/i18n/dictionary";
import { useLocale, useT } from "@/lib/i18n/use-t";

import { CreateEndpointDialog, EndpointDetailDialog } from "./endpoint-dialogs";

/** KN1 (ADR-138): webhook tạo qua "Tạo endpoint webhook" (hub sinh secret + challenge); form này còn telegram/discord. */
const FORM_TYPES = DESTINATION_TYPES.filter((t) => t !== "webhook") as unknown as readonly [
  DestinationType,
  ...DestinationType[],
];
const OpenDetail = createContext<(id: string) => void>(() => undefined);

/** Khung config mẫu theo đúng key mà sender trong hub-worker đọc. */
const CONFIG_TEMPLATE: Record<DestinationType, string> = {
  webhook: '{\n  "url": "https://example.com/hooks/hub"\n}',
  telegram: '{\n  "botToken": "123456:ABC…",\n  "chatId": "-100123456"\n}',
  discord: '{\n  "webhookUrl": "https://discord.com/api/webhooks/…"\n}',
};

const makeSchema = (t: TranslateFn) =>
  z.object({
    name: z.string().trim().min(1, t("page.destinations.form.name-required")).max(255),
    type: z.enum(FORM_TYPES),
    config: z.string().refine((s) => {
      try {
        const v: unknown = JSON.parse(s);
        return v !== null && typeof v === "object" && !Array.isArray(v);
      } catch {
        return false;
      }
    }, t("page.destinations.form.config-invalid")),
    signingSecret: z.string(),
    rateLimitRps: z.coerce
      .number<string>()
      .int(t("page.destinations.form.int"))
      .min(0, t("page.destinations.form.non-negative"))
      .max(1000),
  });
type FormIn = z.input<ReturnType<typeof makeSchema>>;
type FormOut = z.output<ReturnType<typeof makeSchema>>;

const CIRCUIT_STYLE = {
  CLOSED: "border-emerald-500/40 text-emerald-700 dark:text-emerald-300",
  HALF_OPEN: "border-amber-500/40 text-amber-700 dark:text-amber-300",
  OPEN: "border-rose-500/40 text-rose-700 dark:text-rose-300",
} as const;

const VERIFY_STYLE = {
  ok: "border-emerald-500/40 text-emerald-700 dark:text-emerald-300",
  wait: "border-amber-500/40 text-amber-700 dark:text-amber-300",
  bad: "border-rose-500/40 text-rose-700 dark:text-rose-300",
} as const;

/** P2 (ADR-140): đích FAILED (vd ssrf_blocked) phải thấy được — hub KHÔNG giao tới đích chưa VERIFIED. */
function VerificationCell({ dest }: { dest: Destination }) {
  const t = useT();
  const v = describeVerification(dest.verification, dest.verificationError, t);
  return (
    <div className="flex max-w-xs flex-col gap-0.5">
      <Badge
        variant="outline"
        className={`w-fit font-mono text-[11px] ${VERIFY_STYLE[v.tone]}`}
        title={dest.verificationFix ?? v.label}
      >
        {t(v.labelKey)}
      </Badge>
      {v.reason && <span className="text-muted-foreground text-xs">{v.reason}</span>}
      {dest.verification === "FAILED" && dest.verificationError && (
        <span className="font-mono text-[11px] text-rose-700 dark:text-rose-300">{dest.verificationError}</span>
      )}
    </div>
  );
}

const CIRCUIT_DOT = { CLOSED: "bg-emerald-500", HALF_OPEN: "bg-amber-500", OPEN: "bg-rose-500" } as const;

const CIRCUIT_LABEL: Record<keyof typeof CIRCUIT_DOT, MessageKey> = {
  CLOSED: "page.destinations.circuit.closed",
  HALF_OPEN: "page.destinations.circuit.half-open",
  OPEN: "page.destinations.circuit.open",
};

const CIRCUIT_HINT: Record<keyof typeof CIRCUIT_DOT, MessageKey> = {
  CLOSED: "page.destinations.circuit-hint.closed",
  HALF_OPEN: "page.destinations.circuit-hint.half-open",
  OPEN: "page.destinations.circuit-hint.open",
};

/** Xoá đích — server chặn 409 khi còn subscription trỏ vào (ADR-054); toast nói rõ phải tắt/xoá subscription trước. */
function DestinationActions({ dest }: { dest: Destination }) {
  const t = useT();
  const del = useDeleteDestination();
  const openDetail = useContext(OpenDetail);
  const remove = () => {
    if (!window.confirm(t("page.destinations.delete-confirm", { name: dest.name }))) return;
    del.mutate(dest.id, {
      onSuccess: () => toast.success(t("page.destinations.toast.deleted", { name: dest.name })),
      onError: (e) => {
        const conflict = describeDeleteConflict(e, t);
        if (!conflict) return toast.error(t("page.destinations.toast.delete-failed", { message: e.message }));
        toast.warning(t("page.destinations.toast.delete-blocked"), { description: conflict, duration: 10_000 });
      },
    });
  };
  return (
    <div className="flex justify-end">
      {dest.type === "webhook" && (
        <Button
          size="sm"
          variant="ghost"
          onClick={() => openDetail(dest.id)}
          aria-label={t("page.destinations.detail-aria", { name: dest.name })}
          title={t("page.destinations.detail-title")}
        >
          <Eye />
        </Button>
      )}
      <Button
        size="sm"
        variant="ghost"
        disabled={del.isPending}
        onClick={remove}
        aria-label={t("page.destinations.delete-aria", { name: dest.name })}
        title={t("page.destinations.delete-title")}
      >
        <Trash2 />
      </Button>
    </div>
  );
}

const makeColumns = (t: TranslateFn, locale: Locale): HubColumn<Destination>[] => [
  {
    id: "name",
    header: t("common.name"),
    accessorFn: (d) => d.name,
    cell: ({ row }) => <span className="font-medium">{row.original.name}</span>,
    enableHiding: false,
  },
  {
    id: "type",
    header: t("page.destinations.col.type"),
    accessorFn: (d) => d.type,
    cell: ({ row }) => <Badge variant="secondary">{row.original.type}</Badge>,
  },
  {
    id: "verification",
    header: t("page.destinations.col.verification"),
    accessorFn: (d) => `${d.verification ?? "VERIFIED"} ${d.verificationError ?? ""}`,
    cell: ({ row }) => <VerificationCell dest={row.original} />,
  },
  {
    id: "circuit",
    header: t("page.destinations.col.circuit"),
    accessorFn: (d) => d.circuitState,
    // Cập nhật trực tiếp: socket `circuit.changed` invalidate danh sách đích (S2-5).
    cell: ({ row }) => (
      <Badge
        variant="outline"
        className={`gap-1.5 font-mono text-[11px] ${CIRCUIT_STYLE[row.original.circuitState]}`}
        title={`${row.original.circuitState} — ${t(CIRCUIT_HINT[row.original.circuitState])}`}
      >
        <span
          className={`size-1.5 rounded-full ${CIRCUIT_DOT[row.original.circuitState]} ${row.original.circuitState === "OPEN" ? "animate-pulse" : ""}`}
        />
        {t(CIRCUIT_LABEL[row.original.circuitState])}
      </Badge>
    ),
  },
  {
    // CB6 (SPEC §7, I-dest): nhãn một câu cho 1 giờ qua — phân loại HTTP chung với delivery.consumer (CB:T16).
    id: "insight",
    header: t("insights.col.dest"),
    enableSorting: false,
    cell: ({ row }) => <InsightCell id={row.original.id} />,
  },
  {
    id: "rateLimit",
    header: t("page.destinations.col.rate-limit"),
    accessorFn: (d) => String(d.rateLimitRps),
    cell: ({ row }) => (
      <span className="font-mono text-xs">{row.original.rateLimitRps > 0 ? row.original.rateLimitRps : "∞"}</span>
    ),
  },
  {
    id: "signing",
    header: t("page.destinations.col.signing"),
    accessorFn: (d) => (d.hasSigningSecret ? "yes" : "no"),
    cell: ({ row }) =>
      row.original.hasSigningSecret ? (
        <span className="text-xs">{t("page.destinations.signing.yes")}</span>
      ) : (
        <span className="text-muted-foreground text-xs">{t("page.destinations.signing.no")}</span>
      ),
  },
  {
    id: "createdAt",
    header: t("common.created-at"),
    accessorFn: (d) => d.createdAt,
    cell: ({ row }) => <span className="text-xs">{formatDateTime(row.original.createdAt, locale)}</span>,
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
  const t = useT();
  const locale = useLocale();
  const columns = useMemo(() => makeColumns(t, locale), [t, locale]);
  const schema = useMemo(() => makeSchema(t), [t]);
  const { data, isLoading, error } = useDestinations();
  const create = useCreateDestination();
  const [open, setOpen] = useState(false);
  const [endpointOpen, setEndpointOpen] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const form = useForm<FormIn, unknown, FormOut>({
    resolver: zodResolver(schema),
    defaultValues: {
      name: "",
      type: "telegram",
      config: CONFIG_TEMPLATE.telegram,
      signingSecret: "",
      rateLimitRps: "0",
    },
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
          toast.success(t("page.destinations.toast.created", { name: d.name }));
          form.reset();
          setOpen(false);
        },
        (e: Error) => toast.error(t("page.destinations.toast.create-failed", { message: e.message })),
      );

  return (
    <>
      <PageHeader
        title={t("page.destinations.title")}
        description={t("page.destinations.description")}
        actions={
          <div className="flex gap-2">
            <Button onClick={() => setEndpointOpen(true)}>
              <Webhook />
              {t("page.destinations.create-endpoint")}
            </Button>
            <Button variant="outline" onClick={() => setOpen(true)}>
              <Plus />
              {t("page.destinations.add-chat")}
            </Button>
          </div>
        }
      />
      <CreateEndpointDialog open={endpointOpen} onOpenChange={setEndpointOpen} />
      <EndpointDetailDialog id={detailId} onClose={() => setDetailId(null)} />
      <OpenDetail.Provider value={setDetailId}>
        <InsightRowsProvider code="I-dest">
          <DataTable
            data={data}
            columns={columns}
            getRowId={(d) => d.id}
            isLoading={isLoading}
            error={error}
            searchPlaceholder={t("page.destinations.search")}
            emptyText={t("page.destinations.empty")}
          />
        </InsightRowsProvider>
      </OpenDetail.Provider>

      <FormDialog
        open={open}
        onOpenChange={setOpen}
        title={t("page.destinations.form.title")}
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
                  <FieldLabel htmlFor="dst-name">{t("common.name")}</FieldLabel>
                  <Input
                    {...field}
                    id="dst-name"
                    placeholder={t("page.destinations.form.name-placeholder")}
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
                  <FieldLabel>{t("page.destinations.col.type")}</FieldLabel>
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
                      {FORM_TYPES.map((type) => (
                        <SelectItem key={type} value={type}>
                          {type}
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
                  <FieldLabel htmlFor="dst-config">{t("page.destinations.form.config")}</FieldLabel>
                  <Textarea
                    {...field}
                    id="dst-config"
                    rows={5}
                    className="font-mono text-xs"
                    spellCheck={false}
                    aria-invalid={fieldState.invalid}
                  />
                  <FieldDescription>{t("page.destinations.form.config-hint")}</FieldDescription>
                  {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
                </Field>
              )}
            />
            <Controller
              control={form.control}
              name="signingSecret"
              render={({ field }) => (
                <Field className="gap-1.5">
                  <FieldLabel htmlFor="dst-secret">{t("page.destinations.form.secret")}</FieldLabel>
                  <Input {...field} id="dst-secret" type="password" autoComplete="off" />
                  <FieldDescription>{t("page.destinations.form.secret-hint")}</FieldDescription>
                </Field>
              )}
            />
            <Controller
              control={form.control}
              name="rateLimitRps"
              render={({ field, fieldState }) => (
                <Field className="gap-1.5" data-invalid={fieldState.invalid}>
                  <FieldLabel htmlFor="dst-rps">{t("page.destinations.form.rps")}</FieldLabel>
                  <Input
                    {...field}
                    value={String(field.value ?? "")}
                    id="dst-rps"
                    type="number"
                    min={0}
                    aria-invalid={fieldState.invalid}
                  />
                  <FieldDescription>{t("page.destinations.form.rps-hint")}</FieldDescription>
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
