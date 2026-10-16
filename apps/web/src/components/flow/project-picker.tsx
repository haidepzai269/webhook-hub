"use client";

import { useEffect, useState } from "react";

import Link from "next/link";

import { cn } from "cn";
import { ChevronDown, ChevronsUpDown, FolderKanban, LayoutGrid, Plus } from "lucide-react";
import { toast } from "sonner";

import { CreateProjectDialog } from "@/components/admin/create-project-dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem, useSidebar } from "@/components/ui/sidebar";
import { Skeleton } from "@/components/ui/skeleton";
import { type ProjectSummary, restoreFlowProject, useFlowProjectStore, useProjects } from "@/lib/hub/flow-project";
import { useT } from "@/lib/i18n/use-t";

import { projectItemTitle, projectPickerView, roleLabel } from "./project-picker-logic";
import { ICON } from "./tokens";

function useProjectPicker() {
  const { data, isPending } = useProjects();
  const projectId = useFlowProjectStore((s) => s.projectId);
  const setProjectId = useFlowProjectStore((s) => s.setProjectId);
  const [createOpen, setCreateOpen] = useState(false);
  useEffect(() => restoreFlowProject(), []);
  // ADR-238: đang tải (kể cả chờ AuthGuard) -> khung chờ cùng cỡ nút; chỉ ẩn khi đã biết là trống/lỗi.
  return { data, loading: isPending && !data, projectId, setProjectId, createOpen, setCreateOpen };
}

/**
 * ADR-234: tạo dự án từ bộ chọn — hộp thoại đặt NGOÀI DropdownMenu (menu đóng thì nội dung menu bị gỡ). Tạo xong: chọn
 * luôn dự án mới (mọi query đổi projectId, như chọn tay).
 */
function PickerCreateDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onCreated: (id: string) => void;
}) {
  const t = useT();
  return (
    <CreateProjectDialog
      open={open}
      onOpenChange={onOpenChange}
      onCreated={(p) => {
        onCreated(p.id);
        toast.success(t("page.projects.created", { name: p.name }));
      }}
    />
  );
}

/** ADR-234: cuối danh sách — "+ Tạo dự án mới" và "Tất cả dự án" (trang tầng tài khoản `/projects`). */
function ProjectListFooter({ onCreate }: { onCreate: () => void }) {
  const t = useT();
  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuItem className="cursor-pointer" onSelect={onCreate}>
        <Plus />
        {t("admin.project.create-new")}
      </DropdownMenuItem>
      <DropdownMenuItem className="cursor-pointer" asChild>
        <Link href="/projects">
          <LayoutGrid />
          {t("admin.project.all")}
        </Link>
      </DropdownMenuItem>
    </>
  );
}

/** Danh sách project trong dropdown — mỗi dòng một hàng, tên dài cắt ellipsis, tooltip (title) đầy đủ. */
function ProjectList({
  data,
  currentId,
  onChange,
}: {
  data: ProjectSummary[];
  currentId: string;
  onChange: (id: string) => void;
}) {
  const t = useT();
  return (
    <>
      <DropdownMenuLabel>{t("admin.project.label")}</DropdownMenuLabel>
      <DropdownMenuRadioGroup value={currentId} onValueChange={onChange}>
        {data.map((p) => (
          <DropdownMenuRadioItem
            key={p.id}
            value={p.id}
            title={projectItemTitle(p, t)}
            className="min-w-0 cursor-pointer"
          >
            <span className="min-w-0 flex-1 truncate">{p.name}</span>
            {p.member === false ? (
              <span className="shrink-0 text-amber-600 text-xs dark:text-amber-400">{t("admin.project.operator")}</span>
            ) : (
              p.role && <span className="shrink-0 text-muted-foreground text-xs">{roleLabel(p.role, t)}</span>
            )}
            <span className="max-w-24 shrink-0 truncate pl-1 font-mono text-muted-foreground text-xs">{p.slug}</span>
          </DropdownMenuRadioItem>
        ))}
      </DropdownMenuRadioGroup>
    </>
  );
}

/**
 * Bộ chọn project (AU3: dùng cho TOÀN dashboard — sidebar dùng `SidebarProjectPicker`; màn Event Flow/Events đặt thêm cái này).
 * Danh sách từ `GET /api/v1/projects` (project mình là thành viên; operator thấy hết). Trống/lỗi thì ẩn.
 * Đổi project: mọi query gắn projectId mới, socket xin vé mới (socket.ts).
 */
