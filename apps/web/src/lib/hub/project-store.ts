"use client";

import { create } from "zustand";

/**
 * AU3 (DINH-CHINH-AUTH §3): project đang xem — TOÀN dashboard. Server bắt buộc `?projectId=` cho mọi route `/api/v1/*`
 * (thiếu -> 400 project_required); `hubFetch` tự gắn từ store này. Nhớ trong localStorage — CHỈ id project, KHÔNG BAO GIỜ
 * token (cookie phiên là HttpOnly).
 *
 * Sửa lỗi "stale project" (2026-10-12): lựa chọn nhớ THEO USER (`hub:projectId:<userId>`), xoá khi đăng xuất; mặc định là
 * project mình LÀ THÀNH VIÊN (operator thấy mọi project nhưng không tự rơi vào project của người khác).
 */
const KEY_PREFIX = "hub:projectId:";
const LEGACY_KEYS = ["hub:projectId", "flow:projectId"]; // trước bản sửa: một khoá chung cho mọi user trên trình duyệt

const keyOf = (userId: string) => `${KEY_PREFIX}${userId}`;
function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

interface ProjectState {
  userId: string | null;
  projectId: string | null;
  setProjectId: (id: string | null) => void;
}

export const useProjectStore = create<ProjectState>((set, get) => ({
  userId: null,
  projectId: null,
  setProjectId: (projectId) => {
    const s = storage();
    const uid = get().userId;
    try {
      if (s && uid) {
        if (projectId) s.setItem(keyOf(uid), projectId);
        else s.removeItem(keyOf(uid));
      }
    } catch {
      /* chỉ không nhớ */
    }
    set({ projectId });
  },
}));

/** Đọc lựa chọn đã nhớ CỦA USER hiện tại — gọi trong effect (sau hydrate). Chưa biết user -> không làm gì. */
export function restoreProject() {
  const uid = useProjectStore.getState().userId;
  if (!uid) return;
  let v: string | null = null;
  try {
    v = storage()?.getItem(keyOf(uid)) ?? null;
  } catch {
    /* bỏ qua */
  }
  if (v && v !== useProjectStore.getState().projectId) useProjectStore.setState({ projectId: v });
}

export function currentProjectId(): string | null {
  return useProjectStore.getState().projectId;
}

export interface ProjectChoice {
  id: string;
  /** false = operator xem project mình không là thành viên. Thiếu = coi như thành viên (server cũ). */
  member?: boolean;
}

/**
 * Chọn project khi vào dashboard: lựa chọn đã nhớ của CHÍNH user này nếu còn trong danh sách; không thì project đầu tiên
 * mình là thành viên (project tự tạo lúc đăng ký / `default` của operator); không có membership nào thì cái đầu.
 */
export function ensureProject(projects: ProjectChoice[], userId: string): string | null {
  const s = storage();
  try {
    for (const k of LEGACY_KEYS) s?.removeItem(k);
  } catch {
    /* bỏ qua */
  }
  if (useProjectStore.getState().userId !== userId) useProjectStore.setState({ userId, projectId: null });
  restoreProject();
  const cur = currentProjectId();
  const ids = projects.map((p) => p.id);
  const next = cur && ids.includes(cur) ? cur : ((projects.find((p) => p.member !== false) ?? projects[0])?.id ?? null);
  if (next !== cur) useProjectStore.getState().setProjectId(next);
  return next;
}

/** Đăng xuất: quên lựa chọn (bộ nhớ + localStorage của user này + khoá chung cũ) — user sau không thừa hưởng. */
export function clearProjectSelection() {
  const s = storage();
  const uid = useProjectStore.getState().userId;
  try {
    if (uid) s?.removeItem(keyOf(uid));
    for (const k of LEGACY_KEYS) s?.removeItem(k);
  } catch {
    /* bỏ qua */
  }
  useProjectStore.setState({ userId: null, projectId: null });
}
