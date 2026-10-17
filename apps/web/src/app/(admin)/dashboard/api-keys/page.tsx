"use client";

import { useMemo, useState } from "react";

import { Ban, Plus } from "lucide-react";
import { toast } from "sonner";

import { useAuthBooting } from "@/components/admin/auth-guard";
import { FormDialog } from "@/components/admin/form-dialog";
import { CopyButton } from "@/components/admin/copy-button";
import { PageHeader } from "@/components/admin/page-header";
import { ErrorState } from "@/components/admin/state";
import { DataTable, type HubColumn } from "@/components/admin/data-table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { ConfirmDialog } from "@/components/admin/confirm-dialog";
import { useFlowProjectStore, useProjects } from "@/lib/hub/flow-project";
import { TimeCell } from "@/components/admin/time-cell";
import {
  type ApiKeySummary,
  envLine,
  KEY_SCOPES,
  keyStatus,
  prefixTail,
  SHOP_DEFAULT_SCOPES,
} from "@/lib/hub/keys-logic";
import { useApiKeys, useCreateApiKey, useRevokeApiKey } from "@/lib/hub/project-queries";
import { useLocale, useT } from "@/lib/i18n/use-t";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/** Hộp "Chỉ hiện một lần" — key thô chỉ sống trong state của hộp này; đóng là mất (SK1, SPEC §3). */
function ConnectionStringOnce({ connectionString }: { connectionString: string }) {
  const line = envLine(connectionString);
  const t = useT();
  return (
    <Alert variant="warning">
      <AlertTitle>{t("page.api-keys.once.title")}</AlertTitle>
      <AlertDescription className="w-full">
        <div className="flex w-full items-center gap-2">
          <code className="flex-1 overflow-x-auto rounded bg-muted px-2 py-1 font-mono text-foreground text-xs">{line}</code>
          <CopyButton value={line} label={t("page.api-keys.once.copy")} />
        </div>
        <p className="text-xs">
          {t("page.api-keys.once.hint-before")} <b>{t("page.api-keys.once.hint-target")}</b> {t("page.api-keys.once.hint-after")}
        </p>
      </AlertDescription>
    </Alert>
  );
}

