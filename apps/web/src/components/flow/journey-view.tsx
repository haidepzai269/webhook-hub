"use client";

import type { FlowBranch, StageView } from "@hub/flow";

import { Skeleton } from "@/components/ui/skeleton";
import { useIsMobileState } from "@/hooks/use-mobile";

import { JourneyCanvas, journeyHeight, type OnStageAction } from "./journey-canvas";
import type { pipelineRoles } from "./event-notes";
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
  /** Cùng ngữ cảnh với pill/MiniPipeline của trang (`pillCtx`) — để danh sách mobile mờ đúng chặng như dải mini. */
  ctx?: Parameters<typeof pipelineRoles>[0];
}) {
  const mobile = useIsMobileState();
  if (mobile === undefined) return <Skeleton className="w-full rounded-xl" style={{ height: journeyHeight(props.branches.length) + 30 }} />;
  const { ctx, ...rest } = props;
  if (mobile) return <JourneyList {...rest} ctx={ctx} />;
  return (
    <div className="flow-canvas overflow-hidden rounded-xl border" style={{ height: journeyHeight(props.branches.length) + 30, borderColor: "var(--flow-card-border)" }}>
      <JourneyCanvas {...rest} />
    </div>
  );
}
