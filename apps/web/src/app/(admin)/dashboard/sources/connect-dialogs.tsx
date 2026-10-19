"use client";

import { Fragment, type ReactNode, useEffect, useState } from "react";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { AdminDialogContent } from "@/components/admin/overlay-content";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useConfirm } from "@/components/admin/confirm-dialog";
import { StatusBadge, toneTextClass } from "@/components/admin/status-badge";
import { credentialError, credentialInputAttrs } from "@/lib/credential-input";
import { HubApiError, hubFetch } from "@/lib/hub/client";
import { useSources } from "@/lib/hub/queries";
import { connectionDialogMode, errorTextOf } from "@/lib/hub/ui-logic";
import type { MessageKey } from "@/lib/i18n/dictionary";
import { useT } from "@/lib/i18n/use-t";
import { Alert, AlertDescription, } from "@/components/ui/alert";

/** KN2 (SPEC-ket-noi §4, ADR-138): form dựng từ `spec.fields` của connector — UI không biết provider nào có ô gì. */
interface ConnectorInfo {
  provider: string;
  fields: { name: string; label: string; secret: boolean; help: string }[];
  overwriteWarning: string | null;
  keyHint: string;
  manualDisconnect: string | null;
}

export interface ConnectionView {
  sourceId: string;
  provider: string;
  status: "PENDING" | "CONNECTED" | "FAILED" | "DRIFTED" | "DISCONNECTED";
  display: string | null;
  ingestUrl: string;
  lastError: string | null;
  fix: string | null;
  hasCredentials: boolean;
  credentialHints: Record<string, string>;
  manualDisconnect: string | null;
}

function useRefresh() {
  const qc = useQueryClient();
  return () => {
    for (const key of [["sources"], ["connection"], ["audit"]]) void qc.invalidateQueries({ queryKey: key });
  };
}

const CONNECTION_STATUS: Record<ConnectionView["status"], MessageKey> = {
  PENDING: "page.sources.connect.status.pending",
  CONNECTED: "page.sources.connect.status.connected",
  FAILED: "page.sources.connect.status.failed",
  DRIFTED: "page.sources.connect.status.drifted",
  DISCONNECTED: "page.sources.connect.status.disconnected",
};

/** Câu dịch có chỗ chèn phần tử (`{both}`, `{code}`): tách theo `{tên}` và thay bằng node tương ứng. */
function rich(template: string, nodes: Record<string, ReactNode>): ReactNode {
  return template.split(/\{(\w+)\}/).map((part, i) =>
    // biome-ignore lint/suspicious/noArrayIndexKey: các mảnh của một câu cố định, thứ tự không đổi
    i % 2 === 1 && part in nodes ? <Fragment key={i}>{nodes[part]}</Fragment> : part,
  );
}

function StatusLine({ c }: { c: ConnectionView }) {
  const t = useT();
  if (c.status === "CONNECTED")
    return <p className="text-sm">{t("page.sources.connect.connected", { display: c.display ?? "" })}</p>;
  return (
    <div className="flex flex-col gap-1 text-sm">
      <p>
        <StatusBadge tone={c.status === "PENDING" ? "progress" : "bad"} pulse={c.status === "PENDING"} tooltip={c.status}>
          {t(CONNECTION_STATUS[c.status])}
        </StatusBadge>
        {c.lastError ? ` · ${c.lastError}` : ""}
      </p>
      {c.fix && <p className="text-muted-foreground text-xs">{t("page.sources.connect.fix", { fix: c.fix })}</p>}
      {c.status === "DISCONNECTED" && c.manualDisconnect && (
        <p className="text-muted-foreground text-xs">{c.manualDisconnect}</p>
      )}
    </div>
  );
}

