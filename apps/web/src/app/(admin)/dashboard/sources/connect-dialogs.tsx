"use client";

import { useState } from "react";

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
import { HubApiError, hubFetch } from "@/lib/hub/client";

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

export function ConnectSourceDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const connectors = useQuery({
    queryKey: ["connectors"],
    queryFn: () => hubFetch<ConnectorInfo[]>("/api/v1/connectors"),
    enabled: open,
  });
  const refresh = useRefresh();
  const [provider, setProvider] = useState<string>("");
  const [name, setName] = useState("");
  const [creds, setCreds] = useState<Record<string, string>>({});
  const [ack, setAck] = useState(false);
  const [result, setResult] = useState<ConnectionView | null>(null);
  const spec = (connectors.data ?? []).find((c) => c.provider === provider) ?? connectors.data?.[0];
  const connect = useMutation({
    mutationFn: () =>
      hubFetch<{ connection: ConnectionView }>("/api/v1/sources/connect", {
        method: "POST",
        body: JSON.stringify({
          provider: spec?.provider,
          name: name.trim(),
          credentials: creds,
          ...(spec?.overwriteWarning ? { acknowledgeOverwrite: ack } : {}),
        }),
      }),
    onSuccess: (r) => setResult(r.connection),
    onError: (e) => toast.error(`Kết nối thất bại: ${e.message}`),
    onSettled: refresh,
  });
  const close = (o: boolean) => {
    if (connect.isPending) return;
    if (!o) {
      setResult(null);
      setCreds({});
      setAck(false);
      setName("");
    }
    onOpenChange(o);
  };
  const ready =
    spec && name.trim() && spec.fields.every((f) => creds[f.name]?.trim()) && (!spec.overwriteWarning || ack);

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
          <StatusLine c={result} />
        ) : !connectors.data?.length ? (
          <p className="text-muted-foreground text-sm">
            {connectors.isLoading
              ? "Đang tải…"
              : 'Chưa provider nào hỗ trợ tự kết nối — dùng "Thêm nguồn" rồi dán URL.'}
          </p>
        ) : (
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
                    onClick={() => (setProvider(c.provider), setCreds({}), setAck(false))}
                  >
                    {c.provider}
                  </Button>
                ))}
              </div>
            </Field>
            <Field className="gap-1.5">
              <FieldLabel htmlFor="cn-name">Tên nguồn</FieldLabel>
              <Input
                id="cn-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="VD: PayOS kênh cafe"
              />
            </Field>
            {spec?.fields.map((f) => (
              <Field key={f.name} className="gap-1.5">
                <FieldLabel htmlFor={`cn-${f.name}`}>{f.label}</FieldLabel>
                <Input
                  id={`cn-${f.name}`}
                  type={f.secret ? "password" : "text"}
                  autoComplete="off"
                  value={creds[f.name] ?? ""}
                  onChange={(e) => setCreds({ ...creds, [f.name]: e.target.value })}
                />
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
export function ConnectionDialog({ sourceId, onClose }: { sourceId: string | null; onClose: () => void }) {
  const refresh = useRefresh();
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
  return (
    <Dialog open={Boolean(sourceId)} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Kết nối provider</DialogTitle>
          <DialogDescription className="font-mono text-xs">{c?.ingestUrl ?? ""}</DialogDescription>
        </DialogHeader>
        {q.isLoading ? (
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
