"use client";

import { create } from "zustand";

/**
 * AU3 (DINH-CHINH-AUTH §3): project đang xem — TOÀN dashboard (trước AU3 chỉ màn Event Flow có). Server bắt buộc
 * `?projectId=` cho mọi route `/api/v1/*` (thiếu -> 400 project_required); `hubFetch` tự gắn từ store này.
 * Nhớ trong localStorage — CHỈ id project, KHÔNG BAO GIỜ token (cookie phiên là HttpOnly).
 */
const KEY = "hub:projectId";
const LEGACY_KEY = "flow:projectId"; // F7 trước AU3

function read(): string | null {
  try {
    return localStorage.getItem(KEY) ?? localStorage.getItem(LEGACY_KEY);
  } catch {
    return null;
  }
}

export const useProjectStore = create<{ projectId: string | null; setProjectId: (id: string | null) => void }>((set) => ({
  projectId: null,
  setProjectId: (projectId) => {
    try {
      if (projectId) localStorage.setItem(KEY, projectId);
      else localStorage.removeItem(KEY);
      localStorage.removeItem(LEGACY_KEY);
    } catch {
      /* chỉ không nhớ */
    }
    set({ projectId });
  },
}));

/** Đọc lựa chọn đã nhớ — gọi trong effect (sau hydrate) để SSR và client khớp nhau. */
export function restoreProject() {
  const v = read();
  if (v && v !== useProjectStore.getState().projectId) useProjectStore.setState({ projectId: v });
}

export function currentProjectId(): string | null {
  return useProjectStore.getState().projectId;
}

/** Bỏ chọn project không còn hợp lệ (bị xoá khỏi project, đổi tài khoản): giữ nếu có trong danh sách, không thì lấy cái đầu. */
export function ensureProject(ids: string[]): string | null {
  restoreProject();
  const cur = currentProjectId();
  const next = cur && ids.includes(cur) ? cur : (ids[0] ?? null);
  if (next !== cur) useProjectStore.getState().setProjectId(next);
  return next;
}
