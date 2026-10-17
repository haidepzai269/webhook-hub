"use client";

import { useMemo, useState } from "react";

import Link from "next/link";
import { useRouter } from "next/navigation";

import { cn } from "cn";
import {
  ArrowRight,
  CalendarDays,
  CodeXml,
  Crown,
  Eye,
  FlaskConical,
  FolderKanban,
  Info,
  Plus,
  Radio,
  Search,
  Settings2,
  ShieldCheck,
} from "lucide-react";
import { toast } from "sonner";

import { AccountTopBar } from "@/components/admin/account-menu";
import { AuthGuard } from "@/components/admin/auth-guard";
import { CreateProjectDialog, type CreateProjectInput } from "@/components/admin/create-project-dialog";
import { PageHeader } from "@/components/admin/page-header";
import { roleLabel } from "@/components/flow/project-picker-logic";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { HubApiError } from "@/lib/hub/client";
import { type ProjectSummary, useProjectsWithStats } from "@/lib/hub/flow-project";
import { type ProjectHealthTone, type ProjectStats, projectHealth, projectHealthLabel } from "@/lib/hub/project-health";
import { useProjectStore } from "@/lib/hub/project-store";
import type { MessageKey } from "@/lib/i18n/dictionary";
import { useLocale, useT } from "@/lib/i18n/use-t";
import { barPct, formatBytes, levelSeg, levelTone, parseLevel } from "@/lib/storage/storage-logic";
import { toneBadgeClass } from "@/components/admin/status-badge";
import { Alert, AlertDescription } from "@/components/ui/alert";

import { DEMO_CURRENT_ID, DEMO_PROJECTS } from "./demo-projects";

const ROLE_ICON = { owner: Crown, developer: CodeXml, viewer: Eye } as const;
const TONE_COLOR = { ok: "var(--primary)", warning: "var(--warning)", danger: "var(--danger)" } as const;

/** ADR-235: viền thẻ theo sức khoẻ — xanh / đỏ / trung tính (ring mặc định của Card). */
const HEALTH_RING: Record<ProjectHealthTone, string> = {
  ok: "ring-2 ring-[var(--ok)]/70",
  danger: "ring-2 ring-[var(--danger)]",
  neutral: "",
};
const HEALTH_DOT: Record<ProjectHealthTone, string> = {
  ok: "bg-[var(--ok)]",
  danger: "bg-[var(--danger)]",
  neutral: "bg-muted-foreground/40",
};

/** Màu thẻ ổn định theo slug (cùng slug -> cùng màu) — chỉ để nhận diện bằng mắt, không mang nghĩa. */
function hueOf(slug: string): number {
  let h = 0;
  for (const ch of slug) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

function initials(name: string): string {
  const words = name
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const s = words.length > 1 ? `${words[0][0]}${words[1][0]}` : (words[0] ?? "?").slice(0, 2);
  return s.toUpperCase();
}

function ProjectAvatar({ p }: { p: ProjectSummary }) {
  const h = hueOf(p.slug);
  return (
    <span
      aria-hidden
      className="flex size-10 shrink-0 items-center justify-center rounded-lg font-semibold text-sm text-white shadow-sm"
      style={{ background: `linear-gradient(135deg, oklch(0.68 0.15 ${h}), oklch(0.52 0.17 ${(h + 40) % 360}))` }}
    >
      {initials(p.name)}
    </span>
  );
}

function UsageBar({ usage }: { usage: NonNullable<ProjectSummary["usage"]> }) {
  const t = useT();
  const level = parseLevel(usage.level);
  const color = TONE_COLOR[levelTone(level)];
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="text-muted-foreground">{t("page.projects.home.usage")}</span>
        <span className="tabular-nums">
          <span className="font-medium" style={{ color: level === "OK" ? undefined : color }}>
            {usage.usedPct}%
          </span>
          <span className="text-muted-foreground">
            {" "}
            · {formatBytes(usage.usedBytes)} / {formatBytes(usage.quotaBytes)}
          </span>
        </span>
      </div>
      <div
        className="h-1.5 overflow-hidden rounded-full bg-muted"
        title={level !== "OK" ? t(`page.storage.level.${levelSeg(level)}` as MessageKey) : undefined}
      >
        <div
          className="h-full rounded-full transition-all"
          style={{ width: `${barPct(usage.usedPct)}%`, background: color }}
        />
      </div>
    </div>
  );
}

