"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { AlertPreferencesPatch, AlertPreferencesView } from "@/lib/alerts/settings-logic";

import { hubFetch } from "./client";
import { useIsOperator } from "./me-store";

/**
 * CB5 (§8.5): tuỳ chọn email cảnh báo của CHÍNH người dùng (`/api/v1/me/alert-preferences`, chỉ operator — người khác
 * không gọi). Route `/api/v1/me/*` không gắn `?projectId=` (scopeToProject, ADR-170).
 */
export const settingsKeys = { alertPrefs: ["me", "alert-preferences"] as const };

export function useAlertPreferences() {
  const operator = useIsOperator();
  return useQuery({
    queryKey: settingsKeys.alertPrefs,
    queryFn: () => hubFetch<AlertPreferencesView>("/api/v1/me/alert-preferences"),
    enabled: operator,
  });
}

/** Lưu ngay mỗi thay đổi (chỉ trường đổi). Server trả bản đã lưu -> ghi thẳng vào cache. */
export function useSaveAlertPreferences() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: AlertPreferencesPatch) =>
      hubFetch<AlertPreferencesView>("/api/v1/me/alert-preferences", { method: "PUT", body: JSON.stringify(patch) }),
    onSuccess: (saved) => qc.setQueryData(settingsKeys.alertPrefs, saved),
    onError: () => void qc.invalidateQueries({ queryKey: settingsKeys.alertPrefs }),
  });
}

export function useSendTestAlertEmail() {
  return useMutation({
    mutationFn: () =>
      hubFetch<{ sent: boolean; to: string; remaining: number }>("/api/v1/me/alert-preferences/test-email", {
        method: "POST",
      }),
  });
}
