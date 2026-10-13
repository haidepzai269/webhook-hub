"use client";

import { createContext, useContext, useMemo, useState } from "react";

import { zodResolver } from "@hookform/resolvers/zod";
import { Activity, Ear, Link2, Plug, Plus } from "lucide-react";
import { type Control, Controller, useForm, useWatch } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";

import { CopyButton } from "@/components/admin/copy-button";
import { DataTable, type HubColumn } from "@/components/admin/data-table";
import { FormDialog } from "@/components/admin/form-dialog";
import { InsightCell, InsightRowsProvider } from "@/components/admin/insight-cell";
import { PageHeader } from "@/components/admin/page-header";
import { KeepLongerSwitch } from "@/components/storage/keep-longer-switch";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { credentialInputAttrs } from "@/lib/credential-input";
import { HUB_API_URL } from "@/lib/env";
import { formatDateTime } from "@/lib/hub/format";
import { useCreateSource, useSources } from "@/lib/hub/queries";
import { useFlowProjectStore } from "@/lib/hub/flow-project";
import { useMeStore } from "@/lib/hub/me-store";
import { useCanViewTraffic } from "@/lib/hub/traffic-queries";
import { useSetKeepLonger, useStorage } from "@/lib/hub/storage-queries";
import {
  buildGenericConfig,
  GENERIC_SCHEMES,
  type GenericFormIssue,
  type GenericFormValues,
  genericFormIssues,
  HMAC_ALGO_CHOICES,
  KEY_ENCODING_CHOICES,
  TOKEN_LOCATION_CHOICES,
} from "@/lib/hub/listen-logic";
import { PROVIDERS, type Source } from "@/lib/hub/types";
import type { Locale, MessageKey, TranslateFn } from "@/lib/i18n/dictionary";
import { useLocale, useT } from "@/lib/i18n/use-t";
import { sourceCountVars } from "@/lib/storage/storage-logic";

import { ConnectionDialog, ConnectSourceDialog } from "./connect-dialogs";
import { GenericFields } from "./generic-fields";
import { ListenSheet } from "./listen-sheet";
import { TrafficSheet } from "./traffic-sheet";

/** KN2: nút "Kết nối" trên từng dòng mở hộp tình trạng kết nối. */
const OpenConnection = createContext<(id: string) => void>(() => undefined);
function ConnectionButton({ id }: { id: string }) {
  const open = useContext(OpenConnection);
  const t = useT();
  return (
    <Button
      size="sm"
      variant="ghost"
      onClick={() => open(id)}
      title={t("page.sources.connection-button")}
      aria-label={t("page.sources.connection-button")}
    >
      <Link2 />
    </Button>
  );
}

/** EG5 (ADR-181): nút "Lưu lượng" trên từng dòng mở khối Lưu lượng của nguồn (không tạo trang mới). */
const OpenTraffic = createContext<(id: string) => void>(() => undefined);
function TrafficButton({ id }: { id: string }) {
  const open = useContext(OpenTraffic);
  const t = useT();
  return (
    <Button
      size="sm"
      variant="ghost"
      onClick={() => open(id)}
      title={t("traffic.button")}
      aria-label={t("traffic.button")}
    >
      <Activity />
    </Button>
  );
}

/** PK1 (ADR-202): nút "Lắng nghe" — chỉ trên dòng nguồn generic ("Nhà cung cấp khác"). */
const OpenListen = createContext<(id: string) => void>(() => undefined);
function ListenButton({ id }: { id: string }) {
  const open = useContext(OpenListen);
  const t = useT();
  return (
    <Button size="sm" variant="ghost" onClick={() => open(id)} title={t("page.sources.listen-button")} aria-label={t("page.sources.listen-button")}>
      <Ear />
    </Button>
  );
}

const SECRET_HINT: Record<(typeof PROVIDERS)[number], MessageKey> = {
  github: "page.sources.secret-hint.github",
  sepay: "page.sources.secret-hint.sepay",
  payos: "page.sources.secret-hint.payos",
  stripe: "page.sources.secret-hint.stripe",
  generic: "page.sources.secret-hint.generic",
};

/** Nhãn nhà cung cấp: `generic` hiện là "Nhà cung cấp khác" (PK1), còn lại giữ tên kỹ thuật. */
const providerLabel = (t: TranslateFn, p: string) => (p === "generic" ? t("page.sources.provider.generic") : p);

