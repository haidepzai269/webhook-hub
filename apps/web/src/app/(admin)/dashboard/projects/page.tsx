"use client";

import { useState } from "react";

import Link from "next/link";

import { KeyRound, Plus } from "lucide-react";
import { toast } from "sonner";

import { CreateProjectDialog } from "@/components/admin/create-project-dialog";
import { PageHeader } from "@/components/admin/page-header";
import { ErrorState } from "@/components/admin/state";
import { TableRowsSkeleton } from "@/components/admin/skeletons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { HubApiError } from "@/lib/hub/client";
import { type ProjectSummary, useFlowProjectStore, useProjects } from "@/lib/hub/flow-project";
import { useIsOperator } from "@/lib/hub/me-store";
import { useSetUnverifiedSources, useUnverifiedSources } from "@/lib/hub/project-queries";
import { useSetStorageQuota } from "@/lib/hub/storage-queries";
import type { MessageKey } from "@/lib/i18n/dictionary";
import { useT } from "@/lib/i18n/use-t";
import { formatBytes, levelSeg, levelTone, parseLevel, parseQuotaInput } from "@/lib/storage/storage-logic";
import { toneBadgeClass } from "@/components/admin/status-badge";

const ROLE_KEY: Record<string, MessageKey> = { owner: "page.projects.role.owner", member: "page.projects.role.member" };
const ENV_KEY: Record<string, MessageKey> = { test: "page.projects.env.test", live: "page.projects.env.live" };

/** QT7 (§9): cột mức sử dụng (ước tính) của người vận hành — % + nấc, màu theo nấc. */
function UsageCell({ usage }: { usage: NonNullable<ProjectSummary["usage"]> }) {
  const t = useT();
  const level = parseLevel(usage.level);
  const color = { ok: "var(--muted-foreground)", warning: "var(--warning)", danger: "var(--danger)" }[levelTone(level)];
  return (
    <span className="whitespace-nowrap text-xs tabular-nums" title={t("page.storage.estimated")}>
      <span style={{ color }} className="font-medium">
        {usage.usedPct}%
      </span>{" "}
      <span className="text-muted-foreground">
        {formatBytes(usage.usedBytes)} / {formatBytes(usage.quotaBytes)}
        {level !== "OK" ? ` · ${t(`page.storage.level.${levelSeg(level)}` as MessageKey)}` : ""}
      </span>
    </span>
  );
}

/** QT7 (§2, §9): ô ghi đè `storage_quota_mb` — trống = mặc định env. Chỉ operator (server: OperatorGuard). */
function QuotaOverride({ projectId, name, value }: { projectId: string; name: string; value: number | null }) {
  const t = useT();
  const save = useSetStorageQuota();
  const [v, setV] = useState(value === null ? "" : String(value));
  const parsed = parseQuotaInput(v);
  const dirty = parsed !== undefined && parsed !== value;
  return (
    <form
      className="flex items-center gap-1"
      onSubmit={(e) => {
        e.preventDefault();
        if (parsed === undefined) return void toast.error(t("page.storage.quota.invalid"));
        save.mutate(
          { projectId, storageQuotaMb: parsed },
          {
            onSuccess: () => toast.success(t("page.storage.quota.saved", { name })),
            onError: (err) => toast.error(err instanceof HubApiError ? err.message : String(err)),
          },
        );
      }}
    >
      <Input
        className="h-8 w-24"
        inputMode="numeric"
        placeholder={t("page.storage.quota.default")}
        value={v}
        aria-label={t("page.storage.quota.override")}
        aria-invalid={parsed === undefined}
        onChange={(e) => setV(e.target.value)}
      />
      <Button type="submit" size="sm" variant="outline" disabled={!dirty || save.isPending}>
        {t("page.storage.quota.save")}
      </Button>
    </form>
  );
}

/**
 * PK5 khoá 1 (SPEC-provider-khac §7.1, E14, E26, ADR-206): "Nhận nguồn chưa xác thực" của project đang chọn. Chỉ owner (hoặc
 * người vận hành) bật/tắt — server kiểm `manage:project` và ghi audit. Tắt: mọi nguồn `unverified` bị từ chối ngay, không lưu.
 */
