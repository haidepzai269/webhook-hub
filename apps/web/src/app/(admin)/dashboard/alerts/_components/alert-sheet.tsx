"use client";

import { ArrowRight } from "lucide-react";

import { ProjectChip, SeverityIcon, useAlertText, useOpenAlertTarget } from "@/components/alerts/alert-ui";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { factRows } from "@/lib/alerts/facts";
import { alertActions } from "@/lib/alerts/links";
import type { AlertView } from "@/lib/alerts/types";
import { useAckAlert } from "@/lib/hub/alert-queries";
import { formatDateTime, formatRelative, shortId } from "@/lib/hub/format";
import { useMeId } from "@/lib/hub/me-store";
import { useLocale, useT } from "@/lib/i18n/use-t";

/**
 * CB4 §8.4: chi tiết một cảnh báo — câu (chuyện gì / cách xử lý), dòng thời gian (mở → lần thấy cuối → đã xem bởi ai →
 * đóng), số liệu dạng BẢNG đã dịch (không bao giờ đổ JSON thô), deep link vào đúng project + bộ lọc.
 */
export function AlertSheet({ alert, subjectName, onClose }: { alert: AlertView | null; subjectName: string | null; onClose: () => void }) {
  return (
    <Sheet open={Boolean(alert)} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full gap-0 overflow-y-auto sm:max-w-lg">{alert && <Body alert={alert} subjectName={subjectName} onClose={onClose} />}</SheetContent>
    </Sheet>
  );
}

function Body({ alert: a, subjectName, onClose }: { alert: AlertView; subjectName: string | null; onClose: () => void }) {
  const t = useT();
  const locale = useLocale();
  const text = useAlertText();
  const open = useOpenAlertTarget();
  const ack = useAckAlert();
  const me = useMeId();
  const msg = text(a, subjectName);
  const rows = factRows(a.facts, t, { locale, now: Date.now() });
  const actions = alertActions(a);
  const resolved = a.state === "RESOLVED";
  let who: string | null = null;
  if (a.acknowledgedBy) who = a.acknowledgedBy === me ? t("page.alerts.sheet.you") : shortId(a.acknowledgedBy, 8);

  const timeline: { label: string; at: string | null; done: boolean }[] = [
    { label: t("page.alerts.sheet.opened"), at: a.openedAt, done: true },
    { label: t("page.alerts.sheet.last-seen"), at: a.lastSeenAt, done: true },
    who
      ? { label: t("page.alerts.sheet.acked", { who }), at: a.acknowledgedAt, done: true }
      : { label: t("page.alerts.sheet.not-acked"), at: null, done: false },
    resolved
      ? { label: t("page.alerts.sheet.resolved"), at: a.resolvedAt, done: true }
      : { label: t("page.alerts.sheet.still-open"), at: null, done: false },
  ];

  return (
    <>
      <SheetHeader className="gap-2 border-b pb-4">
        <div className="flex items-center gap-2">
          <SeverityIcon severity={a.severity} resolved={resolved} />
          <Badge variant="outline" className="text-[11px]">
            {t(`alerts.severity.${a.severity}`)}
          </Badge>
          <Badge variant={resolved ? "secondary" : "outline"} className="text-[11px]">
            {t(resolved ? "alerts.state.resolved" : "alerts.state.open")}
          </Badge>
          <ProjectChip name={a.project.name} />
        </div>
        <SheetTitle className="text-base leading-snug">{msg.headline}</SheetTitle>
        <SheetDescription>{t("page.alerts.sheet.description", { project: a.project.name, opened: formatRelative(a.openedAt, undefined, locale) })}</SheetDescription>
      </SheetHeader>

      <div className="space-y-5 p-4">
        {msg.message && (
          <section>
            <h3 className="mb-1 font-medium text-muted-foreground text-xs uppercase tracking-wide">{t("page.alerts.sheet.what")}</h3>
            <p className="text-sm">{msg.message}</p>
          </section>
        )}
        {msg.fix && (
          <section>
            <h3 className="mb-1 font-medium text-muted-foreground text-xs uppercase tracking-wide">{t("page.alerts.sheet.fix")}</h3>
            <p className="text-sm">{msg.fix}</p>
          </section>
        )}

        {actions.length > 0 && (
          <section>
            <h3 className="mb-2 font-medium text-muted-foreground text-xs uppercase tracking-wide">{t("page.alerts.sheet.links")}</h3>
            <div className="flex flex-wrap gap-2">
              {actions.map((x, i) => (
                <Button
                  key={x.labelKey}
                  size="sm"
                  variant={i === 0 ? "default" : "outline"}
                  onClick={() => {
                    onClose();
                    open(a.project.id, x.href);
                  }}
                >
                  {t(x.labelKey)}
                  <ArrowRight />
                </Button>
              ))}
              {!a.acknowledgedAt && !resolved && (
                <Button size="sm" variant="ghost" disabled={ack.isPending} onClick={() => ack.mutate(a.id)}>
                  {t("page.alerts.sheet.ack")}
                </Button>
              )}
            </div>
          </section>
        )}

        <Separator />

        <section>
          <h3 className="mb-2 font-medium text-muted-foreground text-xs uppercase tracking-wide">{t("page.alerts.sheet.timeline")}</h3>
          <ol className="relative ms-1.5 border-s ps-4">
            {timeline.map((s) => (
              <li key={s.label} className="relative pb-3 last:pb-0">
                <span
                  aria-hidden
                  className="absolute -start-[21.5px] top-1.5 size-2.5 rounded-full border-2 border-background"
                  style={{ backgroundColor: s.done ? "var(--foreground)" : "var(--border)" }}
                />
                <div className={s.done ? "text-sm" : "text-muted-foreground text-sm"}>{s.label}</div>
                {s.at && (
                  <div className="text-muted-foreground text-xs" title={s.at}>
                    {formatDateTime(s.at, locale)} · {formatRelative(s.at, undefined, locale)}
                  </div>
                )}
              </li>
            ))}
          </ol>
        </section>

        <section>
          <h3 className="mb-2 font-medium text-muted-foreground text-xs uppercase tracking-wide">{t("page.alerts.sheet.facts")}</h3>
          {rows.length === 0 ? (
            <p className="text-muted-foreground text-sm">{t("page.alerts.sheet.no-facts")}</p>
          ) : (
            <dl className="divide-y rounded-md border text-sm">
              {rows.map((r) => (
                <div key={r.key} className="grid grid-cols-[minmax(8rem,40%)_1fr] gap-3 px-3 py-1.5">
                  <dt className={r.nested ? "ps-3 text-muted-foreground" : "text-muted-foreground"}>{r.label}</dt>
                  <dd className="min-w-0 break-words tabular-nums">{r.value}</dd>
                </div>
              ))}
            </dl>
          )}
        </section>
      </div>
    </>
  );
}
