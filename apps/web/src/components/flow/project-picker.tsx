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

const DEFAULT = "__default";

/** Bộ chọn project cho V2/V3 (F7). Danh sách từ `GET /api/v1/projects`; trống/lỗi thì ẩn. */
export function ProjectPicker({ className }: { className?: string }) {
  const { data } = useProjects();
  const projectId = useFlowProjectStore((s) => s.projectId);
  const setProjectId = useFlowProjectStore((s) => s.setProjectId);
  useEffect(() => restoreFlowProject(), []);
  if (!data || data.length === 0) return null;
  const current = data.find((p) => p.id === projectId) ?? data.find((p) => p.slug === "default");
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className={className} aria-label="Project">
          <FolderKanban {...ICON} />
          {current?.name ?? "default"}
          <ChevronDown {...ICON} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>Project</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={projectId ?? DEFAULT}
          onValueChange={(v) => {
            const p = data.find((x) => x.id === v);
            setProjectId(v === DEFAULT || p?.slug === "default" ? null : v);
          }}
        >
          {data.map((p) => (
            <DropdownMenuRadioItem key={p.id} value={p.slug === "default" ? DEFAULT : p.id}>
              {p.name}
              <span className="ml-auto pl-3 font-mono text-muted-foreground text-xs">{p.slug}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
