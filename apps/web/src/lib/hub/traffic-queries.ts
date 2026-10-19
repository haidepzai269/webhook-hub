"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";

import { type TrafficRange, type TrafficView } from "@/lib/traffic/message";

import { HubApiError, hubFetch } from "./client";
import { canScope } from "./effective-role";
import { useMeStore } from "./me-store";
import { useProjectStore } from "./project-store";

/** Số liệu được ghi theo lô 60 giây — làm mới mỗi phút là đủ. */
export const TRAFFIC_REFRESH_MS = 60_000;

/**
 * EG5 (SPEC-chong-qua-tai §6.3): `GET /api/v1/projects/:p/sources/:id/traffic?range=` — chỉ owner + người vận hành
 * (scope `traffic:read`); 403 không thử lại (khối hiện câu giải thích).
 */
export function useSourceTraffic(sourceId: string | null, range: TrafficRange) {
  const projectId = useProjectStore((s) => s.projectId);
  return useQuery({
    queryKey: ["source-traffic", projectId, sourceId, range] as const,
    enabled: !!projectId && !!sourceId,
    queryFn: () =>
      hubFetch<TrafficView>(
        `/api/v1/projects/${encodeURIComponent(projectId ?? "")}/sources/${encodeURIComponent(sourceId ?? "")}/traffic?range=${range}`,
      ),
    placeholderData: keepPreviousData,
    retry: (n, e) => !(e instanceof HubApiError && (e.status === 403 || e.status === 404)) && n < 2,
    refetchInterval: TRAFFIC_REFRESH_MS,
    refetchIntervalInBackground: false,
  });
}

/** Người đang xem có `traffic:read` trên project đang chọn? (owner hoặc người vận hành — khớp ROLE_SCOPES của server) */
export function useCanViewTraffic(): boolean {
  const projectId = useProjectStore((s) => s.projectId);
  return useMeStore((s) => canScope(s.me, projectId, "traffic:read"));
}
