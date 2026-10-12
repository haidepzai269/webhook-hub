"use client";

import { useEffect } from "react";

import { cn } from "cn";
import { ChevronDown, ChevronsUpDown, FolderKanban } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem, useSidebar } from "@/components/ui/sidebar";
import { type ProjectSummary, restoreFlowProject, useFlowProjectStore, useProjects } from "@/lib/hub/flow-project";
import { useT } from "@/lib/i18n/use-t";

import { projectItemTitle, projectPickerView, roleLabel } from "./project-picker-logic";
import { ICON } from "./tokens";

function useProjectPicker() {
  const { data } = useProjects();
  const projectId = useFlowProjectStore((s) => s.projectId);
  const setProjectId = useFlowProjectStore((s) => s.setProjectId);
  useEffect(() => restoreFlowProject(), []);
  return { data, projectId, setProjectId };
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
          <DropdownMenuRadioItem key={p.id} value={p.id} title={projectItemTitle(p, t)} className="min-w-0">
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
  const { data, projectId, setProjectId } = useProjectPicker();
  const t = useT();
  if (!data || data.length === 0) return null;
  const v = projectPickerView(data, projectId, t);
  return (
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
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Bộ chọn project trong sidebar, dựng trên `SidebarMenuButton`:
 * - mở rộng: một dòng, tên cắt ellipsis (title = tên đầy đủ), badge operator gọn, chevron thẳng hàng;
 * - thu gọn (rail icon): chỉ còn icon folder (+ chấm vàng nếu operator), tooltip bên phải = tên project, bấm mở cùng dropdown.
 */
export function SidebarProjectPicker() {
  const { data, projectId, setProjectId } = useProjectPicker();
  const { state, isMobile } = useSidebar();
  const t = useT();
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
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
