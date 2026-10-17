"use client";

import { AdminSheetContent } from "@/components/admin/overlay-content";
import { ErrorState } from "@/components/admin/state";
import { Badge } from "@/components/ui/badge";
import { Sheet, SheetBody, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatDateTime } from "@/lib/hub/format";
import {
  connectionState,
  diagnosisParts,
  type InspectDiagnosis,
  isSnsSubscribeUrl,
  listenReasonKey,
  pendingSubscribeUrl,
  subscribeTopicArn,
} from "@/lib/hub/listen-logic";
import { useSourceInspect } from "@/lib/hub/queries";
import type { Source } from "@/lib/hub/types";
import type { TranslateFn } from "@/lib/i18n/dictionary";
import { useLocale, useT } from "@/lib/i18n/use-t";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";


/** Câu chẩn đoán — chỉ TÊN header/trường (API không bao giờ trả giá trị). */
function reasonText(t: TranslateFn, d: InspectDiagnosis): string {
  const p = diagnosisParts(d);
  const base = t(listenReasonKey(p.reason), { name: p.name ?? "" });
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
      <AdminSheetContent size="lg">
        {source && (
          <>
            <SheetHeader>
              <SheetTitle>{t("page.sources.listen.title", { name: source.name })}</SheetTitle>
              <SheetDescription>{t("page.sources.listen.description")}</SheetDescription>
            </SheetHeader>
            <SheetBody>
              <ListenBlock sourceId={source.id} />
            </SheetBody>
          </>
        )}
      </AdminSheetContent>
    </Sheet>
  );
}

function ListenBlock({ sourceId }: { sourceId: string }) {
  const t = useT();
  const locale = useLocale();
  const { data, isLoading, error, refetch } = useSourceInspect(sourceId);
  if (isLoading) return <Skeleton className="m-4 h-24" />;
  const errorLine = error && <ErrorState message={t("page.sources.listen.error", { message: error.message })} onRetry={() => void refetch()} />;
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
            {/* PK5 khoá 2 (REVIEW-PK5 TB-1): nguồn chưa xác thực — đã nhận, nhưng không xanh / không "✓ hợp lệ". */}
            {state.unverified ? (
              <span className="font-medium text-amber-700 dark:text-amber-400">{t("page.sources.listen.connected-unverified")}</span>
            ) : (
              <span className="font-medium text-emerald-600">{t("page.sources.listen.connected")}</span>
            )}
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
  // Review PK4 T-1: link ConfirmSubscription THẬT của topic người khác vẫn qua kiểm tên miền — hiện TopicArn để dev đối chiếu.
  const topicArn = subscribeTopicArn(url);
  return (
    <Alert variant="warning">
      <AlertTitle>{t("page.sources.listen.subscribe-url.title")}</AlertTitle>
      <AlertDescription>
        {trusted ? (
          <a href={url} target="_blank" rel="noopener noreferrer nofollow" className="break-all text-primary underline">
            {url}
          </a>
        ) : (
          <code className="break-all">{url}</code>
        )}
        <p>
          {t("page.sources.listen.subscribe-url.topic")} <code className="break-all">{topicArn ?? t("page.sources.listen.subscribe-url.topic-unknown")}</code>
        </p>
        <p className={trusted ? undefined : "font-medium text-destructive"}>
          {t(trusted ? "page.sources.listen.subscribe-url.warning" : "page.sources.listen.subscribe-url.untrusted")}
        </p>
      </AlertDescription>
    </Alert>
  );
}
