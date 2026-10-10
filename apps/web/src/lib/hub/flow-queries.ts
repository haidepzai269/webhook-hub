"use client";

import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { HubApiError, hubFetch } from "./client";
import { useFlowProjectStore, withProject } from "./flow-project";
import type { EventFlowResponse, ExecutionFilters, ExecutionsPage, FlowTopology, TopologyWindow } from "./flow-types";

/**
 * Query Event Flow — đi qua `hubFetch` (client.ts) như mọi query khác, re-export từ queries.ts.
 * Mọi key bắt đầu bằng "flow": socket.ts invalidate prefix này khi có sự kiện realtime
 * (đã debounce) — UI gọi lại API, KHÔNG tự ghép trạng thái ở client.
 */
export const flowKeys = {
  all: ["flow"] as const,
  event: (id: string, p: string | null) => ["flow", "event", id, p] as const,
  executions: (f: ExecutionFilters, p: string | null) => ["flow", "executions", f, p] as const,
  topology: (w: TopologyWindow, p: string | null) => ["flow", "topology", w, p] as const,
};

export function useEventFlow(id: string | null) {
  const projectId = useFlowProjectStore((s) => s.projectId);
  return useQuery({
    queryKey: flowKeys.event(id ?? "", projectId),
    queryFn: () =>
      hubFetch<EventFlowResponse>(withProject(`/api/v1/flow/events/${encodeURIComponent(id ?? "")}`, projectId)).catch((e: unknown) => {
        if (e instanceof HubApiError && e.status === 404) return null;
        throw e;
      }),
    enabled: Boolean(id),
    placeholderData: keepPreviousData,
  });
}

export function useExecutions(filters: ExecutionFilters, opts: { paused?: boolean } = {}) {
  const projectId = useFlowProjectStore((s) => s.projectId);
  return useInfiniteQuery({
    queryKey: flowKeys.executions(filters, projectId),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => {
      const p = new URLSearchParams();
      for (const [k, v] of Object.entries(filters)) if (v) p.set(k, String(v));
      if (pageParam) p.set("cursor", pageParam);
      p.set("limit", "50");
      if (projectId) p.set("projectId", projectId);
      return hubFetch<ExecutionsPage>(`/api/v1/flow/executions?${p.toString()}`);
    },
    getNextPageParam: (last) => last.nextCursor,
    placeholderData: keepPreviousData,
    // Tạm dừng luồng: không refetch khi socket invalidate (dữ liệu đứng yên để đọc).
    subscribed: !opts.paused,
  });
}

/**
 * Replay / renormalize từ V1 trong ĐÚNG project đang xem: cùng route `/api/v1/*` của console (đi qua
 * hubFetch), chỉ thêm `?projectId=` để ProjectScopeGuard đặt tenant. Invalidate prefix "flow" + DLQ.
 */
export function useFlowReplayDelivery() {
  const qc = useQueryClient();
  const projectId = useFlowProjectStore((s) => s.projectId);
  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason?: string }) =>
      hubFetch<{ success: boolean; newDeliveryId?: string; generation?: number }>(
        withProject(`/api/v1/deliveries/${encodeURIComponent(id)}/replay`, projectId),
        { method: "POST", body: JSON.stringify(reason ? { reason } : {}) },
      ),
    onSettled: () => {
      for (const k of ["flow", "dlq", "deliveries", "overview", "audit"]) void qc.invalidateQueries({ queryKey: [k] });
    },
  });
}

export function useFlowRenormalize() {
  const qc = useQueryClient();
  const projectId = useFlowProjectStore((s) => s.projectId);
  return useMutation({
    mutationFn: (body: { reason: string; ids?: string[] }) =>
      hubFetch<{ queued: number; rawEventIds: string[] }>(withProject("/api/v1/raw-events/renormalize", projectId), {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSettled: () => {
      for (const k of ["flow", "raw-events", "events", "audit"]) void qc.invalidateQueries({ queryKey: [k] });
    },
  });
}

export function useTopology(window: TopologyWindow) {
  const projectId = useFlowProjectStore((s) => s.projectId);
  return useQuery({
    queryKey: flowKeys.topology(window, projectId),
    queryFn: () => hubFetch<FlowTopology>(withProject(`/api/v1/flow/topology?window=${window}`, projectId)),
    placeholderData: keepPreviousData,
    // Circuit/OPEN hết hạn không có sự kiện nào báo → làm mới định kỳ nhẹ.
    refetchInterval: 15_000,
  });
}