/** SK1 (SPEC-shop-ket-noi-project §3): API key của project ĐANG CHỌN — tạo (copy connection string một lần), thu hồi. */
export default function ApiKeysPage() {
  const t = useT();
  const _locale = useLocale();
  const projectId = useFlowProjectStore((s) => s.projectId);
  const project = useProjects().data?.find((p) => p.id === projectId);
  const keys = useApiKeys(projectId);
  const { data, error } = keys;
  const booting = useAuthBooting();
  // ADR-238: query tắt khi chưa có project (AuthGuard đang chọn) — vẫn là "đang tải", không phải "chưa có khoá".
  const isLoading = keys.isLoading || (!data && !projectId && booting);
  const create = useCreateApiKey(projectId);
  const revoke = useRevokeApiKey(projectId);
  const [open, setOpen] = useState(false);
  const [serviceName, setServiceName] = useState("shop");
  const [scopes, setScopes] = useState<string[]>(SHOP_DEFAULT_SCOPES);
  const [connectionString, setConnectionString] = useState<string | null>(null);
  const [target, setTarget] = useState<ApiKeySummary | null>(null);

  const close = (o: boolean) => {
    if (create.isPending) return;
    if (!o) {
      setConnectionString(null); // key thô biến mất cùng hộp
      setServiceName("shop");
      setScopes(SHOP_DEFAULT_SCOPES);
    }
    setOpen(o);
  };
  const columns = useMemo<HubColumn<ApiKeySummary>[]>(
    () => [
      {
        id: "service",
        header: t("page.api-keys.col.service"),
        accessorFn: (k) => k.serviceName,
        cell: ({ row }) => <span className="font-medium">{row.original.serviceName}</span>,
        enableHiding: false,
      },
      {
        id: "scopes",
        header: t("page.api-keys.col.scopes"),
        enableSorting: false,
        cell: ({ row }) => (
          <div className="flex flex-wrap gap-1">
            {row.original.scopes.map((s) => (
              <Badge key={s} variant="secondary" className="font-mono text-[10px]">
                {s}
              </Badge>
            ))}
          </div>
        ),
      },
      {
        id: "key",
        header: t("page.api-keys.col.key"),
        enableSorting: false,
        cell: ({ row }) => <span className="font-mono text-xs">…{prefixTail(row.original.keyPrefix)}</span>,
      },
      {
        id: "lastUsed",
        header: t("page.api-keys.col.last-used"),
        accessorFn: (k) => k.lastUsedAt ?? "",
        cell: ({ row }) =>
          row.original.lastUsedAt ? <TimeCell iso={row.original.lastUsedAt} /> : <span className="text-xs">{t("page.api-keys.never-used")}</span>,
      },
      {
        id: "status",
        header: t("common.status"),
        accessorFn: (k) => t(keyStatus(k)),
        cell: ({ row }) => <Badge variant={row.original.revokedAt ? "destructive" : "outline"}>{t(keyStatus(row.original))}</Badge>,
      },
      {
        id: "actions",
        header: "",
        enableHiding: false,
        enableSorting: false,
        cell: ({ row }) =>
          !row.original.revokedAt && (
            <div className="text-right">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button size="sm" variant="ghost" onClick={() => setTarget(row.original)}>
                    <Ban />
                    {t("page.api-keys.revoke")}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{t("page.api-keys.revoke-title")}</TooltipContent>
              </Tooltip>
            </div>
          ),
      },
    ],
    [t],
  );

  const toggle = (s: string) => setScopes((cur) => (cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]));
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    create.mutate(
      { serviceName: serviceName.trim(), scopes },
      {
        onSuccess: (k) => setConnectionString(k.connectionString),
        onError: (err) => toast.error(t("page.api-keys.create-failed", { message: err.message })),
      },
    );
  };

  return (
    <>
      <PageHeader
        title={t("page.api-keys.title")}
        description={
          project
            ? t("page.api-keys.description", { name: project.name, slug: project.slug })
            : t("page.api-keys.description-loading")
        }
        actions={
          <Button onClick={() => setOpen(true)} disabled={!projectId}>
            <Plus />
            {t("page.api-keys.create")}
          </Button>
        }
      />
      {error && <ErrorState className="mb-3" message={t("page.api-keys.load-error", { message: error.message })} onRetry={() => void keys.refetch()} />}
      <DataTable
        data={data}
        columns={columns}
        getRowId={(k) => k.id}
        isLoading={isLoading}
        pageSize={false}
        emptyText={t("page.api-keys.empty")}
        rowClassName={(k) => (k.revokedAt ? "opacity-60" : undefined)}
      />

      <FormDialog
        open={open}
        onOpenChange={close}
        title={t("page.api-keys.create")}
        description={t("page.api-keys.dialog.description")}
        formId="key-form"
        submitting={create.isPending}
        submittingLabel={t("common.creating")}
        submitLabel={t("page.api-keys.create-submit")}
        submitDisabled={!serviceName.trim() || scopes.length === 0}
        footer={
          connectionString ? (
            <Button type="button" onClick={() => close(false)}>
              {t("page.api-keys.copied-close")}
            </Button>
          ) : undefined
        }
      >
        {connectionString ? (
          <ConnectionStringOnce connectionString={connectionString} />
        ) : (
          <form id="key-form" noValidate autoComplete="off" onSubmit={submit}>
            <FieldGroup className="gap-4">
              <Field className="gap-1.5">
                <FieldLabel htmlFor="key-service">{t("page.api-keys.field.service")}</FieldLabel>
                <Input
                  id="key-service"
                  name="hub-key-service-name"
                  autoComplete="off"
                  value={serviceName}
                  onChange={(e) => setServiceName(e.target.value)}
                />
              </Field>
              <Field className="gap-1.5">
                <FieldLabel>{t("page.api-keys.field.scopes")}</FieldLabel>
                {KEY_SCOPES.map(({ scope, hintKey }) => (
                  <label key={scope} className="flex items-center gap-2 text-sm">
                    <Checkbox checked={scopes.includes(scope)} onCheckedChange={() => toggle(scope)} />
                    <span className="font-mono text-xs">{scope}</span>
                    <span className="text-muted-foreground text-xs">— {t(hintKey)}</span>
                  </label>
                ))}
                <FieldDescription>{t("page.api-keys.field.scopes-hint")}</FieldDescription>
              </Field>
            </FieldGroup>
          </form>
        )}
      </FormDialog>

      <ConfirmDialog
        open={Boolean(target)}
        onOpenChange={(o) => !o && setTarget(null)}
        title={t("page.api-keys.revoke-confirm", { service: target?.serviceName ?? "" })}
        description={t("page.api-keys.revoke-warning", { tail: target ? prefixTail(target.keyPrefix) : "" })}
        confirmLabel={t("page.api-keys.revoke")}
        destructive
        pending={revoke.isPending}
        onConfirm={() => {
          if (!target) return;
          revoke.mutate(target.id, {
            onSuccess: () => {
              toast.success(t("page.api-keys.revoked"));
              setTarget(null);
            },
            onError: (err) => toast.error(t("page.api-keys.revoke-failed", { message: err.message })),
          });
        }}
      />
    </>
  );
}
