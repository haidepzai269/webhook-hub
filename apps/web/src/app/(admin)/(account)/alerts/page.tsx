"use client";

import { Suspense, useMemo, useState } from "react";

import { X } from "lucide-react";

import { useAuthBooting } from "@/components/admin/auth-guard";
import { CursorPager } from "@/components/admin/cursor-pager";
import { DataTable, type HubColumn } from "@/components/admin/data-table";
import { PageHeader } from "@/components/admin/page-header";
import { PageSkeleton } from "@/components/admin/skeletons";
import { ProjectChip, SeverityDot, useAlertText } from "@/components/alerts/alert-ui";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import type { AlertText } from "@/lib/alerts/message";
import { ruleName } from "@/lib/alerts/message";
import { ALERT_RULE_CODES, ALERT_SEVERITIES, type AlertView } from "@/lib/alerts/types";
import { useAlertsPage, useSubjectNames } from "@/lib/hub/alert-queries";
import { formatRelative, formatStamp } from "@/lib/hub/format";
import { ALERT_PARAMS, toApiQuery } from "@/lib/hub/list-url";
import { useCanSeeAlerts, useIsOperator } from "@/lib/hub/me-store";
import { useProjects } from "@/lib/hub/queries";
import { useUrlParams } from "@/lib/hub/use-url-params";
import type { Locale, TranslateFn } from "@/lib/i18n/dictionary";
import { useLocale, useT } from "@/lib/i18n/use-t";

import { AlertSheet } from "./_components/alert-sheet";

const ALL = "__all";

type Row = AlertView & { text: AlertText };

const buildColumns = (t: TranslateFn, locale: Locale): HubColumn<Row>[] => [
  {
    id: "severity",
    header: t("page.alerts.col.severity"),
    accessorFn: (a) => a.severity,
    cell: ({ row }) => (
      <span className="flex items-center gap-2 whitespace-nowrap text-xs">
        <SeverityDot severity={row.original.severity} />
        {t(`alerts.severity.${row.original.severity}`)}
      </span>
    ),
    enableHiding: false,
  },
  {
    id: "alert",
    header: t("page.alerts.col.alert"),
    accessorFn: (a) => `${a.text.title} ${a.text.subjectLabel}`,
    cell: ({ row }) => (
      <div className="min-w-0 max-w-[32rem]">
        <div className="truncate font-medium text-sm" title={row.original.text.title}>
          {row.original.text.title}
        </div>
        <div className="truncate text-muted-foreground text-xs">{row.original.text.subjectLabel}</div>
      </div>
    ),
    enableHiding: false,
  },
  {
    id: "project",
    header: t("page.alerts.col.project"),
    accessorFn: (a) => a.project.name,
    cell: ({ row }) => <ProjectChip name={row.original.project.name} />,
  },
  {
    id: "openedAt",
    header: t("page.alerts.col.opened"),
    accessorFn: (a) => a.openedAt,
    cell: ({ row }) => (
      <span className="whitespace-nowrap text-xs" title={formatStamp(row.original.openedAt, { seconds: true })}>
        {formatStamp(row.original.openedAt, { seconds: true })}
        <span className="block text-[11px] text-muted-foreground">{formatRelative(row.original.openedAt, undefined, locale)}</span>
      </span>
    ),
  },
  {
    id: "state",
    header: t("page.alerts.col.state"),
    accessorFn: (a) => a.state,
    cell: ({ row }) => {
      const a = row.original;
      return (
        <div className="flex flex-col items-start gap-0.5">
          <Badge variant={a.state === "OPEN" ? "outline" : "secondary"} className="text-[11px]">
            {t(a.state === "OPEN" ? "alerts.state.open" : "alerts.state.resolved")}
          </Badge>
          {a.acknowledgedAt && <span className="text-[11px] text-muted-foreground">{t("alerts.bell.acked")}</span>}
        </div>
      );
    },
  },
];

/**
 * CB4 §8.4: mọi cảnh báo XUYÊN project (chỉ operator). Cursor keyset (ADR-163) — Trước/Sau, không số trang; lọc dự án,
 * mức, trạng thái, luật trên URL. Bấm một dòng -> chi tiết (dòng thời gian, số liệu, deep link).
 */
