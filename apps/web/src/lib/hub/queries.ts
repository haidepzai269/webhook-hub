"use client";

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { HUB_API_URL } from "@/lib/env";

import { HubApiError, hubFetch } from "./client";
import type {
  AuditLogsPage,
  Delivery,
  DeliveryStatus,
  Destination,
  EventsPage,
  Health,
  HubEventDetail,
  OrphanRawEventsPage,
  Overview,
  ReplayBulkFilter,
  ReplayBulkResult,
  Source,
  Subscription,
  TimeseriesBucket,
  TimeseriesRange,
} from "./types";
import { withProject } from "./flow-project";
import { keysAfterAudited } from "./ui-logic";

// Event Flow (SPEC-event-flow-ui): query ở file riêng để giảm xung đột merge, vẫn xuất qua queries.ts.
export * from "./flow-queries";
export * from "./flow-project";

/** Invalidate các key + LUÔN cả ["audit"] — dùng cho mọi mutation có ghi audit_logs (ADR-054). */
function invalidateAudited(qc: ReturnType<typeof useQueryClient>, ...keys: (readonly unknown[])[]) {
  for (const key of keysAfterAudited(...keys)) void qc.invalidateQueries({ queryKey: key });
}

/** Một chỗ duy nhất định nghĩa query key — socket.ts invalidate theo đúng các prefix này. */
export const hubKeys = {
  overview: ["overview"] as const,
  timeseries: (range: TimeseriesRange) => ["timeseries", range] as const,
  events: (before?: string, limit?: number) => ["events", before ?? null, limit ?? null] as const,
  event: (id: string) => ["event", id] as const,
  deliveries: (status?: DeliveryStatus) => ["deliveries", status ?? "ALL"] as const,
  dlq: ["dlq"] as const,
  sources: ["sources"] as const,
  destinations: ["destinations"] as const,
  subscriptions: ["subscriptions"] as const,
  health: ["health"] as const,
  audit: (before?: string) => ["audit", before ?? null] as const,
};

export function useOverview() {
  return useQuery({ queryKey: hubKeys.overview, queryFn: () => hubFetch<Overview>("/api/v1/overview") });
}

export function useTimeseries(range: TimeseriesRange) {
  return useQuery({
    queryKey: hubKeys.timeseries(range),
    queryFn: () => hubFetch<TimeseriesBucket[]>(`/api/v1/stats/timeseries?range=${range}`),
    placeholderData: keepPreviousData,
  });
}

/** Trang cũ hơn theo `before` (id event cuối trang trước). S7: `after` của API giờ là seq tăng dần (ADR-077). */
export function useEvents(before: string | undefined, limit: number) {
  const params = new URLSearchParams({ limit: String(limit) });
  if (before) params.set("before", before);
  return useQuery({
    queryKey: hubKeys.events(before, limit),
    queryFn: () => hubFetch<EventsPage>(`/api/v1/events?${params.toString()}`),
    placeholderData: keepPreviousData,
  });
}

export function useEventDetail(id: string | null) {
  return useQuery({
    queryKey: hubKeys.event(id ?? ""),
    // 404 (không tồn tại / tenant khác) là trạng thái hợp lệ để hiển thị, không phải lỗi.
    queryFn: () =>
      hubFetch<HubEventDetail>(`/api/v1/events/${encodeURIComponent(id ?? "")}`).catch((e: unknown) => {
        if (e instanceof HubApiError && e.status === 404) return null;
        throw e;
      }),
    enabled: Boolean(id),
  });
}

export function useDeliveries(status?: DeliveryStatus) {
  return useQuery({
    queryKey: hubKeys.deliveries(status),
    queryFn: () => hubFetch<Delivery[]>(`/api/v1/deliveries${status ? `?status=${status}` : ""}`),
    placeholderData: keepPreviousData,
  });
}

export function useDlq() {
  return useQuery({ queryKey: hubKeys.dlq, queryFn: () => hubFetch<Delivery[]>("/api/v1/dlq") });
}

/**
 * `projectId` (tuỳ chọn, R-4): gửi `?projectId=` — server đọc ở ProjectScopeGuard (X2). Không truyền = project
 * của JWT (default), như mọi trang cấu hình hiện có. Key vẫn bắt đầu bằng "sources"/"destinations" nên
 * invalidate theo prefix sau mutation vẫn đúng.
 */
export function useSources(projectId: string | null = null) {
  return useQuery({
    queryKey: [...hubKeys.sources, projectId],
    queryFn: () => hubFetch<Source[]>(withProject("/api/v1/sources", projectId)),
  });
}

export function useDestinations(projectId: string | null = null) {
  return useQuery({
    queryKey: [...hubKeys.destinations, projectId],
    queryFn: () => hubFetch<Destination[]>(withProject("/api/v1/destinations", projectId)),
  });
}

export function useSubscriptions() {
  return useQuery({
    queryKey: hubKeys.subscriptions,
    queryFn: () => hubFetch<Subscription[]>("/api/v1/subscriptions"),
  });
}

/**
 * `/health` trả 503 kèm JSON khi một dependency chết — vẫn là dữ liệu hợp lệ để hiển thị,
 * nên không đi qua hubFetch (sẽ ném lỗi). Mất kết nối hẳn → "offline".
 */
