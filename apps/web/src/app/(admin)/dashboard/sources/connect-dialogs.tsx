"use client";

import { useEffect, useState } from "react";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

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
import { credentialError, credentialInputAttrs } from "@/lib/credential-input";
import { HubApiError, hubFetch } from "@/lib/hub/client";
import { useSources } from "@/lib/hub/queries";
import { connectionDialogMode } from "@/lib/hub/ui-logic";

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

function StatusLine({ c }: { c: ConnectionView }) {
  if (c.status === "CONNECTED") return <p className="text-sm">✅ Đã kết nối · {c.display}</p>;
  return (
    <div className="flex flex-col gap-1 text-sm">
      <p>
        {c.status === "PENDING" ? "⏳" : "❌"} {c.status}
        {c.lastError ? ` · ${c.lastError}` : ""}
      </p>
      {c.fix && <p className="text-muted-foreground text-xs">Sửa: {c.fix}</p>}
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
    onError: (e) => toast.error(`Kết nối thất bại: ${e.message}`),
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
    spec.fields.every((f) => creds[f.name]?.trim() && !credentialError(f.label, creds[f.name])) &&
    (!spec.overwriteWarning || ack);

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Kết nối provider</DialogTitle>
          <DialogDescription>
            Hub tạo nguồn, lưu secret, rồi tự đăng ký URL nhận webhook tại provider — không cần mở dashboard của họ.
          </DialogDescription>
        </DialogHeader>
        {result ? (
          <div className="flex flex-col gap-2">
            <StatusLine c={result} />
            {secretChanged && (
              <p className="rounded-md border border-amber-500/50 bg-amber-500/5 p-2 text-xs">
                ⚠️ Secret ký (vd checksumKey) khác key hiện tại — hub sẽ giữ <b>cả hai</b> cho tới khi webhook thật xác
                minh bằng key mới. Nếu webhook thật chỉ khớp key cũ, mục kết nối của nguồn sẽ báo{" "}
                <code>secret_mismatch</code>: nhập lại đúng key rồi bấm &quot;Thử lại&quot;.
              </p>
            )}
          </div>
        ) : !connectors.data?.length ? (
          <p className="text-muted-foreground text-sm">
            {connectors.isLoading
              ? "Đang tải…"
              : 'Chưa provider nào hỗ trợ tự kết nối — dùng "Thêm nguồn" rồi dán URL.'}
          </p>
        ) : (
          // autoComplete off + tên ô riêng: trình duyệt không tự điền đăng nhập operator vào ô credential (lỗi production).
          <form autoComplete="off" onSubmit={(e) => e.preventDefault()}>
            <FieldGroup className="gap-4">
              <Field className="gap-1.5">
                <FieldLabel>Provider</FieldLabel>
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
                <FieldLabel>Nguồn</FieldLabel>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant={effMode === "existing" ? "default" : "outline"}
                    disabled={!candidates.length}
                    onClick={() => setMode("existing")}
                  >
                    Kết nối nguồn có sẵn
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant={effMode === "new" ? "default" : "outline"}
                    onClick={() => setMode("new")}
                  >
                    Tạo nguồn mới
                  </Button>
                </div>
                {!sourcesReady ? (
                  <FieldDescription className="text-amber-600">
                    {sources.isError
                      ? "Không tải được danh sách nguồn — tải lại trang. Chưa thể kết nối (tránh tạo nhầm nguồn mới)."
                      : "Đang tải danh sách nguồn…"}
                  </FieldDescription>
                ) : effMode === "existing" && target ? (
                  <>
                    <select
                      aria-label="Nguồn có sẵn"
                      className="border-input bg-background h-9 rounded-md border px-2 text-sm"
                      value={target.id}
                      onChange={(e) => setExistingId(e.target.value)}
                    >
                      {candidates.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name} · {s.sourceKey}
                        </option>
                      ))}
                    </select>
                    <FieldDescription>
                      Secret ký nhập vào khác key nguồn đang dùng thì hub giữ cả hai cho tới khi webhook thật xác minh
                      bằng key mới (không tự xoá key cũ).
                    </FieldDescription>
                    <FieldDescription>
                      Hub đăng ký đúng URL của nguồn này (/hooks/{target.provider}/{target.sourceKey}) — service đang
                      tin nguồn này (vd Shop ghim SHOP_PAYMENT_SOURCE_KEYS) vẫn nhận sự kiện.
                    </FieldDescription>
                  </>
                ) : (
                  <>
                    <Input
                      id="cn-name"
                      aria-label="Tên nguồn"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="Tên nguồn, VD: PayOS kênh cafe"
                    />
                    <Input
                      id="cn-key"
                      aria-label="sourceKey (tuỳ chọn)"
                      value={sourceKey}
                      onChange={(e) => setSourceKey(e.target.value)}
                      placeholder="sourceKey (tuỳ chọn, a-z 0-9 _) — bỏ trống để hub tự sinh"
                    />
                    {candidates.length > 0 && (
                      <FieldDescription className="text-amber-600">
                        Nguồn mới có URL mới: provider sẽ gửi vào nguồn mới, service đang ghim nguồn cũ sẽ KHÔNG nhận
                        nữa.
                      </FieldDescription>
                    )}
                  </>
                )}
              </Field>
              {spec?.fields.map((f) => (
                <Field key={f.name} className="gap-1.5">
                  <FieldLabel htmlFor={credentialInputAttrs(spec.provider, f.name, f.secret).id}>{f.label}</FieldLabel>
                  <Input
                    {...credentialInputAttrs(spec.provider, f.name, f.secret)}
                    value={creds[f.name] ?? ""}
                    aria-invalid={!!credentialError(f.label, creds[f.name] ?? "")}
                    onChange={(e) => setCreds({ ...creds, [f.name]: e.target.value })}
                  />
                  {credentialError(f.label, creds[f.name] ?? "") && (
                    <p className="text-destructive text-xs">{credentialError(f.label, creds[f.name] ?? "")}</p>
                  )}
                  {f.help && <FieldDescription>{f.help}</FieldDescription>}
                </Field>
              ))}
              {spec && <p className="text-muted-foreground text-xs">{spec.keyHint}</p>}
              {spec?.overwriteWarning && (
                <label className="flex items-start gap-2 rounded-md border border-amber-500/50 bg-amber-500/5 p-2 text-xs">
                  <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
                  <span>
                    <b>Tôi hiểu URL cũ sẽ bị thay.</b> {spec.overwriteWarning}
                  </span>
                </label>
              )}
            </FieldGroup>
          </form>
        )}
        <DialogFooter>
          {result ? (
            <Button onClick={() => close(false)}>Đóng</Button>
          ) : (
            <Button disabled={!ready || connect.isPending} onClick={() => connect.mutate()}>
              {connect.isPending ? "Đang kết nối…" : "Kết nối"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Tình trạng kết nối của một nguồn: Thử lại (không nhập lại), Ngắt, Xoá credentials. */
export function ConnectionDialog({
  source,
  onClose,
  onConnect,
}: {
  source: { id: string; provider: string } | null;
  onClose: () => void;
  onConnect: (s: { id: string; provider: string }) => void;
}) {
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
    onError: (e) => toast.error(e.message),
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
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Kết nối provider</DialogTitle>
          <DialogDescription className="font-mono text-xs">{c?.ingestUrl ?? ""}</DialogDescription>
        </DialogHeader>
        {mode === "loading" || mode === "connect" ? (
          <p className="text-sm">Đang tải…</p>
        ) : !c ? (
          <p className="text-muted-foreground text-sm">
            Nguồn này tạo bằng tay (dán URL ở dashboard provider) — không có kết nối do hub quản.
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            <StatusLine c={c} />
            <p className="text-muted-foreground text-xs">
              Credentials:{" "}
              {c.hasCredentials
                ? Object.entries(c.credentialHints)
                    .map(([k, v]) => `${k} ${v}`)
                    .join(" · ") || "đã lưu (mã hoá)"
                : "đã xoá — kết nối lại phải nhập lại"}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={act.isPending || !c.hasCredentials}
                onClick={() => act.mutate("retry")}
              >
                Thử lại / Kết nối lại
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={act.isPending}
                onClick={() =>
                  window.confirm("Ngắt kết nối? Hub sẽ gỡ cấu hình ở provider nếu provider cho phép.") &&
                  act.mutate("disconnect")
                }
              >
                Ngắt
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={act.isPending || !c.hasCredentials}
                onClick={() =>
                  window.confirm("Xoá credentials đã lưu? Nguồn và kết nối giữ nguyên.") && act.mutate("credentials")
                }
              >
                Xoá credentials
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