const ISSUE_KEY: Record<GenericFormIssue, MessageKey> = {
  "header-required": "page.sources.generic.header-required",
  "prefix-too-long": "page.sources.generic.prefix-too-long",
  "param-required": "page.sources.generic.param-required",
  "id-required": "page.sources.generic.id-required",
  "event-type-invalid": "page.sources.generic.event-type-invalid",
  "event-type-reserved": "page.sources.generic.event-type-reserved",
  "secret-hex": "page.sources.generic.secret-hex",
  "secret-base64": "page.sources.generic.secret-base64",
  "secret-basic": "page.sources.generic.secret-basic",
};

/**
 * PK1 (SPEC-provider-khac §3.1) + PK2 (§4, ADR-203): form tay cho "Nhà cung cấp khác" (generic) — scheme, tham số HMAC
 * (algo, mã hoá, tiền tố, cách đọc khoá), vị trí token (tiêu đề / Basic / query), khoá chống trùng, eventType. PK7 thay
 * bằng form nhận diện. Kiểm ở client theo cùng luật server (`genericFormIssues`); server vẫn là trọng tài, 422 có tên trường.
 */
const makeSchema = (t: TranslateFn) =>
  z
    .object({
      provider: z.enum(PROVIDERS),
      name: z.string().trim().min(1, t("page.sources.form.name-required")).max(255),
      secret: z.string().min(8, t("page.sources.form.secret-min")),
      scheme: z.enum(GENERIC_SCHEMES),
      header: z.string(),
      encoding: z.enum(["hex", "base64"]),
      algo: z.enum(HMAC_ALGO_CHOICES),
      prefix: z.string(),
      keyEncoding: z.enum(KEY_ENCODING_CHOICES),
      location: z.enum(TOKEN_LOCATION_CHOICES),
      param: z.string(),
      idKind: z.enum(["header", "field"]),
      idValue: z.string(),
      eventType: z.string(),
    })
    .superRefine(({ provider, name: _n, secret, ...v }, ctx) => {
      if (provider !== "generic") return;
      for (const { path, issue } of genericFormIssues(v, secret)) {
        ctx.addIssue({ code: "custom", path: [path], message: t(ISSUE_KEY[issue]) });
      }
    });
type Values = z.infer<ReturnType<typeof makeSchema>>;

const fullUrl = (s: Source) => `${HUB_API_URL}${s.webhookUrl}`;

const makeColumns = (t: TranslateFn, locale: Locale, canTraffic: boolean): HubColumn<Source>[] => [
  {
    id: "name",
    header: t("common.name"),
    accessorFn: (s) => s.name,
    cell: ({ row }) => <span className="font-medium">{row.original.name}</span>,
    enableHiding: false,
  },
  {
    id: "provider",
    header: t("page.sources.col.provider"),
    accessorFn: (s) => s.provider,
    cell: ({ row }) => <Badge variant="secondary">{providerLabel(t, row.original.provider)}</Badge>,
  },
  {
    id: "webhookUrl",
    header: t("page.sources.col.webhook-url"),
    accessorFn: (s) => s.webhookUrl,
    cell: ({ row }) => (
      // URL dài không quyết định bề rộng bảng (span w-0 flex-1): cột co về tối thiểu 11rem khi trang hẹp, phần dư cắt "…"
      // (đủ trong title + nút chép) — để cột "Nhịp sự kiện" không bị đẩy ra ngoài mép phải ở 1280–1440px.
      <div className="flex w-full min-w-44 max-w-md items-center gap-1">
        <span className="w-0 flex-1 truncate font-mono text-xs" title={fullUrl(row.original)}>
          {fullUrl(row.original)}
        </span>
        <CopyButton value={fullUrl(row.original)} label={t("page.sources.copy-url")} />
      </div>
    ),
  },
  {
    id: "secret",
    header: t("page.sources.col.secret"),
    accessorFn: (s) => String(s.secretVersions ?? 0),
    cell: ({ row }) => (
      <span className="text-muted-foreground text-xs">
        •••••• {row.original.secretVersions ? `(v${row.original.secretVersions})` : ""}
      </span>
    ),
  },
  {
    id: "isActive",
    header: t("common.status"),
    accessorFn: (s) => (s.isActive ? "active" : "inactive"),
    cell: ({ row }) =>
      row.original.isActive ? (
        <Badge variant="outline">{t("common.enabled")}</Badge>
      ) : (
        <Badge variant="destructive">{t("page.sources.inactive")}</Badge>
      ),
  },
  {
    // QT7 (§9, E1): công tắc "Giữ lâu" — câu đánh đổi ở title; đổi cần owner/người vận hành (server kiểm storage:write).
    id: "keepLonger",
    header: t("page.storage.keep-longer"),
    accessorFn: (s) => (s.keepLonger ? "1" : "0"),
    cell: ({ row }) => <KeepLongerCell source={row.original} />,
  },
  {
    // CB6 (SPEC §7, I-silent): "Sự kiện cuối …" so với nhịp của chính nguồn (cùng baseline với luật source.silent).
    id: "insight",
    header: t("insights.col.silent"),
    enableSorting: false,
    cell: ({ row }) => <InsightCell id={row.original.id} />,
  },
  {
    id: "createdAt",
    header: t("common.created-at"),
    accessorFn: (s) => s.createdAt,
    cell: ({ row }) => <span className="text-xs">{formatDateTime(row.original.createdAt, locale)}</span>,
  },
  {
    id: "connection",
    header: "",
    enableSorting: false,
    enableHiding: false,
    cell: ({ row }) => (
      <div className="flex">
        {row.original.provider === "generic" && <ListenButton id={row.original.id} />}
        {canTraffic && <TrafficButton id={row.original.id} />}
        <ConnectionButton id={row.original.id} />
      </div>
    ),
  },
];

