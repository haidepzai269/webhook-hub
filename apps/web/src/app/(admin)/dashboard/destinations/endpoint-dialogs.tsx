"use client";

import { useState } from "react";

import { Check, Copy, RefreshCw, RotateCcw } from "lucide-react";
import { toast } from "sonner";

import { AdminDialogContent } from "@/components/admin/overlay-content";
import { deliveryStatusKey } from "@/components/admin/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { AcceptUnverifiedField } from "@/components/admin/accept-unverified-field";
import { Checkbox } from "@/components/ui/checkbox";
import {
  type CreateEndpointResult,
  useCreateEndpoint,
  useEndpointDetail,
  useEventTypeCatalog,
  useRotateEndpointSecret,
  useVerifyEndpoint,
} from "@/lib/hub/endpoint-queries";
import { formatDateTime } from "@/lib/hub/format";
import { DELIVERY_STATUS_VALUES } from "@/lib/hub/list-url";
import { useSources } from "@/lib/hub/queries";
import { describeVerification } from "@/lib/hub/ui-logic";
import { useLocale, useT } from "@/lib/i18n/use-t";

/** Trạng thái lượt giao của hub -> nhãn dịch; mã lạ (API mới hơn console) giữ nguyên. */
function DeliveryStatusLabel({ status }: { status: string }) {
  const t = useT();
  const known = (DELIVERY_STATUS_VALUES as readonly string[]).includes(status);
  return (
    <Badge variant="outline" title={status}>
      {known ? t(deliveryStatusKey(status as (typeof DELIVERY_STATUS_VALUES)[number])) : status}
    </Badge>
  );
}

function CopyButton({ text }: { text: string }) {
  const t = useT();
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
      {done ? t("common.copied") : t("common.copy")}
    </Button>
  );
}

/** Hộp "Secret chỉ hiện một lần" (SPEC-ket-noi §3.2) — đóng hộp là mất, hub không bao giờ hiện lại. */
export function SecretOnce({ secret }: { secret: string }) {
  const t = useT();
  const envLine = `HUB_SIGNING_SECRET=${secret}`;
  return (
    <div className="rounded-md border border-amber-500/50 bg-amber-500/5 p-3 text-sm">
      <p className="mb-2 font-medium">{t("page.destinations.endpoint.secret-once")}</p>
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
  const t = useT();
  const v = describeVerification(verification, error, t);
  return (
    <div className="flex flex-col gap-1 text-sm">
      <span>
        {t("page.destinations.endpoint.challenge")}{" "}
        {verification === "VERIFIED" ? t("page.destinations.endpoint.challenge-ok") : `❌ ${v.reason ?? verification}`}
      </span>
      {verification !== "VERIFIED" && fix && (
        <span className="text-muted-foreground text-xs">{t("page.destinations.endpoint.fix", { fix })}</span>
      )}
    </div>
  );
}

/** KN1: form URL + tick event type (catalog) + chọn source. Hub sinh whsec_, chạy challenge, tạo subscription cùng tx. */
export function CreateEndpointDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const t = useT();
  const catalog = useEventTypeCatalog();
  const sources = useSources();
  const create = useCreateEndpoint();
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [types, setTypes] = useState<string[]>(["payment.*"]);
  const [extra, setExtra] = useState("");
  const [sourceIds, setSourceIds] = useState<string[]>([]);
  // PK5 khoá 4 (ADR-206): đích tự đồng ý nhận sự kiện chưa xác thực — mặc định KHÔNG.
  const [acceptUnverified, setAcceptUnverified] = useState(false);
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
      setAcceptUnverified(false);
    }
    onOpenChange(o);
  };
  const submit = () => {
    const eventTypes = [
      ...types,
      ...extra
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean),
    ];
    create.mutate(
      { name: name.trim(), url: url.trim(), eventTypes, ...(sourceIds.length ? { sourceIds } : {}), ...(acceptUnverified ? { acceptUnverified: true } : {}) },
      {
        onSuccess: setResult,
        onError: (e) => toast.error(t("page.destinations.endpoint.create-failed", { message: e.message })),
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      {/* UI-MS: form nhiều ô -> cỡ lg, gộp cặp ô ngắn thành 2 cột để phần thường gặp không phải cuộn */}
      <AdminDialogContent size="lg">
        <DialogHeader>
          <DialogTitle>{t("page.destinations.endpoint.create-title")}</DialogTitle>
          <DialogDescription>{t("page.destinations.endpoint.create-description")}</DialogDescription>
        </DialogHeader>
        <DialogBody>
        {result ? (
          <div className="flex flex-col gap-3">
            {result.signingSecret && <SecretOnce secret={result.signingSecret} />}
            <VerificationLine
              verification={result.verification}
              error={result.verificationError}
              fix={result.verificationFix}
            />
            <p className="text-muted-foreground text-xs">
              {t("page.destinations.endpoint.receives", { types: result.subscription.eventTypes.join(", ") })}
              {result.subscription.sourceIds.length
                ? t("page.destinations.endpoint.sources-count", { count: result.subscription.sourceIds.length })
                : t("page.destinations.endpoint.all-sources")}
            </p>
          </div>
        ) : (
          <FieldGroup className="gap-4">
            <div className="grid gap-4 sm:grid-cols-2">
            <Field className="gap-1.5">
              <FieldLabel htmlFor="ep-name">{t("common.name")}</FieldLabel>
              <Input
                id="ep-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t("page.destinations.endpoint.name-placeholder")}
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
              <FieldDescription>{t("page.destinations.endpoint.url-hint")}</FieldDescription>
            </Field>
            </div>
            <Field className="gap-1.5">
              <FieldLabel>{t("page.destinations.endpoint.types")}</FieldLabel>
              <div className="flex flex-wrap gap-2">
                {[...(catalog.data?.wildcards ?? []), ...(catalog.data?.types ?? [])].map((type) => (
                  <label key={type} className="flex items-center gap-1 font-mono text-xs">
                    <Checkbox checked={types.includes(type)} onCheckedChange={() => setTypes(toggle(types, type))} />
                    {type}
                  </label>
                ))}
              </div>
              <Input
                value={extra}
                onChange={(e) => setExtra(e.target.value)}
                placeholder={t("page.destinations.endpoint.extra-placeholder")}
              />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
            <Field className="gap-1.5">
              <FieldLabel>{t("page.destinations.endpoint.sources")}</FieldLabel>
              <div className="flex flex-col gap-1">
                {(sources.data ?? []).map((s) => (
                  <label key={s.id} className="flex items-center gap-2 text-xs">
                    <Checkbox checked={sourceIds.includes(s.id)} onCheckedChange={() => setSourceIds(toggle(sourceIds, s.id))} />
                    {s.name} <Badge variant="secondary">{s.provider}</Badge>
                  </label>
                ))}
              </div>
            </Field>
            <AcceptUnverifiedField
              checked={acceptUnverified}
              onChange={setAcceptUnverified}
              label={t("page.destinations.endpoint.accept-unverified")}
              hint={t("page.destinations.endpoint.accept-unverified-hint")}
            />
            </div>
          </FieldGroup>
        )}
        </DialogBody>
        <DialogFooter>
          {result ? (
            <Button onClick={() => close(false)}>{t("page.destinations.endpoint.saved-close")}</Button>
          ) : (
            <>
              <Button variant="outline" disabled={create.isPending} onClick={() => close(false)}>
                {t("common.cancel")}
              </Button>
              <Button disabled={create.isPending || !name.trim() || !url.trim()} onClick={submit}>
                {create.isPending ? t("page.destinations.endpoint.creating") : t("common.create")}
              </Button>
            </>
          )}
        </DialogFooter>
      </AdminDialogContent>
    </Dialog>
  );
}

