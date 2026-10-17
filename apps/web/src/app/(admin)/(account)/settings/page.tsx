"use client";

import { useId, useState } from "react";

import { Loader2, Mail } from "lucide-react";
import { toast } from "sonner";

import { useAuthBooting } from "@/components/admin/auth-guard";
import { PageHeader } from "@/components/admin/page-header";
import { SimpleTable } from "@/components/admin/simple-table";
import { EmptyState, ErrorState } from "@/components/admin/state";
import { SeverityDot } from "@/components/alerts/alert-ui";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { SearchInput } from "@/components/admin/search-input";
import { CardSkeleton } from "@/components/admin/skeletons";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { ruleName } from "@/lib/alerts/message";
import {
  type AlertPreferencesPatch,
  activePreset,
  emailSwitchState,
  muteListView,
  presetRules,
  ruleDescriptionKey,
  ruleRows,
  toggleMuted,
  toggleRule,
} from "@/lib/alerts/settings-logic";
import { HubApiError } from "@/lib/hub/client";
import { useProjects } from "@/lib/hub/flow-project";
import { useIsOperator } from "@/lib/hub/me-store";
import { useAlertPreferences, useSaveAlertPreferences, useSendTestAlertEmail } from "@/lib/hub/settings-queries";
import { errorMessageOf } from "@/lib/hub/ui-logic";
import { useT } from "@/lib/i18n/use-t";

/**
 * CB5 (SPEC-canh-bao-nhan-dinh §8.5): trang Cài đặt → mục "Cảnh báo" (chỉ operator). Mỗi thay đổi lưu ngay (PUT chỉ trường
 * đổi); logic thuần ở lib/alerts/settings-logic.ts.
 */
export default function SettingsPage() {
  const t = useT();
  const operator = useIsOperator();
  const booting = useAuthBooting();
  return (
    <>
      <PageHeader title={t("page.settings.title")} description={t("page.settings.description")} />
      {/* ADR-238: chưa có /auth/me -> chưa biết có phải operator; cùng khung chờ với AlertSettings đang tải. */}
      {!operator && booting && <CardSkeleton lines={6} />}
      {operator && <AlertSettings />}
      {!operator && !booting && <p className="text-muted-foreground text-sm">{t("page.settings.operator-only")}</p>}
    </>
  );
}

function Check({
  checked,
  disabled,
  onChange,
  label,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <Checkbox checked={checked} disabled={disabled} aria-label={label} onCheckedChange={(v) => onChange(v === true)} />
  );
}

