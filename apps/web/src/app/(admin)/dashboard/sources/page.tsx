"use client";

import { createContext, useContext, useState } from "react";

import { zodResolver } from "@hookform/resolvers/zod";
import { Link2, Plug, Plus } from "lucide-react";
import { Controller, useForm, useWatch } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";

import { CopyButton } from "@/components/admin/copy-button";
import { DataTable, type HubColumn } from "@/components/admin/data-table";
import { FormDialog } from "@/components/admin/form-dialog";
import { PageHeader } from "@/components/admin/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { HUB_API_URL } from "@/lib/env";
import { formatDateTime } from "@/lib/hub/format";
import { useCreateSource, useSources } from "@/lib/hub/queries";
import { PROVIDERS, type Source } from "@/lib/hub/types";

import { ConnectionDialog, ConnectSourceDialog } from "./connect-dialogs";

/** KN2: nút "Kết nối" trên từng dòng mở hộp tình trạng kết nối. */
const OpenConnection = createContext<(id: string) => void>(() => undefined);
function ConnectionButton({ id }: { id: string }) {
  const open = useContext(OpenConnection);
  return (
    <Button size="sm" variant="ghost" onClick={() => open(id)} title="Kết nối provider (hub tự đăng ký URL)">
      <Link2 />
    </Button>
  );
}

const SECRET_HINT: Record<(typeof PROVIDERS)[number], string> = {
  github: "Webhook secret đặt trong GitHub (HMAC-SHA256 trên raw body).",
  sepay: "API key SePay (header Authorization: Apikey …).",
  payos: "Checksum key của PayOS.",
  stripe: "Signing secret của endpoint Stripe (whsec_…).",
};

const schema = z.object({
  provider: z.enum(PROVIDERS),
  name: z.string().trim().min(1, "Nhập tên nguồn.").max(255),
  secret: z.string().min(8, "Secret tối thiểu 8 ký tự."),
});
type Values = z.infer<typeof schema>;

const fullUrl = (s: Source) => `${HUB_API_URL}${s.webhookUrl}`;

const columns: HubColumn<Source>[] = [
  {
    id: "name",
    header: "Tên",
    accessorFn: (s) => s.name,
    cell: ({ row }) => <span className="font-medium">{row.original.name}</span>,
    enableHiding: false,
  },
  {
    id: "provider",
    header: "Provider",
    accessorFn: (s) => s.provider,
    cell: ({ row }) => <Badge variant="secondary">{row.original.provider}</Badge>,
  },
  {
    id: "webhookUrl",
    header: "Webhook URL (dán vào provider)",
    accessorFn: (s) => s.webhookUrl,
    cell: ({ row }) => (
      <div className="flex max-w-md items-center gap-1">
        <span className="truncate font-mono text-xs" title={fullUrl(row.original)}>
          {fullUrl(row.original)}
        </span>
        <CopyButton value={fullUrl(row.original)} label="Sao chép webhook URL" />
      </div>
    ),
  },
  {
    id: "secret",
    header: "Secret",
    accessorFn: (s) => String(s.secretVersions ?? 0),
    cell: ({ row }) => (
      <span className="text-muted-foreground text-xs">
        •••••• {row.original.secretVersions ? `(v${row.original.secretVersions})` : ""}
      </span>
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
    id: "connection",
    header: "",
    enableSorting: false,
    enableHiding: false,
    cell: ({ row }) => <ConnectionButton id={row.original.id} />,
  },
];

export default function SourcesPage() {
  const { data, isLoading, error } = useSources();
  const create = useCreateSource();
  const [open, setOpen] = useState(false);
  const [connectOpen, setConnectOpen] = useState(false);
  const [connectionId, setConnectionId] = useState<string | null>(null);
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { provider: "github", name: "", secret: "" },
  });
  // useWatch thay vì form.watch: React Compiler memo hoá form.watch → gợi ý không đổi theo provider.
  const provider = useWatch({ control: form.control, name: "provider" });

  const onSubmit = (values: Values) =>
    create.mutateAsync(values).then(
      (src) => {
        toast.success(`Đã tạo nguồn "${src.name}"`, {
          description: `Webhook URL: ${HUB_API_URL}/hooks/${src.provider}/${src.sourceKey}`,
        });
        form.reset();
        setOpen(false);
      },
      (e: Error) => toast.error(`Tạo nguồn thất bại: ${e.message}`),
    );

  return (
    <>
      <PageHeader
        title="Nguồn (Sources)"
        description="Mỗi nguồn là một endpoint nhận webhook của một provider. Secret được mã hoá AES-256-GCM, không bao giờ hiển thị lại."
        actions={
          <div className="flex gap-2">
            <Button onClick={() => setConnectOpen(true)}>
              <Plug />
              Kết nối provider
            </Button>
            <Button variant="outline" onClick={() => setOpen(true)}>
              <Plus />
              Thêm nguồn (dán URL tay)
            </Button>
          </div>
        }
      />
      <ConnectSourceDialog open={connectOpen} onOpenChange={setConnectOpen} />
      <ConnectionDialog sourceId={connectionId} onClose={() => setConnectionId(null)} />
      <OpenConnection.Provider value={setConnectionId}>
        <DataTable
          data={data}
          columns={columns}
          getRowId={(s) => s.id}
          isLoading={isLoading}
          error={error}
          searchPlaceholder="Lọc theo tên, provider…"
          emptyText="Chưa có nguồn nào."
        />
      </OpenConnection.Provider>

      <FormDialog
        open={open}
        onOpenChange={setOpen}
        title="Thêm nguồn webhook"
        description="Sau khi tạo, dán Webhook URL vào trang cấu hình webhook của provider."
        formId="source-form"
        submitting={create.isPending}
      >
        <form id="source-form" noValidate onSubmit={form.handleSubmit(onSubmit)}>
          <FieldGroup className="gap-4">
            <Controller
              control={form.control}
              name="provider"
              render={({ field }) => (
                <Field className="gap-1.5">
                  <FieldLabel>Provider</FieldLabel>
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {PROVIDERS.map((p) => (
                        <SelectItem key={p} value={p}>
                          {p}
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
                  <FieldLabel htmlFor="src-name">Tên</FieldLabel>
                  <Input
                    {...field}
                    id="src-name"
                    placeholder="VD: GitHub repo chính"
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
                  <FieldLabel htmlFor="src-secret">Secret</FieldLabel>
                  <Input
                    {...field}
                    id="src-secret"
                    type="password"
                    autoComplete="off"
                    aria-invalid={fieldState.invalid}
                  />
                  <FieldDescription>{SECRET_HINT[provider]}</FieldDescription>
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
