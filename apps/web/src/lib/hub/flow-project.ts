"use client";

import { useQuery } from "@tanstack/react-query";

import { hubFetch } from "./client";

/**
 * F7 (§6A) -> AU3: project đang xem dùng CHUNG toàn dashboard (`project-store.ts`). Giữ tên cũ cho màn Event Flow.
 */
export { restoreProject as restoreFlowProject, useProjectStore as useFlowProjectStore } from "./project-store";

/** Gắn `?projectId=` tường minh (hubFetch cũng tự gắn project đang chọn nếu path chưa có). */
export function withProject(path: string, projectId: string | null): string {
  if (!projectId) return path;
  return `${path}${path.includes("?") ? "&" : "?"}projectId=${encodeURIComponent(projectId)}`;
}

export interface ProjectSummary {
  id: string;
  slug: string;
  name: string;
  environment: string;
  /** AU3: role của mình trong project (operator không là thành viên = owner). */
  role?: string;
  /** false = operator đang thấy project mình KHÔNG là thành viên (quyền operator). */
  member?: boolean;
}

/** `GET /api/v1/projects` (console đa service) — trả MẢNG. */
export function useProjects() {
  return useQuery({ queryKey: ["projects"], queryFn: () => hubFetch<ProjectSummary[]>("/api/v1/projects"), staleTime: 60_000 });
}
