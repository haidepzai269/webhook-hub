"use client";

import type { FlowBranch, StageView } from "@hub/flow";

import { Skeleton } from "@/components/ui/skeleton";
import { useIsMobileState } from "@/hooks/use-mobile";

import { JourneyCanvas, journeyHeight, type OnStageAction } from "./journey-canvas";
import { JourneyList } from "./journey-list";

/**
 * Hành trình một event (ADR-261): từ `md` là canvas @xyflow, dưới `md` là danh sách dọc cùng dữ liệu. Render CÓ ĐIỀU KIỆN
 * (không dựng canvas ẩn trên điện thoại); chưa đo được viewport thì chỉ vẽ khung chờ cao bằng canvas — không nháy.
 */
export function JourneyView(props: {
  stages: StageView[];
  branches: FlowBranch[];
  provider?: string;
  selectedId: string | null;
  onSelect: (s: StageView, b?: FlowBranch) => void;
  onAction: OnStageAction;
}) {
  const mobile = useIsMobileState();
  if (mobile === undefined) return <Skeleton className="w-full rounded-xl" style={{ height: journeyHeight(props.branches.length) + 30 }} />;
  if (mobile) return <JourneyList {...props} />;
  return (
    <div className="flow-canvas overflow-hidden rounded-xl border" style={{ height: journeyHeight(props.branches.length) + 30, borderColor: "var(--flow-card-border)" }}>
      <JourneyCanvas {...props} />
    </div>
  );
}