/** Chi tiết endpoint: delivery gần đây, Verify lại, Xoay secret (chỉ endpoint do console quản). */
export function EndpointDetailDialog({ id, onClose }: { id: string | null; onClose: () => void }) {
  const t = useT();
  const locale = useLocale();
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
      <AdminDialogContent size="lg">
        <DialogHeader>
          <DialogTitle>{ep?.name ?? t("page.destinations.endpoint.fallback-title")}</DialogTitle>
          <DialogDescription className="font-mono text-xs">{ep?.url ?? ""}</DialogDescription>
        </DialogHeader>
        <DialogBody>
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
                        ? toast.success(t("page.destinations.endpoint.verify-ok"))
                        : toast.error(`❌ ${r.verificationFix ?? r.verificationError}`),
                    onError: (e) => toast.error(e.message),
                  })
                }
              >
                <RefreshCw /> {t("page.destinations.endpoint.verify-again")}
              </Button>
              {ep.managedBy !== "service" && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={rotate.isPending}
                  onClick={() => {
                    if (!window.confirm(t("page.destinations.endpoint.rotate-confirm"))) return;
                    rotate.mutate(ep.id, {
                      onSuccess: (r) => setSecret(r.signingSecret),
                      onError: (e) => toast.error(e.message),
                    });
                  }}
                >
                  <RotateCcw /> {t("page.destinations.endpoint.rotate")}
                </Button>
              )}
            </div>
            <div className="text-sm">
              <p className="mb-1 font-medium">{t("page.destinations.endpoint.recent")}</p>
              {(detail.data?.deliveries ?? []).length === 0 && (
                <p className="text-muted-foreground text-xs">{t("page.destinations.endpoint.recent-empty")}</p>
              )}
              <ul className="flex flex-col gap-1">
                {(detail.data?.deliveries ?? []).map((d) => (
                  <li key={d.id} className="flex gap-2 font-mono text-xs">
                    <span>{formatDateTime(d.createdAt, locale)}</span>
                    <DeliveryStatusLabel status={d.status} />
                    <span>{d.eventType}</span>
                    {d.lastError && <span className="text-rose-700 dark:text-rose-300">{d.lastError}</span>}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}
        </DialogBody>
      </AdminDialogContent>
    </Dialog>
  );
}