export function ProjectPicker({ className }: { className?: string }) {
  const { data, loading, projectId, setProjectId, createOpen, setCreateOpen } = useProjectPicker();
  const t = useT();
  // Cùng cỡ Button size="sm" (h-8) — không nhảy thanh công cụ khi danh sách về.
  if (loading) return <Skeleton className={cn("h-8 w-40 rounded-md", className)} />;
  if (!data || data.length === 0) return null;
  const v = projectPickerView(data, projectId, t);
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            className={cn("max-w-full", className)}
            aria-label={t("admin.project.label")}
            title={v.tooltip}
          >
            <FolderKanban {...ICON} />
            <span className="min-w-0 max-w-64 truncate">{v.label}</span>
            {v.operator && (
              <span
                className="shrink-0 rounded bg-amber-500/15 px-1.5 text-amber-700 text-xs dark:text-amber-400"
                title={t("admin.project.operator-note")}
              >
                {t("admin.project.operator")}
              </span>
            )}
            <ChevronDown {...ICON} />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-auto min-w-56 max-w-80">
          <ProjectList data={data} currentId={v.current?.id ?? ""} onChange={setProjectId} />
          <ProjectListFooter onCreate={() => setCreateOpen(true)} />
        </DropdownMenuContent>
      </DropdownMenu>
      <PickerCreateDialog open={createOpen} onOpenChange={setCreateOpen} onCreated={setProjectId} />
    </>
  );
}

/**
 * Bộ chọn project trong sidebar, dựng trên `SidebarMenuButton`:
 * - mở rộng: một dòng, tên cắt ellipsis (title = tên đầy đủ), badge operator gọn, chevron thẳng hàng;
 * - thu gọn (rail icon): chỉ còn icon folder (+ chấm vàng nếu operator), tooltip bên phải = tên project, bấm mở cùng dropdown.
 */
export function SidebarProjectPicker() {
  const { data, loading, projectId, setProjectId, createOpen, setCreateOpen } = useProjectPicker();
  const { state, isMobile } = useSidebar();
  const t = useT();
  if (loading) return <SidebarProjectPickerSkeleton />;
  if (!data || data.length === 0) return null;
  const v = projectPickerView(data, projectId, t);
  const collapsed = state === "collapsed" && !isMobile;
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              variant="outline"
              tooltip={v.tooltip}
              aria-label={t("admin.project.aria", { project: v.tooltip })}
              className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
            >
              <span className="relative flex shrink-0 items-center">
                <FolderKanban />
                {v.operator && (
                  <span
                    aria-hidden
                    className="absolute -top-0.5 -right-0.5 hidden size-1.5 rounded-full bg-amber-500 group-data-[collapsible=icon]:block"
                  />
                )}
              </span>
              <span className="min-w-0 flex-1 truncate group-data-[collapsible=icon]:hidden" title={v.label}>
                {v.label}
              </span>
              {v.operator && (
                <span
                  className="shrink-0 rounded bg-amber-500/15 px-1 text-[10px] text-amber-700 leading-4 group-data-[collapsible=icon]:hidden dark:text-amber-400"
                  title={t("admin.project.operator-note")}
                >
                  {t("admin.project.operator")}
                </span>
              )}
              <ChevronsUpDown className="ml-auto shrink-0 text-muted-foreground group-data-[collapsible=icon]:hidden" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            side={collapsed ? "right" : "bottom"}
            align="start"
            className={cn("max-w-80", collapsed ? "w-64" : "min-w-56")}
          >
            <ProjectList data={data} currentId={v.current?.id ?? ""} onChange={setProjectId} />
            <ProjectListFooter onCreate={() => setCreateOpen(true)} />
          </DropdownMenuContent>
        </DropdownMenu>
        <PickerCreateDialog open={createOpen} onOpenChange={setCreateOpen} onCreated={setProjectId} />
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

/** Khung chờ đúng hình `SidebarMenuButton variant="outline"` (h-8, rail thu gọn còn ô vuông 8x8). */
function SidebarProjectPickerSkeleton() {
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <div className="flex h-8 items-center gap-2 rounded-md border border-sidebar-border px-2 group-data-[collapsible=icon]:size-8 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:p-0">
          <Skeleton className="size-4 shrink-0 rounded-sm" />
          <Skeleton className="h-3.5 flex-1 group-data-[collapsible=icon]:hidden" />
        </div>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
