"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { hubFetch } from "./client";
import type { ProjectSummary } from "./flow-project";
import { type ApiKeySummary, type CreatedApiKey, toSummary } from "./keys-logic";

/** SK1: route backend SẴN CÓ — `POST /api/v1/projects`, `GET/POST/DELETE /api/v1/projects/:id/keys` (id trên path). */
const keysKey = (projectId: string | null) => ["apiKeys", projectId] as const;

export function useCreateProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string; slug: string; environment: "test" | "live" }) =>
      hubFetch<ProjectSummary>("/api/v1/projects", { method: "POST", body: JSON.stringify(input) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["projects"] }),
  });
}

/**
 * PK5 khoá 1 (SPEC-provider-khac §7.1, E14, ADR-206): cờ "Nhận nguồn chưa xác thực" của project. Đọc: mọi thành viên; đổi:
 * chỉ owner (server `manage:project`, có audit `project.unverified_sources_changed`).
 */
const unverifiedKey = (projectId: string | null) => ["unverifiedSources", projectId] as const;

export function useUnverifiedSources(projectId: string | null) {
  return useQuery({
    queryKey: unverifiedKey(projectId),
    enabled: !!projectId,
    queryFn: () => hubFetch<{ allowUnverifiedSources: boolean }>(`/api/v1/projects/${encodeURIComponent(projectId ?? "")}/unverified-sources`),
  });
}

export function useSetUnverifiedSources(projectId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (allowUnverifiedSources: boolean) =>
      hubFetch<{ id: string; allowUnverifiedSources: boolean }>(`/api/v1/projects/${encodeURIComponent(projectId ?? "")}/unverified-sources`, {
        method: "PUT",
        body: JSON.stringify({ allowUnverifiedSources }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: unverifiedKey(projectId) }),
  });
}

export function useApiKeys(projectId: string | null) {
  return useQuery({
    queryKey: keysKey(projectId),
    enabled: !!projectId,
    queryFn: () => hubFetch<ApiKeySummary[]>(`/api/v1/projects/${encodeURIComponent(projectId ?? "")}/keys`),
  });
}

/** Key thô trả về cho caller (hộp "Chỉ hiện một lần"); cache chỉ nhận bản đã bỏ key (`toSummary`). */
export function useCreateApiKey(projectId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { serviceName: string; scopes: string[] }) =>
      hubFetch<CreatedApiKey>(`/api/v1/projects/${encodeURIComponent(projectId ?? "")}/keys`, {
        method: "POST",
        body: JSON.stringify(input),
      }),
    onSuccess: (k) => {
      qc.setQueryData<ApiKeySummary[]>(keysKey(projectId), (old) => [...(old ?? []), toSummary(k)]);
      void qc.invalidateQueries({ queryKey: keysKey(projectId) });
    },
  });
}

export function useRevokeApiKey(projectId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (keyId: string) =>
      hubFetch<void>(`/api/v1/projects/${encodeURIComponent(projectId ?? "")}/keys/${encodeURIComponent(keyId)}`, {
        method: "DELETE",
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keysKey(projectId) }),
  });
}
