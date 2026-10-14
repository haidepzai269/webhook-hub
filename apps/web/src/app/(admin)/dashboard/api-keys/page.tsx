"use client";

import { useState } from "react";

import { Ban, Plus } from "lucide-react";
import { toast } from "sonner";

import { AdminDialogContent } from "@/components/admin/overlay-content";
import { CopyButton } from "@/components/admin/copy-button";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useFlowProjectStore, useProjects } from "@/lib/hub/flow-project";
import { formatDateTime } from "@/lib/hub/format";
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

/** Hộp "Chỉ hiện một lần" — key thô chỉ sống trong state của hộp này; đóng là mất (SK1, SPEC §3). */
function ConnectionStringOnce({ connectionString }: { connectionString: string }) {
  const line = envLine(connectionString);
  const t = useT();
  return (
    <div className="rounded-md border border-amber-500/50 bg-amber-500/5 p-3 text-sm">
      <p className="mb-2 font-medium">{t("page.api-keys.once.title")}</p>
      <div className="flex items-center gap-2">
        <code className="flex-1 overflow-x-auto rounded bg-muted px-2 py-1 font-mono text-xs">{line}</code>
        <CopyButton value={line} label={t("page.api-keys.once.copy")} />
      </div>
      <p className="mt-2 text-muted-foreground text-xs">
        {t("page.api-keys.once.hint-before")} <b>{t("page.api-keys.once.hint-target")}</b>{" "}
        {t("page.api-keys.once.hint-after")}
      </p>
    </div>
  );
}

/** SK1 (SPEC-shop-ket-noi-project §3): API key của project ĐANG CHỌN — tạo (copy connection string một lần), thu hồi. */
export default function ApiKeysPage() {
  const t = useT();
  const locale = useLocale();
  const projectId = useFlowProjectStore((s) => s.projectId);
  const project = useProjects().data?.find((p) => p.id === projectId);
  const { data, isLoading, error } = useApiKeys(projectId);
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
      {error && <p className="text-destructive text-sm">{t("page.api-keys.load-error", { message: error.message })}</p>}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("page.api-keys.col.service")}</TableHead>
            <TableHead>{t("page.api-keys.col.scopes")}</TableHead>
            <TableHead>{t("page.api-keys.col.key")}</TableHead>
            <TableHead>{t("page.api-keys.col.last-used")}</TableHead>
            <TableHead>{t("common.status")}</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {isLoading && (
            <TableRow>
              <TableCell colSpan={6}>{t("common.loading")}</TableCell>
            </TableRow>
          )}
          {!isLoading && (data ?? []).length === 0 && (
            <TableRow>
              <TableCell colSpan={6} className="text-muted-foreground">
                {t("page.api-keys.empty")}
              </TableCell>
            </TableRow>
          )}
          {(data ?? []).map((k) => (
            <TableRow key={k.id} className={k.revokedAt ? "opacity-60" : ""}>
              <TableCell className="font-medium">{k.serviceName}</TableCell>
              <TableCell>
                <div className="flex flex-wrap gap-1">
                  {k.scopes.map((s) => (
                    <Badge key={s} variant="secondary" className="font-mono text-[10px]">
                      {s}
                    </Badge>
                  ))}
                </div>
              </TableCell>
              <TableCell className="font-mono text-xs">…{prefixTail(k.keyPrefix)}</TableCell>
              <TableCell className="text-xs">{k.lastUsedAt ? formatDateTime(k.lastUsedAt, locale) : t("page.api-keys.never-used")}</TableCell>
              <TableCell>
                <Badge variant={k.revokedAt ? "destructive" : "outline"}>{t(keyStatus(k))}</Badge>
              </TableCell>
              <TableCell className="text-right">
                {!k.revokedAt && (
                  <Button size="sm" variant="ghost" onClick={() => setTarget(k)} title={t("page.api-keys.revoke-title")}>
                    <Ban />
                    {t("page.api-keys.revoke")}
                  </Button>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      <Dialog open={open} onOpenChange={close}>
        <AdminDialogContent size="md">
          <DialogHeader>
            <DialogTitle>{t("page.api-keys.create")}</DialogTitle>
            <DialogDescription>{t("page.api-keys.dialog.description")}</DialogDescription>
          </DialogHeader>
          <DialogBody>
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
                      <input type="checkbox" checked={scopes.includes(scope)} onChange={() => toggle(scope)} />
                      <span className="font-mono text-xs">{scope}</span>
                      <span className="text-muted-foreground text-xs">— {t(hintKey)}</span>
                    </label>
                  ))}
                  <FieldDescription>{t("page.api-keys.field.scopes-hint")}</FieldDescription>
                </Field>
              </FieldGroup>
            </form>
          )}
          </DialogBody>
          <DialogFooter>
            {connectionString ? (
              <Button type="button" onClick={() => close(false)}>
                {t("page.api-keys.copied-close")}
              </Button>
            ) : (
              <Button
                type="submit"
                form="key-form"
                disabled={create.isPending || !serviceName.trim() || scopes.length === 0}
              >
                {create.isPending ? t("common.creating") : t("page.api-keys.create-submit")}
              </Button>
            )}
          </DialogFooter>
        </AdminDialogContent>
      </Dialog>

      <AlertDialog open={Boolean(target)} onOpenChange={(o) => !o && !revoke.isPending && setTarget(null)}>
        <AlertDialogContent>
          <AlertDialogBody>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("page.api-keys.revoke-confirm", { service: target?.serviceName ?? "" })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("page.api-keys.revoke-warning", { tail: target ? prefixTail(target.keyPrefix) : "" })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          </AlertDialogBody>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={revoke.isPending}>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              disabled={revoke.isPending}
              onClick={(e) => {
                e.preventDefault();
                if (!target) return;
                revoke.mutate(target.id, {
                  onSuccess: () => {
                    toast.success(t("page.api-keys.revoked"));
                    setTarget(null);
                  },
                  onError: (err) => toast.error(t("page.api-keys.revoke-failed", { message: err.message })),
                });
              }}
            >
              {t("page.api-keys.revoke")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
