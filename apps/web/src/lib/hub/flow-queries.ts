"use client";

import { keepPreviousData, useInfiniteQuery, useQuery } from "@tanstack/react-query";

import { HubApiError, hubFetch } from "./client";
import type { EventFlowResponse, ExecutionFilters, ExecutionsPage, FlowTopology, TopologyWindow } from "./flow-types";

/**
 * Query Event Flow — đi qua `hubFetch` (client.ts) như mọi query khác, re-export từ queries.ts.
 * Mọi key bắt đầu bằng "flow": socket.ts invalidate prefix này khi có sự kiện realtime
 * (đã debounce) — UI gọi lại API, KHÔNG tự ghép trạng thái ở client.
 */
export const flowKeys = {
  all: ["flow"] as const,
  event: (id: string) => ["flow", "event", id] as const,
  executions: (f: ExecutionFilters) => ["flow", "executions", f] as const,
  topology: (w: TopologyWindow) => ["flow", "topology", w] as const,
};

export function useEventFlow(id: string | null) {
  return useQuery({
    queryKey: flowKeys.event(id ?? ""),
    queryFn: () =>
      hubFetch<EventFlowResponse>(`/api/v1/flow/events/${encodeURIComponent(id ?? "")}`).catch((e: unknown) => {
        if (e instanceof HubApiError && e.status === 404) return null;
        throw e;
      }),
    enabled: Boolean(id),
    placeholderData: keepPreviousData,
  });
}

export function useExecutions(filters: ExecutionFilters, opts: { paused?: boolean } = {}) {
  return useInfiniteQuery({
    queryKey: flowKeys.executions(filters),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => {
      const p = new URLSearchParams();
      for (const [k, v] of Object.entries(filters)) if (v) p.set(k, String(v));
      if (pageParam) p.set("cursor", pageParam);
      p.set("limit", "50");
      return hubFetch<ExecutionsPage>(`/api/v1/flow/executions?${p.toString()}`);
    },
    getNextPageParam: (last) => last.nextCursor,
    placeholderData: keepPreviousData,
    // Tạm dừng luồng: không refetch khi socket invalidate (dữ liệu đứng yên để đọc).
    subscribed: !opts.paused,
  });
}

export function useTopology(window: TopologyWindow) {
  return useQuery({
    queryKey: flowKeys.topology(window),
    queryFn: () => hubFetch<FlowTopology>(`/api/v1/flow/topology?window=${window}`),
    placeholderData: keepPreviousData,
    // Circuit/OPEN hết hạn không có sự kiện nào báo → làm mới định kỳ nhẹ.
    refetchInterval: 15_000,
  });
}
