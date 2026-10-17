"use client";

import { useEffect, useMemo, useState } from "react";

import { HardDrive, Info, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { useAuthBooting } from "@/components/admin/auth-guard";
import { PageHeader } from "@/components/admin/page-header";
import { SimpleTable } from "@/components/admin/simple-table";
import { EmptyState, ErrorState } from "@/components/admin/state";
import { KeepLongerSwitch } from "@/components/storage/keep-longer-switch";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { CardSkeleton } from "@/components/admin/skeletons";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ConfirmDialog } from "@/components/admin/confirm-dialog";
import { HubApiError } from "@/lib/hub/client";
import { useFlowProjectStore } from "@/lib/hub/flow-project";
import { useMeStore } from "@/lib/hub/me-store";
import {
  useApplySuggestion,
  useCleanStorage,
  useSaveStorageEmail,
  useSaveStoragePolicies,
  useSetKeepLonger,
  useStorage,
  useStorageEmail,
  useStoragePolicies,
} from "@/lib/hub/storage-queries";
import { errorMessageOf } from "@/lib/hub/ui-logic";
import { formatStamp } from "@/lib/hub/format";
import type { MessageKey } from "@/lib/i18n/dictionary";
import { useT } from "@/lib/i18n/use-t";
import {
  IMPORTANCES,
  type Importance,
  type StoragePolicyView,
  type StorageSuggestion,
  barPct,
  cleanBodyFor,
  confirmKeys,
  formatBytes,
  levelSeg,
  levelTone,
  parseAge,
  sourceCountVars,
  suggestionActions,
} from "@/lib/storage/storage-logic";

/**
 * QT7 (SPEC-han-muc-dung-luong §5, §9 + E1/E2/E5): trang Dung lượng của dự án đang chọn — thanh mức dùng (ước tính, hiệu
 * chỉnh lúc …), dự báo, theo mức quan trọng + theo nguồn (công tắc "Giữ lâu"), "Hub gợi ý" (Dọn / Xoá hẳn + hộp xác nhận
 * nói đánh đổi), "Dọn tự động" (trạng thái cờ, lần chạy gần nhất), email 70/85. Không có nút "Nâng cấp".
 * Quyền ghi (dọn, policy, Giữ lâu) = owner hoặc người vận hành; server vẫn kiểm scope `storage:write`.
 */
const TONE_COLOR = { ok: "var(--ok, oklch(0.65 0.15 155))", warning: "var(--warning)", danger: "var(--danger)" } as const;

export default function StoragePage() {
  const t = useT();
  const projectId = useFlowProjectStore((s) => s.projectId);
  const me = useMeStore((s) => s.me);
  const canWrite = me?.user.isOperator === true || (me?.memberships ?? []).some((m) => m.projectId === projectId && m.role === "owner");
  const q = useStorage(projectId, { poll: true });
  const booting = useAuthBooting();
  const forbidden = q.error instanceof HubApiError && q.error.status === 403;
  // 403 là "không có quyền" (trung tính, thử lại vô ích) chứ không phải lỗi tải.
  const loadError = forbidden ? (
    <EmptyState size="sm" title={t("page.storage.forbidden")} />
  ) : (
    <ErrorState
      message={t("page.storage.load-error", { message: q.error instanceof HubApiError ? errorMessageOf(q.error.body, t) : String(q.error) })}
      onRetry={() => void q.refetch()}
    />
  );

  return (
    <>
      <PageHeader title={t("page.storage.title")} description={t("page.storage.description")} />
      {/* ADR-238: chưa có project vì AuthGuard đang chọn -> rơi xuống khung chờ, chưa kết luận "không có dự án". */}
      {!projectId && !booting ? (
        <p className="text-muted-foreground text-sm">{t("page.storage.no-project")}</p>
      ) : q.error ? (
        loadError
      ) : !q.data ? (
        <CardSkeleton lines={3} />
      ) : (
        <div className="grid gap-4">
          {!canWrite && <p className="text-muted-foreground text-sm">{t("page.storage.read-only")}</p>}
          <UsageCard />
          <div className="grid gap-4 lg:grid-cols-2">
            <ByImportanceCard />
            <BySourceCard canWrite={canWrite} />
          </div>
          <SuggestionsCard canWrite={canWrite} />
          <AutoCleanCard canWrite={canWrite} />
          <EmailCard />
          <JobsCard />
        </div>
      )}
    </>
  );
}