function KeepLongerCell({ source }: { source: Source }) {
  const t = useT();
  const projectId = useFlowProjectStore((s) => s.projectId);
  const me = useMeStore((s) => s.me);
  const canWrite = me?.user.isOperator === true || (me?.memberships ?? []).some((m) => m.projectId === projectId && m.role === "owner");
  const keep = useSetKeepLonger();
  return (
    <KeepLongerSwitch
      checked={source.keepLonger === true}
      disabled={!canWrite || keep.isPending}
      onChange={(v) =>
        keep.mutate(
          { id: source.id, keepLonger: v },
          {
            onSuccess: () => toast.success(t(v ? "page.storage.keep-longer.on" : "page.storage.keep-longer.off", { name: source.name })),
            onError: (e) => toast.error(e.message),
          },
        )
      }
    />
  );
}

/** QT9/QT7 (§10): "N/20 nguồn" — từ `GET …/storage` (viewer không có storage:read -> không hiện). */
function SourceCount() {
  const t = useT();
  const projectId = useFlowProjectStore((s) => s.projectId);
  const vars = sourceCountVars(useStorage(projectId).data);
  return vars ? <span className="self-center text-muted-foreground text-sm tabular-nums">{t("page.storage.sources-count", vars)}</span> : null;
}

export default function SourcesPage() {
  const t = useT();
  const locale = useLocale();
  const canTraffic = useCanViewTraffic();
  const columns = useMemo(() => makeColumns(t, locale, canTraffic), [t, locale, canTraffic]);
  const schema = useMemo(() => makeSchema(t), [t]);
  const { data, isLoading, error } = useSources();
  const create = useCreateSource();
  const [open, setOpen] = useState(false);
  const [connectOpen, setConnectOpen] = useState(false);
  const [connectionId, setConnectionId] = useState<string | null>(null);
  const [preset, setPreset] = useState<{ provider: string; sourceId: string } | null>(null);
  const connectionSource = data?.find((s) => s.id === connectionId) ?? null;
  const [trafficId, setTrafficId] = useState<string | null>(null);
  const trafficSource = data?.find((s) => s.id === trafficId) ?? null;
  const [listenId, setListenId] = useState<string | null>(null);
  const listenSource = data?.find((s) => s.id === listenId) ?? null;
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: {
      provider: "github",
      name: "",
      secret: "",
      scheme: "hmac",
      header: "",
      encoding: "hex",
      algo: "sha256",
      prefix: "",
      keyEncoding: "utf8",
      location: "header",
      param: "",
      idKind: "field",
      idValue: "",
      eventType: "",
    },
  });
  // useWatch thay vì form.watch: React Compiler memo hoá form.watch → gợi ý không đổi theo provider.
  const provider = useWatch({ control: form.control, name: "provider" });
  const scheme = useWatch({ control: form.control, name: "scheme" });

  // PK1: chỉ generic gửi `verificationConfig` (dựng từ các ô tay); provider khác giữ đúng body cũ.
  const onSubmit = ({ provider: p, name, secret, ...generic }: Values) =>
    create.mutateAsync({ provider: p, name, secret, ...(p === "generic" ? { verificationConfig: buildGenericConfig(generic) } : {}) }).then(
      (src) => {
        toast.success(t("page.sources.toast.created", { name: src.name }), {
          description: t("page.sources.toast.created-url", {
            url: `${HUB_API_URL}/hooks/${src.provider}/${src.sourceKey}`,
          }),
        });
        form.reset();
        setOpen(false);
        // Review PK1 T-3: thước đo là "request đầu tiên ✓" — mở ngay Lắng nghe của nguồn generic vừa tạo.
        if (src.provider === "generic") setListenId(src.id);
      },
      (e: Error) => toast.error(t("page.sources.toast.create-failed", { message: e.message })),
    );

  return (
    <>
      <PageHeader
        title={t("page.sources.title")}
        description={t("page.sources.description")}
        actions={
          <div className="flex gap-2">
            <SourceCount />
            <Button onClick={() => (setPreset(null), setConnectOpen(true))}>
              <Plug />
              {t("page.sources.connect-provider")}
            </Button>
            <Button variant="outline" onClick={() => setOpen(true)}>
              <Plus />
              {t("page.sources.add-manual")}
            </Button>
          </div>
        }
      />
      <ConnectSourceDialog
        key={preset?.sourceId ?? "new"}
        open={connectOpen}
        onOpenChange={setConnectOpen}
        preset={preset}
      />
      <ConnectionDialog
        source={connectionSource}
        onClose={() => setConnectionId(null)}
        onConnect={(s) => (setPreset({ provider: s.provider, sourceId: s.id }), setConnectOpen(true))}
      />
      <TrafficSheet source={trafficSource} onClose={() => setTrafficId(null)} />
      <ListenSheet source={listenSource} onClose={() => setListenId(null)} />
      <OpenListen.Provider value={setListenId}>
      <OpenTraffic.Provider value={setTrafficId}>
        <OpenConnection.Provider value={setConnectionId}>
          <InsightRowsProvider code="I-silent">
            <DataTable
              data={data}
              columns={columns}
              getRowId={(s) => s.id}
              isLoading={isLoading}
              error={error}
              searchPlaceholder={t("page.sources.search")}
              emptyText={t("page.sources.empty")}
            />
          </InsightRowsProvider>
        </OpenConnection.Provider>
      </OpenTraffic.Provider>
      </OpenListen.Provider>

      <FormDialog
        open={open}
        onOpenChange={setOpen}
        title={t("page.sources.form.title")}
        description={t("page.sources.form.description")}
        formId="source-form"
        submitting={create.isPending}
      >
        <form id="source-form" noValidate autoComplete="off" onSubmit={form.handleSubmit(onSubmit)}>
          <FieldGroup className="gap-4">
            <Controller
              control={form.control}
              name="provider"
              render={({ field }) => (
                <Field className="gap-1.5">
                  <FieldLabel>{t("page.sources.col.provider")}</FieldLabel>
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {PROVIDERS.map((p) => (
                        <SelectItem key={p} value={p}>
                          {providerLabel(t, p)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
              )}
            />
            <Controller
              control={form.control}
              name="name"
              render={({ field, fieldState }) => (
                <Field className="gap-1.5" data-invalid={fieldState.invalid}>
                  <FieldLabel htmlFor="src-name">{t("common.name")}</FieldLabel>
                  <Input
                    {...field}
                    id="src-name"
                    placeholder={t("page.sources.form.name-placeholder")}
                    aria-invalid={fieldState.invalid}
                  />
                  {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
                </Field>
              )}
            />
            <Controller
              control={form.control}
              name="secret"
              render={({ field, fieldState }) => (
                <Field className="gap-1.5" data-invalid={fieldState.invalid}>
                  <FieldLabel htmlFor="src-secret">{t("page.sources.col.secret")}</FieldLabel>
                  <Input
                    {...field}
                    {...credentialInputAttrs("source", "secret", true)}
                    id="src-secret"
                    aria-invalid={fieldState.invalid}
                  />
                  <FieldDescription>{t(SECRET_HINT[provider])}</FieldDescription>
                  {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
                </Field>
              )}
            />
            {provider === "generic" && <GenericFields control={form.control as unknown as Control<GenericFormValues>} scheme={scheme} />}
          </FieldGroup>
        </form>
      </FormDialog>
    </>
  );
}