const STAT_CELLS: {
  stat: keyof Omit<ProjectStats, "createdAt" | "storageLevel" | "openAlerts" | "circuitOpen">;
  label: MessageKey;
}[] = [
  { stat: "sources", label: "page.projects.home.stat.sources" },
  { stat: "endpoints", label: "page.projects.home.stat.endpoints" },
  { stat: "members", label: "page.projects.home.stat.members" },
  { stat: "events24h", label: "page.projects.home.stat.events24h" },
  { stat: "failedAttempts24h", label: "page.projects.home.stat.failed24h" },
  { stat: "dlq", label: "page.projects.home.stat.dlq" },
];

/** ADR-235: 6 số đếm của dự án. Ô "Gửi lỗi 24h"/"DLQ" > 0 tô màu để mắt bắt được. */
function StatGrid({ stats }: { stats: ProjectStats }) {
  const t = useT();
  const locale = useLocale();
  const fmt = new Intl.NumberFormat(locale === "vi" ? "vi-VN" : "en-US");
  return (
    <dl className="grid grid-cols-3 gap-x-2 gap-y-2 rounded-lg bg-muted/40 px-3 py-2">
      {STAT_CELLS.map(({ stat, label }) => {
        const n = stats[stat];
        const alarm = n > 0 && stat === "dlq";
        const warn = n > 0 && stat === "failedAttempts24h";
        return (
          <div key={stat} className="min-w-0">
            <dt className="truncate text-[11px] text-muted-foreground leading-4" title={t(label)}>
              {t(label)}
            </dt>
            <dd
              className={cn(
                "font-medium text-sm tabular-nums leading-5",
                alarm && "text-[var(--danger)]",
                warn && "text-[var(--warning)]",
              )}
            >
              {fmt.format(n)}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

function formatDate(iso: string, locale: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : new Intl.DateTimeFormat(locale === "vi" ? "vi-VN" : "en-US", { dateStyle: "medium" }).format(d);
}

function ProjectCard({ p, current, onOpen }: { p: ProjectSummary; current: boolean; onOpen: () => void }) {
  const t = useT();
  const locale = useLocale();
  const RoleIcon = p.role && p.role in ROLE_ICON ? ROLE_ICON[p.role as keyof typeof ROLE_ICON] : null;
  const live = p.environment === "live";
  const health = projectHealth(p.stats);
  const healthText = projectHealthLabel(health, t);
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`${t("page.projects.home.open")}: ${p.name} — ${healthText}`}
      data-health={health.tone}
      className="group/project cursor-pointer rounded-xl text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
    >
      <Card
        className={cn(
          "h-full gap-3 px-4 transition-all duration-200",
          "group-hover/project:-translate-y-0.5 group-hover/project:shadow-md",
          HEALTH_RING[health.tone],
        )}
      >
        <div className="flex items-start gap-3">
          <ProjectAvatar p={p} />
          <div className="min-w-0 flex-1">
            <span className="block truncate font-medium text-base leading-tight" title={p.name}>
              {p.name}
            </span>
            <span className="block truncate font-mono text-muted-foreground text-xs" title={p.slug}>
              {p.slug}
            </span>
          </div>
          <Badge
            variant="outline"
            className={cn(
              "shrink-0",
              toneBadgeClass(live ? "ok" : "warn"),
            )}
          >
            {live ? <Radio /> : <FlaskConical />}
            {t(live ? "page.projects.env.live" : "page.projects.env.test")}
          </Badge>
        </div>

        <p
          className={cn(
            "flex items-start gap-1.5 text-xs leading-4",
            health.tone === "danger" ? "font-medium text-[var(--danger)]" : "text-muted-foreground",
          )}
          title={healthText}
        >
          <span aria-hidden className={cn("mt-1 size-2 shrink-0 rounded-full", HEALTH_DOT[health.tone])} />
          <span className="line-clamp-2">{healthText}</span>
        </p>

        {p.stats && <StatGrid stats={p.stats} />}

        {p.usage && <UsageBar usage={p.usage} />}

        <div className="mt-auto flex items-center justify-between gap-2 border-t pt-3">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            {p.member === false ? (
              <Badge
                variant="outline"
                className={toneBadgeClass("warn")}
                title={t("admin.project.operator-note")}
              >
                <ShieldCheck />
                {t("admin.project.operator")}
              </Badge>
            ) : (
              p.role && (
                <Badge variant="secondary">
                  {RoleIcon && <RoleIcon />}
                  {roleLabel(p.role, t)}
                </Badge>
              )
            )}
            {current && (
              <Badge variant="outline" className="border-primary/40 text-primary">
                {t("page.projects.home.last-opened")}
              </Badge>
            )}
            {p.stats && (
              <span className="flex items-center gap-1 text-muted-foreground text-xs">
                <CalendarDays className="size-3" />
                {t("page.projects.home.created", { date: formatDate(p.stats.createdAt, locale) })}
              </span>
            )}
          </div>
          <span className="flex shrink-0 items-center gap-1 text-muted-foreground text-xs transition-colors group-hover/project:text-foreground">
            <span className="hidden sm:inline">{t("page.projects.home.open")}</span>
            <ArrowRight className="size-3.5 transition-transform group-hover/project:translate-x-0.5" />
          </span>
        </div>
      </Card>
    </button>
  );
}

function NewProjectCard({ onClick }: { onClick: () => void }) {
  const t = useT();
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex min-h-36 cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border border-dashed text-muted-foreground text-sm outline-none transition-colors hover:border-primary/50 hover:bg-muted/40 hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
    >
      <span className="flex size-9 items-center justify-center rounded-full bg-muted">
        <Plus className="size-4" />
      </span>
      {t("page.projects.create")}
    </button>
  );
}

export function GridSkeleton() {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: 6 }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: khung chờ tĩnh
        <Card key={i} className="gap-4 px-4">
          <div className="flex items-start gap-3">
            <Skeleton className="size-10 rounded-lg" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-3 w-1/3" />
            </div>
            <Skeleton className="h-5 w-12 rounded-full" />
          </div>
          <Skeleton className="h-16 w-full rounded-lg" />
          <div className="flex items-center justify-between border-t pt-3">
            <Skeleton className="h-5 w-24 rounded-full" />
            <Skeleton className="h-3 w-16" />
          </div>
        </Card>
      ))}
    </div>
  );
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  const t = useT();
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed px-6 py-16 text-center">
      <span className="flex size-12 items-center justify-center rounded-full bg-muted">
        <FolderKanban className="size-6 text-muted-foreground" />
      </span>
      <div className="space-y-1">
        <p className="font-medium">{t("page.projects.home.empty.title")}</p>
        <p className="max-w-sm text-muted-foreground text-sm">{t("page.projects.home.empty.body")}</p>
      </div>
      <Button onClick={onCreate}>
        <Plus />
        {t("page.projects.create")}
      </Button>
    </div>
  );
}

