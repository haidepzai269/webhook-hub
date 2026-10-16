"use client";

import { type QueryClient, keepPreviousData, useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";

import type { AlertPage, AlertSummary, AlertView } from "@/lib/alerts/types";

import { hubFetch } from "./client";
import { withProject } from "./flow-project";
import { useCanSeeAlerts, useIsOperator } from "./me-store";
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
  const operator = useCanSeeAlerts(); // QT6: operator hoặc owner (server lọc theo quyền)
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
  const operator = useCanSeeAlerts(); // QT6: operator hoặc owner (server lọc theo quyền)
  return useQuery({
    queryKey: alertKeys.openFeed,
    queryFn: () => hubFetch<AlertPage>(`/api/v1/alerts?state=OPEN&limit=${OPEN_FEED_LIMIT}`),
    enabled: operator,
    refetchInterval: ALERT_POLL_MS,
    refetchIntervalInBackground: false,
  });
}

/** Một trang của /alerts (tầng tài khoản, ADR-237) — `query` = bộ lọc + cursor (list-url.toApiQuery). */
export function useAlertsPage(query: string) {
  const operator = useCanSeeAlerts(); // QT6: operator hoặc owner (server lọc theo quyền)
  return useQuery({
    queryKey: alertKeys.page(query),
    queryFn: () => hubFetch<AlertPage>(`/api/v1/alerts${query ? `?${query}` : ""}`),
    enabled: operator,
    placeholderData: keepPreviousData,
    // Như chuông: poll để cảnh báo project KHÁC (không có alert.changed) cũng hiện mà không cần tải lại trang.
    refetchInterval: ALERT_POLL_MS,
  });
}

export function useAckAlert() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => hubFetch<{ id: string; changed: boolean }>(`/api/v1/alerts/${encodeURIComponent(id)}/ack`, { method: "POST" }),
    onSettled: () => void qc.invalidateQueries({ queryKey: alertKeys.all }),
  });
}

/**
 * "Đánh dấu đã xem tất cả" — gửi ĐÚNG id các cảnh báo chưa xem đang hiện trong chuông (re-review CB4): server chỉ đánh
 * dấu những id đó, cảnh báo đến sau (kể cả cùng `opened_at` của lượt đánh giá) không bị đánh dấu oan.
 */
export function useAckAllAlerts() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (ids: string[]) =>
      hubFetch<{ acknowledged: number }>("/api/v1/alerts/ack-all", { method: "POST", body: JSON.stringify({ ids }) }),
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
  return useQueries({
    queries: projects.flatMap((p) => subjectNameQueries(p).map((q) => ({ ...q, enabled: on }))),
    combine: combineNames,
  });
}

const SUBJECT_NAME_STALE_MS = 5 * 60_000;

/** Hai query tên (đích + nguồn) của một project — dùng chung cho hook và cho `loadSubjectNames` (cùng key, cùng cache). */
type NamedRow = { id: string; name: string };
function subjectNameQueries(projectId: string): { queryKey: string[]; queryFn: () => Promise<NamedRow[]>; staleTime: number }[] {
  return [
    {
      queryKey: ["destinations", projectId],
      queryFn: () => hubFetch<Destination[]>(withProject("/api/v1/destinations", projectId)),
      staleTime: SUBJECT_NAME_STALE_MS,
    },
    {
      queryKey: ["sources", projectId],
      queryFn: () => hubFetch<Source[]>(withProject("/api/v1/sources", projectId)),
      staleTime: SUBJECT_NAME_STALE_MS,
    },
  ];
}

/**
 * Tải (hoặc lấy từ cache) tên đích/nguồn của MỘT project ngay lúc cần — toast cảnh báo của project khác chờ cái này
 * (có hạn, `resolveSubjectName`) thay vì hiện "Đích 1cc4de59" khi `useSubjectNames` chưa kịp tải.
 */
export async function loadSubjectNames(qc: QueryClient, projectId: string): Promise<(subjectId: string) => string | null> {
  const results = await Promise.all(
    subjectNameQueries(projectId).map((q) => qc.fetchQuery(q).then((data) => ({ data }), () => ({ data: undefined }))),
  );
  return combineNames(results);
}

/**
 * Review L7: `combine` ở mức module (danh tính ổn định) — TanStack chỉ chạy lại khi dữ liệu đổi, nên hàm tra tên giữ
 * nguyên danh tính giữa các lần vẽ (useMemo/useEffect phía dùng không chạy lại vô ích).
 */
function combineNames(results: { data?: unknown }[]): (subjectId: string) => string | null {
  const names = new Map<string, string>();
  for (const r of results) {
    for (const x of (r.data as { id: string; name: string }[] | undefined) ?? []) names.set(x.id, x.name);
  }
  return (subjectId) => names.get(subjectId) ?? null;
}
