"use client";

import { useEffect } from "react";

import { ChevronDown, FolderKanban } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { restoreFlowProject, useFlowProjectStore, useProjects } from "@/lib/hub/flow-project";

import { ICON } from "./tokens";

/**
 * Bộ chọn project (AU3: dùng cho TOÀN dashboard — gắn ở sidebar; màn Event Flow vẫn đặt thêm một cái).
 * Danh sách từ `GET /api/v1/projects` (project mình là thành viên; operator thấy hết). Trống/lỗi thì ẩn.
 * Đổi project: mọi query gắn projectId mới, socket xin vé mới (socket.ts).
 */
export function ProjectPicker({ className }: { className?: string }) {
  const { data } = useProjects();
  const projectId = useFlowProjectStore((s) => s.projectId);
  const setProjectId = useFlowProjectStore((s) => s.setProjectId);
  useEffect(() => restoreFlowProject(), []);
  if (!data || data.length === 0) return null;
  const current = data.find((p) => p.id === projectId) ?? data[0];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className={className} aria-label="Project">
          <FolderKanban {...ICON} />
          {current?.name ?? "Chọn project"}
          <ChevronDown {...ICON} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>Project</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={current?.id ?? ""}
          onValueChange={(v) => setProjectId(v)}
        >
          {data.map((p) => (
            <DropdownMenuRadioItem key={p.id} value={p.id}>
              {p.name}
              {p.role && <span className="pl-2 text-muted-foreground text-xs">{p.role}</span>}
              <span className="ml-auto pl-3 font-mono text-muted-foreground text-xs">{p.slug}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