export function useHealth() {
  return useQuery({
    queryKey: hubKeys.health,
    queryFn: async (): Promise<Health> => {
      try {
        const res = await fetch(`${HUB_API_URL}/health`, { cache: "no-store" });
        return (await res.json()) as Health;
      } catch {
        return { status: "offline" };
      }
    },
    refetchInterval: 15_000,
    staleTime: 0,
  });
}

interface ReplayResult {
  success: boolean;
  message?: string;
  newDeliveryId?: string;
  generation?: number;
}

export function useReplayDelivery() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason?: string }) =>
      hubFetch<ReplayResult>(`/api/v1/deliveries/${encodeURIComponent(id)}/replay`, {
        method: "POST",
        body: JSON.stringify(reason ? { reason } : {}),
      }),
    // onSettled, không phải onSuccess: 409 (đã được replay ở tab khác) cũng nghĩa là DLQ đang cũ.
    onSettled: () => invalidateAudited(qc, hubKeys.dlq, hubKeys.overview, ["deliveries"], ["timeseries"]),
  });
}

/** S2-3: replay hàng loạt. `dryRun: true` chỉ đếm + mẫu, không ghi gì. */
export function useReplayBulk() {
  const qc = useQueryClient();
  return useMutation({
    // dryRun BẮT BUỘC (server trả 400 nếu thiếu/không phải boolean — ADR-054).
    mutationFn: (body: ReplayBulkFilter & { reason: string; dryRun: boolean }) =>
      hubFetch<ReplayBulkResult>("/api/v1/deliveries/replay-bulk", { method: "POST", body: JSON.stringify(body) }),
    onSettled: (res) => {
      if (res?.dryRun) return;
      invalidateAudited(qc, hubKeys.dlq, hubKeys.overview, ["deliveries"], ["timeseries"]);
    },
  });
}

/** S2-3: audit log, phân trang lùi theo `before` (id nhỏ nhất của trang trước). */
export function useAuditLogs(before?: string, limit = 50) {
  const params = new URLSearchParams({ limit: String(limit) });
  if (before) params.set("before", before);
  return useQuery({
    queryKey: hubKeys.audit(before),
    queryFn: () => hubFetch<AuditLogsPage>(`/api/v1/audit-logs?${params.toString()}`),
    placeholderData: keepPreviousData,
  });
}

export function useCreateSource() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { provider: string; name: string; secret: string }) =>
      hubFetch<Source>("/api/v1/sources", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => invalidateAudited(qc, hubKeys.sources),
  });
}

export function useCreateDestination() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      name: string;
      type: string;
      config: Record<string, unknown>;
      signingSecret?: string;
      rateLimitRps: number;
    }) => hubFetch<Destination>("/api/v1/destinations", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => invalidateAudited(qc, hubKeys.destinations),
  });
}

export function useCreateSubscription() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { destinationId: string; name: string; eventTypes: string[]; template?: string }) =>
      hubFetch<Subscription>("/api/v1/subscriptions", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => invalidateAudited(qc, hubKeys.subscriptions),
  });
}

/** Bật/tắt subscription — cách ĐÚNG để ngừng gửi mà giữ lịch sử (ADR-054). */
export function useSetSubscriptionActive() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, isActive }: { id: string; isActive: boolean }) =>
      hubFetch<Subscription>(`/api/v1/subscriptions/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify({ isActive }),
      }),
    onSettled: () => invalidateAudited(qc, hubKeys.subscriptions),
  });
}

/** Xoá subscription — 409 (kèm deliveryCount) nếu còn lịch sử gửi; UI gợi ý "Tắt" thay vì xoá. */
export function useDeleteSubscription() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      hubFetch<{ deleted: true; id: string }>(`/api/v1/subscriptions/${encodeURIComponent(id)}`, { method: "DELETE" }),
    onSettled: () => invalidateAudited(qc, hubKeys.subscriptions),
  });
}

/** Xoá đích — 409 nếu còn subscription trỏ vào (ADR-054). */
export function useDeleteDestination() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      hubFetch<{ deleted: true; id: string }>(`/api/v1/destinations/${encodeURIComponent(id)}`, { method: "DELETE" }),
    onSettled: () => invalidateAudited(qc, hubKeys.destinations, hubKeys.subscriptions),
  });
}

// --- Raw event mồ côi (S1-3) ---

export const orphanRawEventsKey = ["raw-events", "orphans"] as const;

export function useOrphanRawEvents() {
  return useQuery({
    queryKey: orphanRawEventsKey,
    queryFn: () => hubFetch<OrphanRawEventsPage>("/api/v1/raw-events/orphans"),
    refetchInterval: 60_000,
  });
}

export function useRenormalizeRawEvents() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { reason: string; ids?: string[] }) =>
      hubFetch<{ queued: number; rawEventIds: string[] }>("/api/v1/raw-events/renormalize", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    // Có ghi audit (raw_event.renormalize) -> làm mới cả ["audit"] (review SPEC-2 #8).
    onSettled: () => invalidateAudited(qc, orphanRawEventsKey, ["events"], hubKeys.overview),
  });
}