function AlertSettings() {
  const t = useT();
  const prefs = useAlertPreferences();
  const save = useSaveAlertPreferences();
  const test = useSendTestAlertEmail();
  const projects = useProjects();
  const switchId = useId();
  const resolveId = useId();

  const errorText = (err: unknown) =>
    err instanceof HubApiError ? errorMessageOf(err.body, t) || err.message : String(err);
  const put = (patch: AlertPreferencesPatch) => save.mutate(patch, { onError: (err) => toast.error(errorText(err)) });

  if (prefs.isLoading) return <CardSkeleton lines={6} />;
  if (prefs.isError || !prefs.data) return <ErrorState message={t("page.settings.load-error")} onRetry={() => void prefs.refetch()} />;
  const p = prefs.data;
  const sw = emailSwitchState(p);
  const rows = ruleRows(p.rules, p.emailRules);
  const preset = activePreset(p.rules, p.emailRules);
  const busy = save.isPending;

  const sendTest = () =>
    test.mutate(undefined, {
      onSuccess: (r) => toast.success(t("page.settings.alerts.test.sent", { email: r.to, remaining: r.remaining })),
      onError: (err) => toast.error(errorText(err)),
    });

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("page.settings.alerts.title")}</CardTitle>
        <CardDescription>{t("page.settings.alerts.lead")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <section className="space-y-1">
          <div className="flex items-center gap-3">
            <Switch
              id={switchId}
              checked={p.emailEnabled}
              disabled={sw.disabled || busy}
              onCheckedChange={(v) => put({ emailEnabled: v })}
            />
            <label htmlFor={switchId} className="font-medium text-sm">
              {t("page.settings.alerts.email-toggle")}
            </label>
          </div>
          {p.email && (
            <p className="flex items-center gap-1.5 pl-12 text-muted-foreground text-xs">
              <Mail className="size-3.5" />
              {t("page.settings.alerts.email-to", { email: p.email })}
            </p>
          )}
          {sw.reasonKey && (
            <p className="pl-12 text-amber-700 text-xs dark:text-amber-400">
              {t(sw.reasonKey, { email: p.email ?? "" })}
            </p>
          )}
        </section>

        {p.emailEnabled && (
          <>
            <section className="space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="font-medium text-sm">{t("page.settings.alerts.rules.title")}</h3>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant={preset === "critical" ? "default" : "outline"}
                    disabled={busy}
                    onClick={() => put({ emailRules: presetRules(p.rules, "critical") })}
                  >
                    {t("page.settings.alerts.preset.critical")}
                  </Button>
                  <Button
                    size="sm"
                    variant={preset === "all" ? "default" : "outline"}
                    disabled={busy}
                    onClick={() => put({ emailRules: presetRules(p.rules, "all") })}
                  >
                    {t("page.settings.alerts.preset.all")}
                  </Button>
                </div>
              </div>
              <SimpleTable
                rows={rows}
                getRowKey={(r) => r.code}
                columns={[
                  {
                    key: "rule",
                    header: t("page.settings.alerts.rules.col.rule"),
                    cell: (r) => (
                      <>
                        <div className="font-medium text-sm">{ruleName(r.code, t)}</div>
                        <div className="text-muted-foreground text-xs">{t(ruleDescriptionKey(r.code))}</div>
                      </>
                    ),
                  },
                  {
                    key: "severity",
                    header: t("page.settings.alerts.rules.col.severity"),
                    className: "w-36",
                    cell: (r) => (
                      <Badge variant={r.severity === "critical" ? "destructive" : "outline"} className="gap-1.5">
                        <SeverityDot severity={r.severity} />
                        {t(`alerts.severity.${r.severity}`)}
                      </Badge>
                    ),
                  },
                  {
                    key: "send",
                    header: t("page.settings.alerts.rules.col.send"),
                    className: "w-24",
                    align: "center",
                    cell: (r) => (
                      <Check
                        checked={r.checked}
                        disabled={busy}
                        label={ruleName(r.code, t)}
                        onChange={(on) => put({ emailRules: toggleRule(p.rules, p.emailRules, r.code, on) })}
                      />
                    ),
                  },
                ]}
              />
            </section>

            <section className="space-y-1">
              <div className="flex items-center gap-3">
                <Checkbox
                  id={resolveId}
                  checked={p.emailOnResolve}
                  disabled={busy}
                  onCheckedChange={(v) => put({ emailOnResolve: v === true })}
                />
                <label htmlFor={resolveId} className="text-sm">
                  {t("page.settings.alerts.on-resolve")}
                </label>
              </div>
              <p className="pl-7 text-muted-foreground text-xs">{t("page.settings.alerts.on-resolve-hint")}</p>
            </section>

            <section className="space-y-2">
              <h3 className="font-medium text-sm">{t("page.settings.alerts.muted.title")}</h3>
              <p className="text-muted-foreground text-xs">{t("page.settings.alerts.muted.hint")}</p>
              {(projects.data ?? []).length === 0 ? (
                <EmptyState size="sm" title={t("page.settings.alerts.muted.empty")} />
              ) : (
                <MuteList
                  projects={projects.data ?? []}
                  muted={p.mutedProjects}
                  busy={busy}
                  onToggle={(id, mute) => put({ mutedProjects: toggleMuted(p.mutedProjects, id, mute) })}
                />
              )}
            </section>
          </>
        )}

        <section className="flex flex-wrap items-center gap-3 border-t pt-4">
          <Button size="sm" variant="outline" disabled={!p.emailVerified || test.isPending} onClick={sendTest}>
            {test.isPending ? <Loader2 className="size-4 animate-spin" /> : <Mail className="size-4" />}
            {t("page.settings.alerts.test.button")}
          </Button>
          <p className="text-muted-foreground text-xs">
            {t("page.settings.alerts.test.note", { cap: p.hourlyCap, perHour: p.testEmail.perHour })}
          </p>
        </section>
      </CardContent>
    </Card>
  );
}

/**
 * Danh sách tắt email theo dự án — có thể hàng trăm dự án: ô tìm (tên/slug), dự án đang tắt lên đầu, thu gọn còn 8 dòng
 * với "Hiện thêm" (logic thuần `muteListView`). Tên là chính, slug phụ và cắt "…" (đủ chữ trong `title`).
 */
function MuteList({
  projects,
  muted,
  busy,
  onToggle,
}: {
  projects: readonly { id: string; name: string; slug: string }[];
  muted: readonly string[];
  busy: boolean;
  onToggle: (id: string, mute: boolean) => void;
}) {
  const t = useT();
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState(false);
  const view = muteListView(projects, muted, { query, expanded });
  return (
    <div className="space-y-2">
      <SearchInput
        wrapperClassName="max-w-xs"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={t("page.settings.alerts.muted.search")}
        aria-label={t("page.settings.alerts.muted.search")}
        className="text-sm"
      />
      {view.matched === 0 ? (
        <EmptyState size="sm" title={t("page.settings.alerts.muted.no-match")} />
      ) : (
        <ul className="grid gap-1.5 sm:grid-cols-2">
          {view.rows.map((pr) => (
            <li key={pr.id} className="flex min-w-0 items-center gap-2 text-sm" title={`${pr.name} · ${pr.slug}`}>
              <Check
                checked={pr.muted}
                disabled={busy}
                label={t("page.settings.alerts.muted.label", { name: pr.name })}
                onChange={(mute) => onToggle(pr.id, mute)}
              />
              <span className="min-w-0 shrink truncate">{pr.name}</span>
              <span className="min-w-0 max-w-[45%] shrink-[2] truncate text-muted-foreground text-xs">{pr.slug}</span>
            </li>
          ))}
        </ul>
      )}
      {!query && (view.hidden > 0 || expanded) && (
        <Button size="xs" variant="ghost" onClick={() => setExpanded((x) => !x)}>
          {expanded ? t("common.show-less") : t("page.settings.alerts.muted.show-more", { count: view.hidden })}
        </Button>
      )}
    </div>
  );
}