/** `preset`: mở từ nút 🔗 của một nguồn chưa kết nối -> chọn sẵn provider + "Kết nối nguồn có sẵn" = nguồn đó. */
export function ConnectSourceDialog({
  open,
  onOpenChange,
  preset,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  preset?: { provider: string; sourceId: string } | null;
}) {
  const t = useT();
  const connectors = useQuery({
    queryKey: ["connectors"],
    queryFn: () => hubFetch<ConnectorInfo[]>("/api/v1/connectors"),
    enabled: open,
  });
  const refresh = useRefresh();
  const [provider, setProvider] = useState<string>(preset?.provider ?? "");
  const [name, setName] = useState("");
  const [creds, setCreds] = useState<Record<string, string>>({});
  const [ack, setAck] = useState(false);
  const [result, setResult] = useState<ConnectionView | null>(null);
  const [secretChanged, setSecretChanged] = useState(false);
  // H-1 (ADR-151): "nguồn có sẵn" (giữ sourceKey — service đang ghim nguồn đó vẫn nhận) hay "tạo nguồn mới".
  const [mode, setMode] = useState<"existing" | "new" | null>(preset ? "existing" : null);
  const [existingId, setExistingId] = useState<string>(preset?.sourceId ?? "");
  const [sourceKey, setSourceKey] = useState("");
  const sources = useSources();
  const spec = (connectors.data ?? []).find((c) => c.provider === provider) ?? connectors.data?.[0];
  const candidates = (sources.data ?? []).filter((s) => s.provider === spec?.provider && s.isActive);
  // L-R2-2: danh sách nguồn chưa tải xong / lỗi -> KHÔNG ngầm chọn "tạo mới" (lặp lại H-1); khoá nút Kết nối.
  const sourcesReady = sources.isSuccess;
  // Mặc định: provider đã có nguồn -> kết nối nguồn có sẵn (tạo nguồn mới sẽ làm service đang ghim nguồn cũ mất kênh).
  const effMode = mode ?? (candidates.length ? "existing" : "new");
  const target = candidates.find((s) => s.id === existingId) ?? candidates[0];
  const connect = useMutation({
    mutationFn: () => {
      const common = {
        credentials: creds,
        ...(spec?.overwriteWarning ? { acknowledgeOverwrite: ack } : {}),
      };
      return effMode === "existing" && target
        ? hubFetch<{ connection: ConnectionView; secretChanged?: boolean }>(
            `/api/v1/sources/${encodeURIComponent(target.id)}/connect`,
            {
              method: "POST",
              body: JSON.stringify(common),
            },
          )
        : hubFetch<{ connection: ConnectionView; secretChanged?: boolean }>("/api/v1/sources/connect", {
            method: "POST",
            body: JSON.stringify({
              provider: spec?.provider,
              name: name.trim(),
              ...(sourceKey.trim() ? { sourceKey: sourceKey.trim() } : {}),
              ...common,
            }),
          });
    },
    onSuccess: (r) => (setResult(r.connection), setSecretChanged(!!r.secretChanged)),
    onError: (e) => toast.error(t("page.sources.connect.failed", { message: e.message })),
    onSettled: refresh,
  });
  const close = (o: boolean) => {
    if (connect.isPending) return;
    if (!o) {
      setResult(null);
      setSecretChanged(false);
      setCreds({});
      setAck(false);
      setName("");
      setMode(null);
      setExistingId("");
      setSourceKey("");
    }
    onOpenChange(o);
  };
  const ready =
    spec &&
    sourcesReady &&
    (effMode === "existing" ? !!target : !!name.trim()) &&
    spec.fields.every((f) => creds[f.name]?.trim() && !credentialError(f.label, creds[f.name], t)) &&
    (!spec.overwriteWarning || ack);

  return (
    <Dialog open={open} onOpenChange={close}>
      <AdminDialogContent size="md">
        <DialogHeader>
          <DialogTitle>{t("page.sources.connect.title")}</DialogTitle>
          <DialogDescription>{t("page.sources.connect.description")}</DialogDescription>
        </DialogHeader>
        <DialogBody>
        {result ? (
          <div className="flex flex-col gap-2">
            <StatusLine c={result} />
            {secretChanged && (
              <Alert variant="warning">
                <AlertDescription className="text-xs">
                  {rich(t("page.sources.connect.secret-changed"), {
                    both: <b>{t("page.sources.connect.secret-changed.both")}</b>,
                    code: <code>secret_mismatch</code>,
                  })}
                </AlertDescription>
              </Alert>
            )}
          </div>
        ) : !connectors.data?.length ? (
          <p className="text-muted-foreground text-sm">
            {connectors.isLoading ? t("common.loading") : t("page.sources.connect.no-connectors")}
          </p>
        ) : (
          // autoComplete off + tên ô riêng: trình duyệt không tự điền đăng nhập operator vào ô credential (lỗi production).
          <form autoComplete="off" onSubmit={(e) => e.preventDefault()}>
            <FieldGroup className="gap-4">
              <Field className="gap-1.5">
                <FieldLabel>{t("page.sources.connect.provider")}</FieldLabel>
                <div className="flex gap-2">
                  {connectors.data.map((c) => (
                    <Button
                      key={c.provider}
                      type="button"
                      size="sm"
                      variant={spec?.provider === c.provider ? "default" : "outline"}
                      onClick={() => (
                        setProvider(c.provider), setCreds({}), setAck(false), setMode(null), setExistingId("")
                      )}
                    >
                      {c.provider}
                    </Button>
                  ))}
                </div>
              </Field>
              <Field className="gap-1.5">
                <FieldLabel>{t("page.sources.connect.source")}</FieldLabel>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant={effMode === "existing" ? "default" : "outline"}
                    disabled={!candidates.length}
                    onClick={() => setMode("existing")}
                  >
                    {t("page.sources.connect.use-existing")}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant={effMode === "new" ? "default" : "outline"}
                    onClick={() => setMode("new")}
                  >
                    {t("page.sources.connect.create-new")}
                  </Button>
                </div>
                {!sourcesReady ? (
                  <FieldDescription className={toneTextClass("warn")}>
                    {sources.isError
                      ? t("page.sources.connect.sources-error")
                      : t("page.sources.connect.sources-loading")}
                  </FieldDescription>
                ) : effMode === "existing" && target ? (
                  <>
                    <Select value={target.id} onValueChange={setExistingId}>
                      <SelectTrigger size="sm" className="w-full" aria-label={t("page.sources.connect.existing-aria")}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {candidates.map((s) => (
                          <SelectItem key={s.id} value={s.id}>
                            {s.name} · {s.sourceKey}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FieldDescription>{t("page.sources.connect.existing-keeps-both")}</FieldDescription>
                    <FieldDescription>
                      {t("page.sources.connect.existing-same-url", {
                        path: `/hooks/${target.provider}/${target.sourceKey}`,
                      })}
                    </FieldDescription>
                  </>
                ) : (
                  <div className="grid gap-2 sm:grid-cols-2">
                    <Input
                      id="cn-name"
                      aria-label={t("page.sources.connect.name-aria")}
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder={t("page.sources.connect.name-placeholder")}
                    />
                    <Input
                      id="cn-key"
                      aria-label={t("page.sources.connect.key-aria")}
                      value={sourceKey}
                      onChange={(e) => setSourceKey(e.target.value)}
                      placeholder={t("page.sources.connect.key-placeholder")}
                    />
                    {candidates.length > 0 && (
                      <FieldDescription className={`${toneTextClass("warn")} sm:col-span-2`}>
                        {t("page.sources.connect.new-url-warning")}
                      </FieldDescription>
                    )}
                  </div>
                )}
              </Field>
              {spec?.fields.map((f) => (
                <Field key={f.name} className="gap-1.5">
                  <FieldLabel htmlFor={credentialInputAttrs(spec.provider, f.name, f.secret).id}>{f.label}</FieldLabel>
                  <Input
                    {...credentialInputAttrs(spec.provider, f.name, f.secret)}
                    value={creds[f.name] ?? ""}
                    aria-invalid={!!credentialError(f.label, creds[f.name] ?? "", t)}
                    onChange={(e) => setCreds({ ...creds, [f.name]: e.target.value })}
                  />
                  {credentialError(f.label, creds[f.name] ?? "", t) && (
                    <FieldError>{credentialError(f.label, creds[f.name] ?? "", t)}</FieldError>
                  )}
                  {f.help && <FieldDescription>{f.help}</FieldDescription>}
                </Field>
              ))}
              {spec && <p className="text-muted-foreground text-xs">{spec.keyHint}</p>}
              {spec?.overwriteWarning && (
                <Alert variant="warning">
                  <AlertDescription className="text-xs">
                    <label className="flex cursor-pointer items-start gap-2">
                      <Checkbox checked={ack} onCheckedChange={(v) => setAck(v === true)} className="mt-0.5" />
                      <span>
                        <b>{t("page.sources.connect.ack-overwrite")}</b> {spec.overwriteWarning}
                      </span>
                    </label>
                  </AlertDescription>
                </Alert>
              )}
            </FieldGroup>
          </form>
        )}
        </DialogBody>
        <DialogFooter>
          {result ? (
            <Button onClick={() => close(false)}>{t("common.close")}</Button>
          ) : (
            <Button disabled={!ready || connect.isPending} onClick={() => connect.mutate()}>
              {connect.isPending ? t("page.sources.connect.submitting") : t("page.sources.connect.submit")}
            </Button>
          )}
        </DialogFooter>
      </AdminDialogContent>
    </Dialog>
  );
}

/** Tình trạng kết nối của một nguồn: Thử lại (không nhập lại), Ngắt, Xoá credentials. */
export function ConnectionDialog({
  source,
  onClose,
  onConnect,
  onArchive,
}: {
  source: { id: string; provider: string } | null;
  onClose: () => void;
  onConnect: (s: { id: string; provider: string }) => void;
  /** ADR-260: nguồn tạo tay chỉ có một việc làm được ở đây — lưu trữ (mở hộp xác nhận ở trang). */
  onArchive?: (s: { id: string; provider: string }) => void;
}) {
  const t = useT();
  const { confirm, confirmDialog } = useConfirm();
  const sourceId = source?.id ?? null;
  const refresh = useRefresh();
  const connectors = useQuery({
    queryKey: ["connectors"],
    queryFn: () => hubFetch<ConnectorInfo[]>("/api/v1/connectors"),
    enabled: Boolean(sourceId),
  });
  const q = useQuery({
    queryKey: ["connection", sourceId],
    queryFn: () =>
      hubFetch<ConnectionView>(`/api/v1/sources/${encodeURIComponent(sourceId ?? "")}/connection`).catch(
        (e: unknown) => {
          if (e instanceof HubApiError && e.status === 404) return null;
          throw e;
        },
      ),
    enabled: Boolean(sourceId),
  });
  const act = useMutation({
    mutationFn: (kind: "retry" | "disconnect" | "credentials") =>
      hubFetch<{ connection: ConnectionView }>(
        `/api/v1/sources/${encodeURIComponent(sourceId ?? "")}/connection${kind === "retry" ? "/retry" : kind === "credentials" ? "/credentials" : ""}`,
        { method: kind === "retry" ? "POST" : "DELETE", ...(kind === "retry" ? { body: "{}" } : {}) },
      ),
    onError: (e) => toast.error(errorTextOf(e, t)),
    onSettled: refresh,
  });
  const c = q.data;
  const mode = connectionDialogMode(
    q.isSuccess ? c : undefined,
    source?.provider ?? "",
    connectors.isSuccess ? connectors.data.map((x) => x.provider) : connectors.isError ? [] : undefined,
  );
  // Chưa từng kết nối mà provider có connector -> chuyển sang hộp kết nối điền sẵn nguồn này.
  useEffect(() => {
    if (mode === "connect" && source) {
      onClose();
      onConnect(source);
    }
  }, [mode, source, onClose, onConnect]);
  return (
    <Dialog open={Boolean(sourceId)} onOpenChange={(o) => !o && onClose()}>
      <AdminDialogContent size="md">
        <DialogHeader>
          <DialogTitle>{t("page.sources.connect.title")}</DialogTitle>
          <DialogDescription className="font-mono text-xs">{c?.ingestUrl ?? ""}</DialogDescription>
        </DialogHeader>
        <DialogBody>
        {mode === "loading" || mode === "connect" ? (
          <p className="text-sm">{t("common.loading")}</p>
        ) : !c ? (
          <div className="flex flex-col gap-3">
            <p className="text-muted-foreground text-sm">{t("page.sources.connection.manual")}</p>
            <p className="text-sm">{t("page.sources.connection.manual-howto")}</p>
            {onArchive && source && (
              <div>
                <Button
                  size="sm"
                  variant="destructive"
                  onClick={() => {
                    onClose();
                    onArchive(source);
                  }}
                >
                  {t("page.sources.archive.button")}
                </Button>
              </div>
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <StatusLine c={c} />
            <p className="text-muted-foreground text-xs">
              {t("page.sources.connection.credentials", {
                value: c.hasCredentials
                  ? Object.entries(c.credentialHints)
                      .map(([k, v]) => `${k} ${v}`)
                      .join(" · ") || t("page.sources.connection.credentials-saved")
                  : t("page.sources.connection.credentials-deleted"),
              })}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={act.isPending || !c.hasCredentials}
                onClick={() => act.mutate("retry")}
              >
                {t("page.sources.connection.retry")}
              </Button>
              <Button
                size="sm"
                variant="destructive"
                disabled={act.isPending}
                onClick={async () => {
                  if (await confirm({ title: t("page.sources.connection.disconnect-confirm"), destructive: true })) act.mutate("disconnect");
                }}
              >
                {t("page.sources.connection.disconnect")}
              </Button>
              <Button
                size="sm"
                variant="destructive"
                disabled={act.isPending || !c.hasCredentials}
                onClick={async () => {
                  if (await confirm({ title: t("page.sources.connection.delete-credentials-confirm"), destructive: true })) act.mutate("credentials");
                }}
              >
                {t("page.sources.connection.delete-credentials")}
              </Button>
            </div>
          </div>
        )}
        </DialogBody>
      </AdminDialogContent>
      {confirmDialog}
    </Dialog>
  );
}