function useOverview() {
  const projectId = useFlowProjectStore((s) => s.projectId);
  return { projectId, data: useStorage(projectId, { poll: true }).data };
}

/** Mốc ngày giờ gọn (dd/MM HH:mm, 24 giờ ở mọi ngôn ngữ) — dùng chung `formatStamp` của lib/hub/format. */
function useDateTime() {
  return (iso: string | null | undefined) => formatStamp(iso);
}

function UsageCard() {
  const t = useT();
  const fmt = useDateTime();
  const { data } = useOverview();
  if (!data) return null;
  const tone = levelTone(data.level);
  const src = sourceCountVars(data);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          <HardDrive className="size-4" aria-hidden />
          {t("page.storage.usage", { used: formatBytes(data.usedBytes), quota: formatBytes(data.quotaBytes) })}
          <Badge variant="outline">{t("page.storage.estimated")}</Badge>
          <Badge variant="outline" style={{ borderColor: TONE_COLOR[tone], color: TONE_COLOR[tone] }}>
            {t(`page.storage.level.${levelSeg(data.level)}` as MessageKey)}
          </Badge>
          {src && <span className="ml-auto font-normal text-muted-foreground text-sm">{t("page.storage.sources-count", src)}</span>}
        </CardTitle>
        <CardDescription>
          {data.calibratedAt ? t("page.storage.calibrated-at", { at: fmt(data.calibratedAt) }) : t("page.storage.calibrated-never")}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        <div
          className="h-3 w-full overflow-hidden rounded-full bg-muted"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(barPct(data.usedPct))}
          aria-label={t("page.storage.title")}
        >
          <div className="h-full rounded-full transition-[width]" style={{ width: `${barPct(data.usedPct)}%`, backgroundColor: TONE_COLOR[tone] }} />
        </div>
        <div className="flex flex-wrap justify-between gap-2 text-muted-foreground text-sm">
          <span className="tabular-nums">{data.usedPct}%</span>
          <span>
            {data.forecastHours !== null
              ? t("page.storage.forecast", { hours: Math.max(0, Math.round(data.forecastHours)), perDay: formatBytes(data.growthPerDay) })
              : t("page.storage.forecast-none")}
          </span>
        </div>
      </CardContent>
    </Card>
  );
}