function AlertsView() {
  const t = useT();
  const locale = useLocale();
  const operator = useCanSeeAlerts(); // QT6: owner thấy cảnh báo dung lượng của project mình
  const booting = useAuthBooting();
  const isOperator = useIsOperator();
  const url = useUrlParams(ALERT_PARAMS);
  const v = url.values;
  const projects = useProjects();
  const { data, isLoading, isPlaceholderData, error } = useAlertsPage(toApiQuery(v));
  const text = useAlertText();
  const nameOf = useSubjectNames(data?.items);
  const rows = useMemo<Row[] | undefined>(() => data?.items.map((a) => ({ ...a, text: text(a, nameOf(a.subjectId)) })), [data, text, nameOf]);
  const columns = useMemo(() => buildColumns(t, locale), [t, locale]);
  const [selected, setSelected] = useState<string | null>(null);
  const selectedRow = rows?.find((r) => r.id === selected) ?? null;
  const filtered = Boolean(v.project || v.severity || v.state || v.rule);

  // ADR-238: chưa có /auth/me (AuthGuard đang chờ) -> khung trang, chưa kết luận "chỉ người vận hành".
  if (!operator && booting) return <PageSkeleton />;
  if (!operator) {
    return (
      <>
        <PageHeader title={t("page.alerts.title")} />
        <p className="text-muted-foreground text-sm">{t("page.alerts.operator-only")}</p>
      </>
    );
  }

  return (
    <>
      <PageHeader title={t("page.alerts.title")} description={t("page.alerts.description")} />
      {!isOperator && <p className="mb-3 text-muted-foreground text-sm">{t("alerts.owner-scope")}</p>}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Select value={v.project ?? ALL} onValueChange={(p) => url.setFilter({ project: p === ALL ? null : p })}>
          <SelectTrigger size="sm" className="w-48" aria-label={t("page.alerts.filter.project")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="[&_[role=option]]:cursor-pointer">
            <SelectItem value={ALL}>{t("page.alerts.filter.all-projects")}</SelectItem>
            {(projects.data ?? []).map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {p.name}
              </SelectItem>
            ))}
            {v.project && !(projects.data ?? []).some((p) => p.id === v.project) && (
              <SelectItem value={v.project} className="font-mono text-xs">
                {v.project.slice(0, 8)}
              </SelectItem>
            )}
          </SelectContent>
        </Select>
        <Select value={v.severity ?? ALL} onValueChange={(s) => url.setFilter({ severity: s === ALL ? null : s })}>
          <SelectTrigger size="sm" className="w-40" aria-label={t("page.alerts.filter.severity")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="[&_[role=option]]:cursor-pointer">
            <SelectItem value={ALL}>{t("page.alerts.filter.all-severities")}</SelectItem>
            {ALERT_SEVERITIES.map((s) => (
              <SelectItem key={s} value={s}>
                {t(`alerts.severity.${s}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={v.state ?? ALL} onValueChange={(s) => url.setFilter({ state: s === ALL ? null : s })}>
          <SelectTrigger size="sm" className="w-40" aria-label={t("page.alerts.filter.state")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="[&_[role=option]]:cursor-pointer">
            <SelectItem value={ALL}>{t("page.alerts.filter.all-states")}</SelectItem>
            <SelectItem value="OPEN">{t("alerts.state.open")}</SelectItem>
            <SelectItem value="RESOLVED">{t("alerts.state.resolved")}</SelectItem>
          </SelectContent>
        </Select>
        <Select value={v.rule ?? ALL} onValueChange={(r) => url.setFilter({ rule: r === ALL ? null : r })}>
          <SelectTrigger size="sm" className="w-60" aria-label={t("page.alerts.filter.rule")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="[&_[role=option]]:cursor-pointer">
            <SelectItem value={ALL}>{t("page.alerts.filter.all-rules")}</SelectItem>
            {ALERT_RULE_CODES.map((r) => (
              <SelectItem key={r} value={r}>
                {ruleName(r, t)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {filtered && (
          <Button variant="ghost" size="sm" onClick={url.clear}>
            <X />
            {t("common.filters.clear")}
          </Button>
        )}
      </div>
      <DataTable
        data={rows}
        columns={columns}
        getRowId={(a) => a.id}
        isLoading={isLoading}
        isStale={isPlaceholderData}
        error={error}
        pageSize={false}
        onRowClick={(a) => setSelected(a.id)}
        searchPlaceholder={t("page.alerts.search-placeholder")}
        emptyText={t(filtered ? "page.alerts.empty-filtered" : "page.alerts.empty")}
        toolbar={
          <CursorPager
            next={data?.next}
            prev={data?.prev}
            loading={isPlaceholderData}
            onNext={(c) => url.setCursor({ before: c })}
            onPrev={(c) => url.setCursor({ after: c })}
            onNewest={() => url.setCursor({})}
          />
        }
      />
      <AlertSheet alert={selectedRow} subjectName={selectedRow ? nameOf(selectedRow.subjectId) : null} onClose={() => setSelected(null)} />
    </>
  );
}

export default function AlertsPage() {
  return (
    <Suspense fallback={<Skeleton className="h-96 w-full" />}>
      <AlertsView />
    </Suspense>
  );
}