function Home({ demo }: { demo: boolean }) {
  const t = useT();
  const router = useRouter();
  // ADR-235: MỘT lượt đọc `?include=stats` (không N lần gọi). Chế độ demo không gọi API (401 -> /login).
  const real = useProjectsWithStats(!demo);
  const storeProjectId = useProjectStore((s) => s.projectId);
  const setProjectId = useProjectStore((s) => s.setProjectId);
  // DEMO: danh sách cục bộ (tạo thêm chỉ thêm vào bộ nhớ trang) — xem demo-projects.ts.
  const [demoList, setDemoList] = useState<ProjectSummary[]>(DEMO_PROJECTS);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);

  const projects = demo ? demoList : (real.data ?? []);
  const currentId = demo ? DEMO_CURRENT_ID : storeProjectId;
  const loading = !demo && real.isLoading;

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q ? projects.filter((p) => p.name.toLowerCase().includes(q) || p.slug.includes(q)) : projects;
    // Dự án mở gần nhất lên đầu, còn lại giữ thứ tự server.
    return [...list].sort((a, b) => Number(b.id === currentId) - Number(a.id === currentId));
  }, [projects, query, currentId]);

  const openProject = (p: ProjectSummary) => {
    if (demo) return void toast.info(t("page.projects.home.demo-open", { name: p.name }));
    setProjectId(p.id);
    router.push("/dashboard");
  };

  const demoCreate = (input: CreateProjectInput): Promise<ProjectSummary> =>
    new Promise((resolve, reject) =>
      setTimeout(() => {
        if (demoList.some((p) => p.slug === input.slug))
          return reject(new HubApiError(409, "", { error: "slug_taken" }));
        if (!/^[a-z0-9-]{3,63}$/.test(input.slug)) return reject(new HubApiError(422, "", null));
        resolve({
          id: `demo-new-${Date.now()}`,
          ...input,
          role: "owner",
          stats: {
            createdAt: new Date().toISOString(),
            sources: 0,
            endpoints: 0,
            members: 1,
            events24h: 0,
            failedAttempts24h: 0,
            dlq: 0,
            circuitOpen: 0,
            storageLevel: "OK",
            openAlerts: { critical: 0, warning: 0, info: 0 },
          },
        });
      }, 400),
    );

  const renderBody = () => {
    if (loading) return <GridSkeleton />;
    if (projects.length === 0) return <EmptyState onCreate={() => setOpen(true)} />;
    if (shown.length === 0)
      return (
        <p className="rounded-xl border border-dashed px-6 py-12 text-center text-muted-foreground text-sm">
          {t("page.projects.home.no-match", { query: query.trim() })}
        </p>
      );
    return (
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {shown.map((p) => (
          <ProjectCard key={p.id} p={p} current={p.id === currentId} onOpen={() => openProject(p)} />
        ))}
        {!query.trim() && <NewProjectCard onClick={() => setOpen(true)} />}
      </div>
    );
  };

  return (
    <div className="min-h-screen bg-background">
      <AccountTopBar demo={demo} />
      <main className="mx-auto w-full max-w-6xl px-4 py-8 md:px-6">
        {demo && (
          <Alert variant="warning" className="mb-6">
            <Info />
            <AlertDescription>{t("page.projects.home.demo")}</AlertDescription>
          </Alert>
        )}
        <PageHeader
          title={t("page.projects.home.title")}
          description={t("page.projects.home.description")}
          actions={
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="outline" asChild>
                <Link href="/dashboard/projects" title={t("page.projects.home.manage-hint")}>
                  <Settings2 />
                  {t("page.projects.home.manage")}
                </Link>
              </Button>
              <Button onClick={() => setOpen(true)}>
                <Plus />
                {t("page.projects.create")}
              </Button>
            </div>
          }
        />

        {(loading || projects.length > 0) && (
          <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="relative w-full sm:max-w-xs">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                type="search"
                className="pl-8"
                value={query}
                placeholder={t("page.projects.home.search")}
                aria-label={t("common.search")}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            {!loading && (
              <span className="text-muted-foreground text-sm tabular-nums">
                {t("page.projects.home.count", { count: shown.length })}
              </span>
            )}
          </div>
        )}

        {real.error && !demo && (
          <p className="mb-4 text-destructive text-sm">
            {t("page.projects.home.stats-error", { message: real.error.message })}
          </p>
        )}

        {renderBody()}
      </main>

      <CreateProjectDialog
        open={open}
        onOpenChange={setOpen}
        submitOverride={demo ? demoCreate : undefined}
        onCreated={(p) => {
          toast.success(t("page.projects.created", { name: p.name }));
          if (demo) return setDemoList((l) => [...l, p]);
          setProjectId(p.id); // vào thẳng dự án mới
          router.push("/dashboard");
        }}
      />
    </div>
  );
}

/** ADR-234: "Dự án của tôi" ở tầng tài khoản. Thật -> qua AuthGuard; `?demo=1` -> dữ liệu giả, không guard, không API. */
export function ProjectsHome({ demo }: { demo: boolean }) {
  if (demo) return <Home demo />;
  return (
    <AuthGuard>
      <Home demo={false} />
    </AuthGuard>
  );
}
