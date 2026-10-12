"use client";

import { keepPreviousData, useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";

import type { AlertPage, AlertSummary, AlertView } from "@/lib/alerts/types";

import { hubFetch } from "./client";
import { withProject } from "./flow-project";
import { useIsOperator } from "./me-store";
import type { Destination, Source } from "./types";

/**
 * CB4: query của chuông / banner / trang Cảnh báo (CB3, chỉ operator). Mọi key bắt đầu bằng "alerts" — socket.ts gọi
 * lại theo prefix này khi có `alert.changed`. `enabled` = operator: người khác không bao giờ gọi `/alerts*`.
 */
export const ALERT_POLL_MS = 30_000;
/** Danh sách OPEN cho chuông + mốc "vừa đến" (một trang lớn — đủ ở quy mô đồ án; bị cắt thì `next` khác null). */
export const OPEN_FEED_LIMIT = 100;

export const alertKeys = {
  all: ["alerts"] as const,
  summary: ["alerts", "summary"] as const,
  openFeed: ["alerts", "open-feed"] as const,
  page: (query: string) => ["alerts", "page", query] as const,
};

/** Tổng cho badge chuông: gọi lại khi có `alert.changed` (socket.ts) VÀ poll 30s (cảnh báo của project khác — ADR-169). */
export function useAlertSummary() {
  const operator = useIsOperator();
  return useQuery({
    queryKey: alertKeys.summary,
    queryFn: () => hubFetch<AlertSummary>("/api/v1/alerts/summary"),
    enabled: operator,
    refetchInterval: ALERT_POLL_MS,
    refetchIntervalInBackground: false,
  });
}

/** Cảnh báo OPEN xuyên project — popover chuông + bộ nhớ "vừa đến" của banner/toast. */
export function useOpenAlertFeed() {
  const operator = useIsOperator();
  return useQuery({
    queryKey: alertKeys.openFeed,
    queryFn: () => hubFetch<AlertPage>(`/api/v1/alerts?state=OPEN&limit=${OPEN_FEED_LIMIT}`),
    enabled: operator,
    refetchInterval: ALERT_POLL_MS,
    refetchIntervalInBackground: false,
  });
}

/** Một trang của /dashboard/alerts — `query` = bộ lọc + cursor (list-url.toApiQuery). */
export function useAlertsPage(query: string) {
  const operator = useIsOperator();
  return useQuery({
    queryKey: alertKeys.page(query),
    queryFn: () => hubFetch<AlertPage>(`/api/v1/alerts${query ? `?${query}` : ""}`),
    enabled: operator,
    placeholderData: keepPreviousData,
  });
}

export function useAckAlert() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => hubFetch<{ id: string; changed: boolean }>(`/api/v1/alerts/${encodeURIComponent(id)}/ack`, { method: "POST" }),
    onSettled: () => void qc.invalidateQueries({ queryKey: alertKeys.all }),
  });
}

/** "Đánh dấu đã xem tất cả" — `asOf` = lúc mở chuông: cảnh báo đến SAU đó không bị đánh dấu oan (CB3 review L2). */
export function useAckAllAlerts() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ asOf, project }: { asOf: string; project?: string }) => {
      const p = new URLSearchParams({ asOf });
      if (project) p.set("project", project);
      return hubFetch<{ acknowledged: number }>(`/api/v1/alerts/ack-all?${p.toString()}`, { method: "POST" });
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: alertKeys.all }),
  });
}

/**
 * Tên đối tượng (đích/nguồn) của các project có cảnh báo — API cảnh báo chỉ trả `subjectId`. Key cùng hình với
 * `useDestinations(projectId)` / `useSources(projectId)` (prefix "destinations"/"sources") nên mutation ở trang Đích/Nguồn
 * làm mới luôn; cache 5 phút. Thiếu (đã xoá, project lạ) -> null, nơi hiển thị rơi về "Đích 3fa2c1d0".
 */
export function useSubjectNames(alerts: readonly Pick<AlertView, "project" | "subjectType">[] | undefined, enabled = true) {
  const operator = useIsOperator();
  const projects = [...new Set((alerts ?? []).filter((a) => a.subjectType !== "project").map((a) => a.project.id))].sort();
  const on = operator && enabled;
  const results = useQueries({
    queries: projects.flatMap((p) => [
      {
        queryKey: ["destinations", p],
        queryFn: () => hubFetch<Destination[]>(withProject("/api/v1/destinations", p)),
        enabled: on,
        staleTime: 5 * 60_000,
      },
      {
        queryKey: ["sources", p],
        queryFn: () => hubFetch<Source[]>(withProject("/api/v1/sources", p)),
        enabled: on,
        staleTime: 5 * 60_000,
      },
    ]),
  });
  const names = new Map<string, string>();
  for (const r of results) {
    for (const x of (r.data as { id: string; name: string }[] | undefined) ?? []) names.set(x.id, x.name);
  }
  return (subjectId: string): string | null => names.get(subjectId) ?? null;
}
