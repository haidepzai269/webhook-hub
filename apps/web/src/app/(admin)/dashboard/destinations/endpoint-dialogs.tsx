"use client";

import { useState } from "react";

import { Check, Copy, RefreshCw, RotateCcw } from "lucide-react";
import { toast } from "sonner";

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
import {
  type CreateEndpointResult,
  useCreateEndpoint,
  useEndpointDetail,
  useEventTypeCatalog,
  useRotateEndpointSecret,
  useVerifyEndpoint,
} from "@/lib/hub/endpoint-queries";
import { formatDateTime } from "@/lib/hub/format";
import { useSources } from "@/lib/hub/queries";
import { describeVerification } from "@/lib/hub/ui-logic";

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        });
      }}
    >
      {done ? <Check /> : <Copy />}
      {done ? "Đã copy" : "Copy"}
    </Button>
  );
}

/** Hộp "Secret chỉ hiện một lần" (SPEC-ket-noi §3.2) — đóng hộp là mất, hub không bao giờ hiện lại. */
export function SecretOnce({ secret }: { secret: string }) {
  const envLine = `HUB_SIGNING_SECRET=${secret}`;
  return (
    <div className="rounded-md border border-amber-500/50 bg-amber-500/5 p-3 text-sm">
      <p className="mb-2 font-medium">Secret chỉ hiện một lần — copy ngay vào .env của service.</p>
      <div className="flex items-center gap-2">
        <code className="bg-muted flex-1 overflow-x-auto rounded px-2 py-1 font-mono text-xs">{envLine}</code>
        <CopyButton text={envLine} />
      </div>
    </div>
  );
}

function VerificationLine({
  verification,
  error,
  fix,
}: {
  verification: string;
  error: string | null;
  fix: string | null;
}) {
  const v = describeVerification(verification, error);
  return (
    <div className="flex flex-col gap-1 text-sm">
      <span>
        Challenge:{" "}
        {verification === "VERIFIED" ? "✅ endpoint đã chứng minh giữ secret" : `❌ ${v.reason ?? verification}`}
      </span>
      {verification !== "VERIFIED" && fix && <span className="text-muted-foreground text-xs">Sửa: {fix}</span>}
    </div>
  );
}

