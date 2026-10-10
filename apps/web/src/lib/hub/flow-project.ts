"use client";

import { useQuery } from "@tanstack/react-query";
import { create } from "zustand";

import { hubFetch } from "./client";

/**
 * F7 (§6A): project đang xem trên các màn Event Flow. Gửi lên server bằng `?projectId=` — server đọc ĐÚNG
 * một chỗ (ProjectScopeGuard, X2). `null` = project của JWT (`default`). Nhớ trong localStorage (tiện ích
 * mỗi người xem). Không có ở đây: auth/membership (AU3) — admin env hiện là operator.
 */
const KEY = "flow:projectId";

/** Đọc lựa chọn đã nhớ — gọi trong effect (sau hydrate) để SSR và client khớp nhau. */
export function restoreFlowProject() {
  try {
    const v = localStorage.getItem(KEY);
    if (v && v !== useFlowProjectStore.getState().projectId) useFlowProjectStore.setState({ projectId: v });
  } catch {
    /* bỏ qua */
  }
}

export const useFlowProjectStore = create<{ projectId: string | null; setProjectId: (id: string | null) => void }>((set) => ({
  projectId: null,
  setProjectId: (projectId) => {
    try {
      if (projectId) localStorage.setItem(KEY, projectId);
      else localStorage.removeItem(KEY);
    } catch {
      /* chỉ không nhớ */
    }
    set({ projectId });
  },
}));

export function withProject(path: string, projectId: string | null): string {
  if (!projectId) return path;
  return `${path}${path.includes("?") ? "&" : "?"}projectId=${encodeURIComponent(projectId)}`;
}

export interface ProjectSummary {
  id: string;
  slug: string;
  name: string;
  environment: string;
}

/** `GET /api/v1/projects` (console đa service) — trả MẢNG. */
export function useProjects() {
  return useQuery({ queryKey: ["projects"], queryFn: () => hubFetch<ProjectSummary[]>("/api/v1/projects"), staleTime: 60_000 });
}