function ByImportanceCard() {
  const t = useT();
  const fmt = useDateTime();
  const { data } = useOverview();
  if (!data) return null;
  const total = Math.max(1, IMPORTANCES.reduce((s, i) => s + (data.byImportance?.[i]?.bytes ?? 0), 0));
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("page.storage.by-importance")}</CardTitle>
        <CardDescription>{t("page.storage.computed-at", { at: fmt(data.suggestionsAt) })}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {IMPORTANCES.map((imp) => {
          const v = data.byImportance?.[imp] ?? { events: 0, bytes: 0 };
          return (
            <div key={imp} className="space-y-1">
              <div className="flex items-baseline justify-between gap-2 text-sm">
                <span title={t(`page.storage.importance.${imp}-hint` as MessageKey)}>
                  <span className="font-medium">{t(`page.storage.importance.${imp}` as MessageKey)}</span>{" "}
                  <span className="text-muted-foreground text-xs">{t(`page.storage.importance.${imp}-hint` as MessageKey)}</span>
                </span>
                <span className="shrink-0 text-muted-foreground tabular-nums">
                  {formatBytes(v.bytes)} · {t("page.storage.events", { count: v.events })}
                </span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                <div className="h-full bg-primary/70" style={{ width: `${(v.bytes / total) * 100}%` }} />
              </div>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

function BySourceCard({ canWrite }: { canWrite: boolean }) {
  const t = useT();
  const { data } = useOverview();
  const keep = useSetKeepLonger();
  if (!data) return null;
  const total = Math.max(1, data.bySource.reduce((s, x) => s + x.bytes, 0));
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("page.storage.by-source")}</CardTitle>
        <CardDescription className="flex items-start gap-1.5">
          <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          {t("page.storage.keep-longer.hint")}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {data.bySource.length === 0 && <p className="text-muted-foreground text-sm">—</p>}
        {data.bySource.map((s) => (
          <div key={s.sourceId} className="space-y-1">
            <div className="flex items-center justify-between gap-2 text-sm">
              <span className="truncate font-medium">{s.name ?? t("page.storage.source-unknown")}</span>
              <span className="flex shrink-0 items-center gap-2">
                <span className="text-muted-foreground tabular-nums">{formatBytes(s.bytes)}</span>
                {s.name && (
                  <KeepLongerSwitch
                    checked={s.keepLonger}
                    disabled={!canWrite || keep.isPending}
                    onChange={(v) =>
                      keep.mutate(
                        { id: s.sourceId, keepLonger: v },
                        {
                          onSuccess: () => toast.success(t(v ? "page.storage.keep-longer.on" : "page.storage.keep-longer.off", { name: s.name ?? "" })),
                          onError: (e) => toast.error(e instanceof HubApiError ? errorMessageOf(e.body, t) : String(e)),
                        },
                      )
                    }
                  />
                )}
              </span>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
              <div className="h-full bg-primary/70" style={{ width: `${(s.bytes / total) * 100}%` }} />
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function ageLabel(t: ReturnType<typeof useT>, olderThan: string) {
  const a = parseAge(olderThan);
  if (!a) return olderThan;
  return t(a.unit === "d" ? "alerts.unit.days" : a.unit === "h" ? "alerts.unit.hours" : "alerts.unit.minutes", { n: a.n });
}

function SuggestionsCard({ canWrite }: { canWrite: boolean }) {
  const t = useT();
  const fmt = useDateTime();
  const { projectId, data } = useOverview();
  const clean = useCleanStorage(projectId);
  const apply = useApplySuggestion(projectId);
  const [pending, setPending] = useState<{ s: StorageSuggestion; action: "trim" | "delete" } | null>(null);
  // Mở trang bằng #suggestions (banner LOCKED, email) -> cuộn tới khối này.
  useEffect(() => {
    if (typeof window !== "undefined" && window.location.hash) document.getElementById(window.location.hash.slice(1))?.scrollIntoView({ block: "start" });
  }, []);
  if (!data) return null;
  const impName = (imp: readonly string[]) => imp.map((i) => t(`page.storage.importance.${i}` as MessageKey)).join(", ");
  const run = () => {
    if (!pending) return;
    const { s, action } = pending;
    const actionName = t(`page.storage.action.${action}` as MessageKey);
    const done = { onSuccess: () => toast.success(t("page.storage.clean-started", { action: actionName })) };
    const fail = (e: unknown) => {
      if (e instanceof HubApiError && e.status === 409) toast.info(t("page.storage.clean-stale"));
      else toast.error(e instanceof HubApiError ? errorMessageOf(e.body, t) : String(e));
    };
    // Đúng hành động hub gợi ý -> `apply` (idempotent theo id, tính lại tại lúc gọi); hành động khác -> lệnh dọn tay.
    if (action === s.action) apply.mutate(s.id, { ...done, onError: fail, onSettled: () => setPending(null) });
    else clean.mutate(cleanBodyFor(s, action), { ...done, onError: fail, onSettled: () => setPending(null) });
  };
  const ck = pending ? confirmKeys(pending.action, pending.s.importance) : null;
  return (
    <Card id="suggestions" className="scroll-mt-20">
      <CardHeader>
        <CardTitle>{t("page.storage.suggestions")}</CardTitle>
        <CardDescription>{t("page.storage.computed-at", { at: fmt(data.suggestionsAt) })}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {data.suggestions.length === 0 && <EmptyState size="sm" title={t("page.storage.suggestions-empty")} />}
        {data.suggestions.map((s) => (
          <div key={s.id} className="flex flex-col gap-2 rounded-md border p-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0 space-y-0.5 text-sm">
              <div className="font-medium">
                {t(`page.storage.action.${s.action}` as MessageKey)} · {impName(s.importance)} · {t("page.storage.suggestion.older", { age: ageLabel(t, s.olderThan) })}
              </div>
              <div className="text-muted-foreground text-xs">{t("page.storage.suggestion.frees", { size: formatBytes(s.estimatedBytes), count: s.estimatedEvents })}</div>
              <div className="text-muted-foreground text-xs">{s.reason}</div>
            </div>
            <div className="flex shrink-0 gap-2">
              {suggestionActions(s).map((a) => (
                <Button key={a} size="sm" variant={a === "delete" ? "destructive" : "default"} disabled={!canWrite} onClick={() => setPending({ s, action: a })}>
                  {t(`page.storage.action.${a}` as MessageKey)}
                </Button>
              ))}
            </div>
          </div>
        ))}
      </CardContent>
      <ConfirmDialog
        open={!!pending}
        onOpenChange={(o) => !o && setPending(null)}
        title={pending && ck ? t(ck.titleKey, { importance: impName(pending.s.importance), age: ageLabel(t, pending.s.olderThan) }) : ""}
        description={
          <div className="space-y-2">
            {ck?.bodyKeys.map((k) => (
              <p key={k}>{t(k)}</p>
            ))}
            {/* Review QT-S3 L3: số ước tính là của hành động GỢI Ý — chọn hành động khác thì nói rõ, không giả là số của nó. */}
            {pending && (
              <p className="font-medium">
                {pending.action === pending.s.action
                  ? t("page.storage.suggestion.frees", { size: formatBytes(pending.s.estimatedBytes), count: pending.s.estimatedEvents })
                  : t("page.storage.suggestion.frees-of-suggested", {
                      action: t(`page.storage.action.${pending.s.action}` as MessageKey),
                      size: formatBytes(pending.s.estimatedBytes),
                      count: pending.s.estimatedEvents,
                    })}
              </p>
            )}
          </div>
        }
        confirmLabel={pending ? t("page.storage.confirm.ok", { action: t(`page.storage.action.${pending.action}` as MessageKey) }) : ""}
        destructive={pending?.action === "delete"}
        pending={clean.isPending || apply.isPending}
        onConfirm={run}
      />
    </Card>
  );
}

type PolicyDraft = Pick<StoragePolicyView, "importance" | "action" | "afterDays" | "trigger">;

function AutoCleanCard({ canWrite }: { canWrite: boolean }) {
  const t = useT();
  const fmt = useDateTime();
  const projectId = useFlowProjectStore((s) => s.projectId);
  const q = useStoragePolicies(projectId);
  const save = useSaveStoragePolicies(projectId);
  const [draft, setDraft] = useState<PolicyDraft[] | null>(null);
  const rows = useMemo<PolicyDraft[]>(() => draft ?? (q.data?.policies ?? []).map(({ importance, action, afterDays, trigger }) => ({ importance, action, afterDays, trigger })), [draft, q.data]);
  if (!q.data) return null;
  const set = (i: number, patch: Partial<PolicyDraft>) => setDraft(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const last = q.data.lastRun;
  return (
    <Card id="auto-clean" className="scroll-mt-20">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          {t("page.storage.auto")}
          <Badge variant={q.data.autoCleanEnabled ? "default" : "outline"}>
            {t(q.data.autoCleanEnabled ? "page.storage.auto.running" : "page.storage.auto.not-running")}
          </Badge>
        </CardTitle>
        <CardDescription>
          {last
            ? t("page.storage.auto.last-run", {
                at: fmt(last.at),
                size: formatBytes(last.freedBytes),
                count: last.events,
                importance: t(`page.storage.importance.${last.importance}` as MessageKey),
              })
            : t("page.storage.auto.never")}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <SimpleTable
          rows={rows}
          getRowKey={(r) => r.importance}
          columns={[
            {
              key: "importance",
              header: t("page.storage.auto.col.importance"),
              className: "font-medium",
              cell: (r) => t(`page.storage.importance.${r.importance}` as MessageKey),
            },
            {
              key: "action",
              header: t("page.storage.auto.col.action"),
              cell: (r, i) => (
                <Select value={r.action} disabled={!canWrite} onValueChange={(v) => set(i, { action: v as PolicyDraft["action"] })}>
                  <SelectTrigger size="sm" aria-label={t("page.storage.auto.col.action")}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(r.importance === "junk" ? (["delete", "off"] as const) : (["trim", "delete", "off"] as const)).map((a) => (
                      <SelectItem key={a} value={a}>
                        {a === "off" ? t("page.storage.auto.off") : t(`page.storage.action.${a}` as MessageKey)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ),
            },
            {
              key: "after",
              header: t("page.storage.auto.col.after"),
              cell: (r, i) => (
                <Input
                  type="number"
                  min={1}
                  max={365}
                  className="h-8 w-20"
                  value={r.afterDays}
                  disabled={!canWrite || r.action === "off"}
                  aria-label={t("page.storage.auto.col.after")}
                  onChange={(e) => set(i, { afterDays: Math.max(1, Math.min(365, Number(e.target.value) || 1)) })}
                />
              ),
            },
            {
              key: "trigger",
              header: t("page.storage.auto.col.trigger"),
              cell: (r, i) => (
                <Select
                  value={r.trigger}
                  disabled={!canWrite || r.action === "off"}
                  onValueChange={(v) => set(i, { trigger: v as PolicyDraft["trigger"] })}
                >
                  <SelectTrigger size="sm" aria-label={t("page.storage.auto.col.trigger")}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="always">{t("page.storage.auto.trigger.always")}</SelectItem>
                    <SelectItem value="above_85">{t("page.storage.auto.trigger.above-85")}</SelectItem>
                  </SelectContent>
                </Select>
              ),
            },
          ]}
        />
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-muted-foreground text-xs">{t("page.storage.auto.note")}</p>
          <Button
            size="sm"
            disabled={!canWrite || !draft || save.isPending}
            onClick={() =>
              save.mutate(rows, {
                onSuccess: () => {
                  setDraft(null);
                  toast.success(t("page.storage.auto.saved"));
                },
                onError: (e) => toast.error(e instanceof HubApiError ? errorMessageOf(e.body, t) : String(e)),
              })
            }
          >
            {save.isPending && <Loader2 className="size-4 animate-spin" aria-hidden />}
            {t("page.storage.auto.save")}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function EmailCard() {
  const t = useT();
  const projectId = useFlowProjectStore((s) => s.projectId);
  const q = useStorageEmail(projectId);
  const save = useSaveStorageEmail(projectId);
  if (!q.data) return null;
  return (
    <Card id="email" className="scroll-mt-20">
      <CardHeader>
        <CardTitle>{t("page.storage.email")}</CardTitle>
        <CardDescription>{t("page.storage.email.locked")}</CardDescription>
      </CardHeader>
      <CardContent>
        {q.data.member ? (
          <label className="inline-flex items-center gap-2 text-sm">
            <Switch
              checked={q.data.warnEmail}
              disabled={save.isPending}
              onCheckedChange={(v) => save.mutate(v, { onError: (err) => toast.error(err instanceof HubApiError ? errorMessageOf(err.body, t) : String(err)) })}
            />
            {t("page.storage.email.warn")}
          </label>
        ) : (
          <p className="text-muted-foreground text-sm">{t("page.storage.email.not-member")}</p>
        )}
      </CardContent>
    </Card>
  );
}

function JobsCard() {
  const t = useT();
  const fmt = useDateTime();
  const { data } = useOverview();
  if (!data || data.recentCleanJobs.length === 0) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("page.storage.jobs")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-1 text-sm">
        {data.recentCleanJobs.map((j) => (
          <div key={j.id} className="flex flex-wrap justify-between gap-2">
            <span>
              {t("page.storage.job", {
                action: t(`page.storage.action.${j.action}` as MessageKey),
                status: t(`page.storage.job.${j.status.toLowerCase()}` as MessageKey),
                size: formatBytes(j.freedBytes),
              })}
              {" · "}
              {(j.importance as Importance[]).map((i) => t(`page.storage.importance.${i}` as MessageKey)).join(", ")}
            </span>
            <span className="text-muted-foreground tabular-nums">{fmt(j.finishedAt ?? j.createdAt)}</span>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
