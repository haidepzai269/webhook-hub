"use client";

import { AdminSheetContent } from "@/components/admin/overlay-content";
import { Badge } from "@/components/ui/badge";
import { Sheet, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatDateTime } from "@/lib/hub/format";
import { connectionState, diagnosisParts, type InspectDiagnosis, isSnsSubscribeUrl, pendingSubscribeUrl } from "@/lib/hub/listen-logic";
import { useSourceInspect } from "@/lib/hub/queries";
import type { Source } from "@/lib/hub/types";
import type { MessageKey, TranslateFn } from "@/lib/i18n/dictionary";
import { useLocale, useT } from "@/lib/i18n/use-t";

const REASON_KEY: Record<string, MessageKey> = {
  ok: "page.sources.listen.reason.ok",
  missing_header: "page.sources.listen.reason.missing-header",
  signature_mismatch: "page.sources.listen.reason.signature-mismatch",
  token_mismatch: "page.sources.listen.reason.token-mismatch",
  timestamp_out_of_range: "page.sources.listen.reason.timestamp-out-of-range",
  missing_kv_key: "page.sources.listen.reason.missing-kv-key",
  missing_idempotency_key: "page.sources.listen.reason.missing-idempotency-key",
  mapping_field_missing: "page.sources.listen.reason.mapping-field-missing",
  mapping_field_invalid: "page.sources.listen.reason.mapping-field-invalid",
  config_invalid: "page.sources.listen.reason.config-invalid",
  handshake: "page.sources.listen.reason.handshake",
};

/** Câu chẩn đoán — chỉ TÊN header/trường (API không bao giờ trả giá trị). */
function reasonText(t: TranslateFn, d: InspectDiagnosis): string {
  const p = diagnosisParts(d);
  const base = t(REASON_KEY[p.reason] ?? "page.sources.listen.reason.unknown", { name: p.name ?? "" });
  return p.candidates.length ? `${base} (${t("page.sources.listen.candidates", { names: p.candidates.join(", ") })})` : base;
}

/**
 * PK1 (SPEC-provider-khac §3.2–3.3, ADR-202): "Lắng nghe" của một nguồn generic — mở từ dòng của bảng Nguồn (cùng kiểu
 * khối Lưu lượng; console chưa có trang chi tiết nguồn). Dòng trạng thái kết nối ở đầu, rồi 10 request gần nhất kèm
 * chẩn đoán. Gọi lại mỗi 2s khi đang mở.
 */
export function ListenSheet({ source, onClose }: { source: Source | null; onClose: () => void }) {
  const t = useT();
  return (
    <Sheet open={Boolean(source)} onOpenChange={(o) => !o && onClose()}>
      <AdminSheetContent className="w-full gap-0 overflow-y-auto data-[side=right]:sm:max-w-2xl">
        {source && (
          <>
            <SheetHeader>
              <SheetTitle>{t("page.sources.listen.title", { name: source.name })}</SheetTitle>
              <SheetDescription>{t("page.sources.listen.description")}</SheetDescription>
            </SheetHeader>
            <ListenBlock sourceId={source.id} />
          </>
        )}
      </AdminSheetContent>
    </Sheet>
  );
}

function ListenBlock({ sourceId }: { sourceId: string }) {
  const t = useT();
  const locale = useLocale();
  const { data, isLoading, error } = useSourceInspect(sourceId);
  if (isLoading) return <Skeleton className="m-4 h-24" />;
  const errorLine = error && <p className="text-destructive text-sm">{t("page.sources.listen.error", { message: error.message })}</p>;
  // Review PK1 T-5: chưa có dữ liệu thì chỉ báo lỗi; đã có thì lỗi là băng-rôn phía trên, bảng cũ giữ nguyên.
  if (!data) return <div className="p-4">{errorLine}</div>;
  const state = connectionState(data);
  return (
    <div className="flex flex-col gap-4 p-4">
      {errorLine}
      <div role="status" aria-live="polite" className="rounded-md border p-3 text-sm">
        {state.kind === "waiting" && <span className="text-muted-foreground">{t("page.sources.listen.waiting")}</span>}
        {state.kind === "handshaken" && <span className="font-medium text-emerald-600">{t("page.sources.listen.handshaken")}</span>}
        {state.kind === "connected" && (
          <>
            <span className="font-medium text-emerald-600">{t("page.sources.listen.connected")}</span>
            {state.lastFailure && (
              <p className="mt-1 text-muted-foreground">{t("page.sources.listen.last-failure", { reason: reasonText(t, state.lastFailure) })}</p>
            )}
          </>
        )}
        {state.kind === "failing" && (
          <span className="text-destructive">{t("page.sources.listen.failing", { reason: reasonText(t, state.diagnosis) })}</span>
        )}
      </div>
      <SubscribeUrlNotice url={pendingSubscribeUrl(data)} />
      {data && data.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("page.sources.listen.col.time")}</TableHead>
              <TableHead>{t("page.sources.listen.col.status")}</TableHead>
              <TableHead>{t("page.sources.listen.col.diagnosis")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.map((r) => (
              <TableRow key={r.id}>
                <TableCell className="whitespace-nowrap text-xs">{formatDateTime(r.receivedAt, locale)}</TableCell>
                <TableCell>
                  <Badge variant={r.status === "ACCEPTED" || r.diagnosis?.reason === "handshake" ? "outline" : r.status === "REJECTED" ? "destructive" : "secondary"}>
                    {r.status}
                  </Badge>
                </TableCell>
                <TableCell className="whitespace-normal text-xs">{reasonText(t, r.diagnosis)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

/**
 * PK4 (§6.1, §15, ADR-205): SNS `SubscriptionConfirmation` — hub KHÔNG gọi SubscribeURL (SSRF). Console chỉ hiện link để dev tự
 * bấm, kèm cảnh báo; tên miền không phải `sns.<vùng>.amazonaws.com` thì không làm link (chỉ hiện chữ + cảnh báo đỏ).
 */
function SubscribeUrlNotice({ url }: { url: string | null }) {
  const t = useT();
  if (!url) return null;
  const trusted = isSnsSubscribeUrl(url);
  return (
    <div className="rounded-md border border-amber-500/50 p-3 text-sm">
      <p className="font-medium">{t("page.sources.listen.subscribe-url.title")}</p>
      {trusted ? (
        <a href={url} target="_blank" rel="noopener noreferrer nofollow" className="break-all text-primary underline">
          {url}
        </a>
      ) : (
        <code className="break-all">{url}</code>
      )}
      <p className={trusted ? "mt-1 text-muted-foreground" : "mt-1 text-destructive"}>
        {t(trusted ? "page.sources.listen.subscribe-url.warning" : "page.sources.listen.subscribe-url.untrusted")}
      </p>
    </div>
  );
}