function UnverifiedSourcesSetting({ projectId, canEdit }: { projectId: string; canEdit: boolean }) {
  const t = useT();
  const q = useUnverifiedSources(projectId);
  const save = useSetUnverifiedSources(projectId);
  const on = q.data?.allowUnverifiedSources === true;
  return (
    <section className="mt-6 flex flex-col gap-2 rounded-md border p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="font-medium text-sm">{t("page.projects.unverified.title")}</p>
          <p className="text-muted-foreground text-xs">{t("page.projects.unverified.hint")}</p>
        </div>
        <Badge variant={on ? "outline" : "secondary"} className={on ? toneBadgeClass("warn") : undefined}>
          {t(on ? "page.projects.unverified.on" : "page.projects.unverified.off")}
        </Badge>
      </div>
      {canEdit ? (
        <div>
          <Button
            size="sm"
            variant="outline"
            disabled={q.isLoading || save.isPending}
            onClick={() =>
              save.mutate(!on, {
                onSuccess: (r) => toast.success(t(r.allowUnverifiedSources ? "page.projects.unverified.enabled" : "page.projects.unverified.disabled")),
                onError: (err) => toast.error(err instanceof HubApiError ? err.message : String(err)),
              })
            }
          >
            {t(on ? "page.projects.unverified.turn-off" : "page.projects.unverified.turn-on")}
          </Button>
        </div>
      ) : (
        <p className="text-muted-foreground text-xs">{t("page.projects.unverified.owner-only")}</p>
      )}
    </section>
  );
}

/** SK1 (SPEC-shop-ket-noi-project §3): danh sách project của mình + tạo project (tên + slug). */
export default function ProjectsPage() {
  const t = useT();
  const operator = useIsOperator();
  const roleLabel = (role: string | undefined) => (role && ROLE_KEY[role] ? t(ROLE_KEY[role]) : (role ?? "—"));
  const { data, isLoading, error, refetch } = useProjects();
  const projectId = useFlowProjectStore((s) => s.projectId);
  const setProjectId = useFlowProjectStore((s) => s.setProjectId);
  const [open, setOpen] = useState(false);

  return (
    <>
      <PageHeader
        title={t("page.projects.title")}
        description={t("page.projects.description")}
        actions={
          <Button variant="outline" onClick={() => setOpen(true)}>
            <Plus />
            {t("page.projects.create")}
          </Button>
        }
      />
      {error && <ErrorState className="mb-3" message={t("page.projects.load-error", { message: error.message })} onRetry={() => void refetch()} />}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("page.projects.col.name")}</TableHead>
            <TableHead>{t("page.projects.col.slug")}</TableHead>
            <TableHead>{t("page.projects.col.environment")}</TableHead>
            <TableHead>{t("page.projects.col.role")}</TableHead>
            {operator && <TableHead>{t("page.storage.col.usage")}</TableHead>}
            {operator && <TableHead>{t("page.storage.quota.override")}</TableHead>}
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {isLoading && <TableRowsSkeleton cols={operator ? 7 : 5} />}
          {(data ?? []).map((p) => (
            <TableRow key={p.id}>
              <TableCell className="font-medium">
                {p.name} {p.id === projectId && <Badge variant="secondary">{t("page.projects.selected")}</Badge>}
              </TableCell>
              <TableCell className="font-mono text-xs">{p.slug}</TableCell>
              <TableCell>{ENV_KEY[p.environment] ? t(ENV_KEY[p.environment]) : p.environment}</TableCell>
              <TableCell>
                {p.member === false ? t("page.projects.role.operator") : roleLabel(p.role)}
              </TableCell>
              {operator && (
                <TableCell>
                  {p.usage ? <UsageCell usage={p.usage} /> : "—"}
                </TableCell>
              )}
              {operator && (
                <TableCell>
                  <QuotaOverride projectId={p.id} name={p.name} value={p.usage?.quotaOverrideMb ?? null} />
                </TableCell>
              )}
              <TableCell className="text-right">
                {p.id !== projectId ? (
                  <Button size="sm" variant="outline" onClick={() => setProjectId(p.id)}>
                    {t("page.projects.select")}
                  </Button>
                ) : (
                  <Button size="sm" variant="ghost" asChild>
                    <Link href="/dashboard/api-keys">
                      <KeyRound />
                      {t("page.projects.api-keys")}
                    </Link>
                  </Button>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {projectId && (data ?? []).some((p) => p.id === projectId) && (
        <UnverifiedSourcesSetting
          projectId={projectId}
          canEdit={operator || (data ?? []).find((p) => p.id === projectId)?.role === "owner"}
        />
      )}

      <CreateProjectDialog
        open={open}
        onOpenChange={setOpen}
        onCreated={(p) => {
          setProjectId(p.id); // làm việc ngay trong project mới
          toast.success(t("page.projects.created", { name: p.name }));
        }}
      />
    </>
  );
}
