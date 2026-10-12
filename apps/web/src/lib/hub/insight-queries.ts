"use client";

import { useQuery } from "@tanstack/react-query";

import type { InsightCode, InsightView } from "@/lib/insights/message";

import { hubFetch } from "./client";
import { useProjectStore } from "./project-store";

/** Nhận định đổi theo phút (cửa sổ 1 giờ / hôm nay / 7 ngày) — làm mới mỗi phút là đủ, không cần socket. */
export const INSIGHT_REFRESH_MS = 60_000;

/**
 * CB6 (SPEC §7): MỘT lời gọi mỗi trang — `codes` là các nhận định trang đó hiện (Tổng quan: I-dup,I-dead; Đích: I-dest;
 * Nguồn: I-silent). Route mang project trên path (`/api/v1/projects/:id/insights`), mọi thành viên đọc được project.
 */
export function useInsights(codes: InsightCode[]) {
  const projectId = useProjectStore((s) => s.projectId);
  const list = codes.join(",");
  return useQuery({
    queryKey: ["insights", projectId, list] as const,
    enabled: !!projectId,
    queryFn: () =>
      hubFetch<InsightView[]>(
        `/api/v1/projects/${encodeURIComponent(projectId ?? "")}/insights?codes=${encodeURIComponent(list)}`,
      ),
    refetchInterval: INSIGHT_REFRESH_MS,
    refetchIntervalInBackground: false,
  });
}
