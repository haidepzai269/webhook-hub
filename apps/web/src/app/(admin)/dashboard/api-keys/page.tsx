"use client";

import { useState } from "react";

import { Ban, Plus } from "lucide-react";
import { toast } from "sonner";

import { CopyButton } from "@/components/admin/copy-button";
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
import { Badge } from "@/components/ui/badge";
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

/** Hộp "Chỉ hiện một lần" — key thô chỉ sống trong state của hộp này; đóng là mất (SK1, SPEC §3). */
function ConnectionStringOnce({ connectionString }: { connectionString: string }) {
  const line = envLine(connectionString);
  return (
    <div className="rounded-md border border-amber-500/50 bg-amber-500/5 p-3 text-sm">
      <p className="mb-2 font-medium">Chỉ hiện một lần — copy ngay. Hub không lưu key thô, không hiện lại được.</p>
      <div className="flex items-center gap-2">
        <code className="flex-1 overflow-x-auto rounded bg-muted px-2 py-1 font-mono text-xs">{line}</code>
        <CopyButton value={line} label="Sao chép HUB_URL" />
      </div>
      <p className="mt-2 text-muted-foreground text-xs">
        Dán vào env của service, hoặc vào <b>Shop → Cài đặt kết nối</b> (ô HUB_URL, chỉ phần sau dấu =).
      </p>
    </div>
  );
}

/** SK1 (SPEC-shop-ket-noi-project §3): API key của project ĐANG CHỌN — tạo (copy connection string một lần), thu hồi. */
export default function ApiKeysPage() {
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
        onError: (err) => toast.error(`Tạo key thất bại: ${err.message}`),
      },
    );
  };

  return (
    <>
      <PageHeader
        title="API key"
        description={
          project ? (
            <>
              Key của project <b>{project.name}</b> (<span className="font-mono">{project.slug}</span>). Mỗi service một
              key, scope tối thiểu.
            </>
          ) : (
            "Đang tải project của bạn… (tài khoản mới có sẵn một project từ lúc đăng ký)."
          )
        }
        actions={
          <Button onClick={() => setOpen(true)} disabled={!projectId}>
            <Plus />
            Tạo API key
          </Button>
        }
      />
      {error && <p className="text-destructive text-sm">Không tải được API key: {error.message}</p>}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Service</TableHead>
            <TableHead>Scope</TableHead>
            <TableHead>Key</TableHead>
            <TableHead>Dùng lần cuối</TableHead>
            <TableHead>Trạng thái</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {isLoading && (
            <TableRow>
              <TableCell colSpan={6}>Đang tải…</TableCell>
            </TableRow>
          )}
          {!isLoading && (data ?? []).length === 0 && (
            <TableRow>
              <TableCell colSpan={6} className="text-muted-foreground">
                Chưa có key nào.
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
              <TableCell className="text-xs">{k.lastUsedAt ? formatDateTime(k.lastUsedAt) : "chưa dùng"}</TableCell>
              <TableCell>
                <Badge variant={k.revokedAt ? "destructive" : "outline"}>{keyStatus(k)}</Badge>
              </TableCell>
              <TableCell className="text-right">
                {!k.revokedAt && (
                  <Button size="sm" variant="ghost" onClick={() => setTarget(k)} title="Thu hồi key">
                    <Ban />
                    Thu hồi
                  </Button>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      <Dialog open={open} onOpenChange={close}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Tạo API key</DialogTitle>
            <DialogDescription>Key thô và connection string chỉ hiện MỘT lần ngay sau khi tạo.</DialogDescription>
          </DialogHeader>
          {connectionString ? (
            <ConnectionStringOnce connectionString={connectionString} />
          ) : (
            <form id="key-form" noValidate onSubmit={submit}>
              <FieldGroup className="gap-4">
                <Field className="gap-1.5">
                  <FieldLabel htmlFor="key-service">Tên service</FieldLabel>
                  <Input id="key-service" value={serviceName} onChange={(e) => setServiceName(e.target.value)} />
                </Field>
                <Field className="gap-1.5">
                  <FieldLabel>Scope</FieldLabel>
                  {KEY_SCOPES.map(({ scope, hint }) => (
                    <label key={scope} className="flex items-center gap-2 text-sm">
                      <input type="checkbox" checked={scopes.includes(scope)} onChange={() => toggle(scope)} />
                      <span className="font-mono text-xs">{scope}</span>
                      <span className="text-muted-foreground text-xs">— {hint}</span>
                    </label>
                  ))}
                  <FieldDescription>Mặc định cho Shop: manage:endpoints + read:events.</FieldDescription>
                </Field>
              </FieldGroup>
            </form>
          )}
          <DialogFooter>
            {connectionString ? (
              <Button type="button" onClick={() => close(false)}>
                Tôi đã copy, đóng
              </Button>
            ) : (
              <Button
                type="submit"
                form="key-form"
                disabled={create.isPending || !serviceName.trim() || scopes.length === 0}
              >
                {create.isPending ? "Đang tạo…" : "Tạo key"}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={Boolean(target)} onOpenChange={(o) => !o && !revoke.isPending && setTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Thu hồi key của “{target?.serviceName}”?</AlertDialogTitle>
            <AlertDialogDescription>
              Service đang dùng key …{target ? prefixTail(target.keyPrefix) : ""} sẽ nhận 401 ngay lập tức. Không hoàn
              tác được — tạo key mới nếu cần.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={revoke.isPending}>Huỷ</AlertDialogCancel>
            <AlertDialogAction
              disabled={revoke.isPending}
              onClick={(e) => {
                e.preventDefault();
                if (!target) return;
                revoke.mutate(target.id, {
                  onSuccess: () => {
                    toast.success("Đã thu hồi key");
                    setTarget(null);
                  },
                  onError: (err) => toast.error(`Thu hồi thất bại: ${err.message}`),
                });
              }}
            >
              Thu hồi
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
