"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { StorageOverview, StoragePolicies, StoragePolicyView } from "@/lib/storage/storage-logic";

import { HubApiError, hubFetch } from "./client";

/**
 * QT7 (SPEC-han-muc-dung-luong §5.5, §9): query của trang Dung lượng — route `/api/v1/projects/:p/storage*` (id trên path).
 * 403 (viewer không có `storage:read`) không thử lại: banner/trang tự ẩn. Mọi key bắt đầu bằng "storage".
 */
const base = (projectId: string | null) => `/api/v1/projects/${encodeURIComponent(projectId ?? "")}/storage`;
export const storageKeys = {
  overview: (p: string | null) => ["storage", p, "overview"] as const,
  policies: (p: string | null) => ["storage", p, "policies"] as const,
  email: (p: string | null) => ["storage", p, "email"] as const,
};
const noRetry403 = (n: number, e: unknown) => !(e instanceof HubApiError && (e.status === 403 || e.status === 404)) && n < 2;

export function useStorage(projectId: string | null, opts: { poll?: boolean } = {}) {
  return useQuery({
    queryKey: storageKeys.overview(projectId),
    enabled: !!projectId,
    queryFn: () => hubFetch<StorageOverview>(base(projectId)),
    retry: noRetry403,
    // Trang Dung lượng: làm tươi khi có lệnh dọn đang chạy (lệnh chạy theo lô ở worker).
    refetchInterval: (q) =>
      opts.poll && q.state.data?.recentCleanJobs?.some((j) => j.status === "PENDING" || j.status === "RUNNING") ? 5_000 : opts.poll ? 60_000 : false,
    staleTime: 30_000,
  });
}

export function useStoragePolicies(projectId: string | null) {
  return useQuery({
    queryKey: storageKeys.policies(projectId),
    enabled: !!projectId,
    queryFn: () => hubFetch<StoragePolicies>(`${base(projectId)}/policies`),
    retry: noRetry403,
  });
}

export function useSaveStoragePolicies(projectId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (policies: Pick<StoragePolicyView, "importance" | "action" | "afterDays" | "trigger">[]) =>
      hubFetch<StoragePolicies>(`${base(projectId)}/policies`, { method: "PUT", body: JSON.stringify({ policies }) }),
    onSuccess: (saved) => qc.setQueryData(storageKeys.policies(projectId), saved),
  });
}

/** Dọn tay theo một dòng gợi ý (người dùng chọn Dọn hoặc Xoá hẳn) — 202 + lệnh; worker chạy theo lô. */
export function useCleanStorage(projectId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) => hubFetch<{ id: string; status: string }>(`${base(projectId)}/clean`, { method: "POST", body: JSON.stringify(body) }),
    onSettled: () => qc.invalidateQueries({ queryKey: ["storage", projectId] }),
  });
}

/** Áp dụng đúng gợi ý của hub (giữ nguyên hành động gợi ý) — 409 `suggestion_stale` thì tải lại bộ mới. */
export function useApplySuggestion(projectId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => hubFetch<{ id: string }>(`${base(projectId)}/suggestions/${encodeURIComponent(id)}/apply`, { method: "POST" }),
    onSettled: () => qc.invalidateQueries({ queryKey: ["storage", projectId] }),
  });
}

export function useStorageEmail(projectId: string | null) {
  return useQuery({
    queryKey: storageKeys.email(projectId),
    enabled: !!projectId,
    queryFn: () => hubFetch<{ member: boolean; warnEmail: boolean; criticalEmail: boolean; lockedEmail: boolean }>(`${base(projectId)}/email`),
    retry: noRetry403,
  });
}

export function useSaveStorageEmail(projectId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (warnEmail: boolean) =>
      hubFetch<{ member: boolean; warnEmail: boolean; criticalEmail: boolean; lockedEmail: boolean }>(`${base(projectId)}/email`, {
        method: "PUT",
        body: JSON.stringify({ warnEmail }),
      }),
    onSuccess: (saved) => qc.setQueryData(storageKeys.email(projectId), saved),
  });
}

/** Công tắc "Giữ lâu" của một source (`PATCH /api/v1/sources/:id {keepLonger}` — cần thêm `storage:write`). */
export function useSetKeepLonger() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, keepLonger }: { id: string; keepLonger: boolean }) =>
      hubFetch<{ id: string; keepLonger: boolean }>(`/api/v1/sources/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ keepLonger }) }),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["sources"] });
      void qc.invalidateQueries({ queryKey: ["storage"] });
    },
  });
}

/** Operator ghi đè hạn mức (`PUT /api/v1/projects/:id/storage-quota`) — null = về mặc định. */
export function useSetStorageQuota() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ projectId, storageQuotaMb }: { projectId: string; storageQuotaMb: number | null }) =>
      hubFetch<{ id: string; storageQuotaMb: number | null }>(`/api/v1/projects/${encodeURIComponent(projectId)}/storage-quota`, {
        method: "PUT",
        body: JSON.stringify({ storageQuotaMb }),
      }),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["projects"] });
      void qc.invalidateQueries({ queryKey: ["storage"] });
    },
  });
}