/** KN1: form URL + tick event type (catalog) + chọn source. Hub sinh whsec_, chạy challenge, tạo subscription cùng tx. */
export function CreateEndpointDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const catalog = useEventTypeCatalog();
  const sources = useSources();
  const create = useCreateEndpoint();
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [types, setTypes] = useState<string[]>(["payment.*"]);
  const [extra, setExtra] = useState("");
  const [sourceIds, setSourceIds] = useState<string[]>([]);
  const [result, setResult] = useState<CreateEndpointResult | null>(null);

  const toggle = (list: string[], v: string) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const close = (o: boolean) => {
    if (create.isPending) return;
    if (!o) {
      setResult(null);
      setName("");
      setUrl("");
      setTypes(["payment.*"]);
      setExtra("");
      setSourceIds([]);
    }
    onOpenChange(o);
  };
  const submit = () => {
    const eventTypes = [
      ...types,
      ...extra
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean),
    ];
    create.mutate(
      { name: name.trim(), url: url.trim(), eventTypes, ...(sourceIds.length ? { sourceIds } : {}) },
      { onSuccess: setResult, onError: (e) => toast.error(`Tạo endpoint thất bại: ${e.message}`) },
    );
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Tạo endpoint webhook</DialogTitle>
          <DialogDescription>
            Hub sinh signing secret (whsec_), gửi challenge tới URL và tạo subscription — một bước.
          </DialogDescription>
        </DialogHeader>
        {result ? (
          <div className="flex flex-col gap-3">
            {result.signingSecret && <SecretOnce secret={result.signingSecret} />}
            <VerificationLine
              verification={result.verification}
              error={result.verificationError}
              fix={result.verificationFix}
            />
            <p className="text-muted-foreground text-xs">
              Nhận: {result.subscription.eventTypes.join(", ")}
              {result.subscription.sourceIds.length
                ? ` · ${result.subscription.sourceIds.length} source`
                : " · mọi source của project"}
            </p>
          </div>
        ) : (
          <FieldGroup className="gap-4">
            <Field className="gap-1.5">
              <FieldLabel htmlFor="ep-name">Tên</FieldLabel>
              <Input
                id="ep-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="VD: shop-backend"
              />
            </Field>
            <Field className="gap-1.5">
              <FieldLabel htmlFor="ep-url">URL</FieldLabel>
              <Input
                id="ep-url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://shop.example.com/webhooks/hub"
              />
              <FieldDescription>URL công khai. Local thì dùng `npx hub listen` thay vì localhost.</FieldDescription>
            </Field>
            <Field className="gap-1.5">
              <FieldLabel>Event type (catalog)</FieldLabel>
              <div className="flex flex-wrap gap-2">
                {[...(catalog.data?.wildcards ?? []), ...(catalog.data?.types ?? [])].map((t) => (
                  <label key={t} className="flex items-center gap-1 font-mono text-xs">
                    <input type="checkbox" checked={types.includes(t)} onChange={() => setTypes(toggle(types, t))} />
                    {t}
                  </label>
                ))}
              </div>
              <Input
                value={extra}
                onChange={(e) => setExtra(e.target.value)}
                placeholder="Kiểu riêng, cách nhau dấu phẩy (vd order.*)"
              />
            </Field>
            <Field className="gap-1.5">
              <FieldLabel>Source (bỏ trống = mọi source của project)</FieldLabel>
              <div className="flex flex-col gap-1">
                {(sources.data ?? []).map((s) => (
                  <label key={s.id} className="flex items-center gap-2 text-xs">
                    <input
                      type="checkbox"
                      checked={sourceIds.includes(s.id)}
                      onChange={() => setSourceIds(toggle(sourceIds, s.id))}
                    />
                    {s.name} <Badge variant="secondary">{s.provider}</Badge>
                  </label>
                ))}
              </div>
            </Field>
          </FieldGroup>
        )}
        <DialogFooter>
          {result ? (
            <Button onClick={() => close(false)}>Đã lưu secret, đóng</Button>
          ) : (
            <>
              <Button variant="outline" disabled={create.isPending} onClick={() => close(false)}>
                Huỷ
              </Button>
              <Button disabled={create.isPending || !name.trim() || !url.trim()} onClick={submit}>
                {create.isPending ? "Đang tạo + challenge…" : "Tạo"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Chi tiết endpoint: delivery gần đây, Verify lại, Xoay secret (chỉ endpoint do console quản). */
export function EndpointDetailDialog({ id, onClose }: { id: string | null; onClose: () => void }) {
  const detail = useEndpointDetail(id);
  const verify = useVerifyEndpoint();
  const rotate = useRotateEndpointSecret();
  const [secret, setSecret] = useState<string | null>(null);
  const ep = detail.data?.endpoint;
  const close = () => {
    setSecret(null);
    onClose();
  };
  return (
    <Dialog open={Boolean(id)} onOpenChange={(o) => !o && close()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{ep?.name ?? "Endpoint"}</DialogTitle>
          <DialogDescription className="font-mono text-xs">{ep?.url ?? ""}</DialogDescription>
        </DialogHeader>
        {ep && (
          <div className="flex flex-col gap-3">
            <VerificationLine verification={ep.verification} error={ep.verificationError} fix={ep.verificationFix} />
            {secret && <SecretOnce secret={secret} />}
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={verify.isPending}
                onClick={() =>
                  verify.mutate(ep.id, {
                    onSuccess: (r) =>
                      r.verification === "VERIFIED"
                        ? toast.success("✅ Challenge qua")
                        : toast.error(`❌ ${r.verificationFix ?? r.verificationError}`),
                    onError: (e) => toast.error(e.message),
                  })
                }
              >
                <RefreshCw /> Verify lại
              </Button>
              {ep.managedBy !== "service" && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={rotate.isPending}
                  onClick={() => {
                    if (
                      !window.confirm(
                        "Xoay secret? Service phải cập nhật HUB_SIGNING_SECRET ngay — delivery tới lúc đó sẽ bị từ chối (retry/DLQ).",
                      )
                    )
                      return;
                    rotate.mutate(ep.id, {
                      onSuccess: (r) => setSecret(r.signingSecret),
                      onError: (e) => toast.error(e.message),
                    });
                  }}
                >
                  <RotateCcw /> Xoay secret
                </Button>
              )}
            </div>
            <div className="text-sm">
              <p className="mb-1 font-medium">Delivery gần đây</p>
              {(detail.data?.deliveries ?? []).length === 0 && (
                <p className="text-muted-foreground text-xs">Chưa có.</p>
              )}
              <ul className="flex flex-col gap-1">
                {(detail.data?.deliveries ?? []).map((d) => (
                  <li key={d.id} className="flex gap-2 font-mono text-xs">
                    <span>{formatDateTime(d.createdAt)}</span>
                    <Badge variant="outline">{d.status}</Badge>
                    <span>{d.eventType}</span>
                    {d.lastError && <span className="text-rose-700 dark:text-rose-300">{d.lastError}</span>}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
