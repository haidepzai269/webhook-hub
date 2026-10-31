"use client";

import { useLayoutEffect, useRef, useState } from "react";

import type { FlowBranch, StageView } from "@hub/flow";

import { Skeleton } from "@/components/ui/skeleton";
import { useIsMobileState } from "@/hooks/use-mobile";

import { JourneyCanvas, journeyHeight, journeyMinWidth, type OnStageAction } from "./journey-canvas";
import type { pipelineRoles } from "./event-notes";
import { JourneyList } from "./journey-list";

/**
 * Hành trình một event (ADR-261): từ `md` là canvas @xyflow, dưới `md` là danh sách dọc cùng dữ liệu. ADR-271: khung (không phải viewport)
 * quá hẹp để canvas fit ở zoom đọc được (`journeyMinWidth`) cũng dùng danh sách — không thu nhỏ chữ xuống ~4px. Render CÓ ĐIỀU KIỆN
 * (không dựng canvas ẩn trên điện thoại); chưa đo được viewport thì chỉ vẽ khung chờ cao bằng canvas — không nháy.
 */
export function JourneyView(props: {
  stages: StageView[];
  branches: FlowBranch[];
  provider?: string;
  selectedId: string | null;
  onSelect: (s: StageView, b?: FlowBranch) => void;
  onAction: OnStageAction;
  /** deliveryId đang Phát lại — canvas và danh sách khoá nút của nhánh đó (`doReplay` còn chặn gọi trùng bằng ref). */
  replaying?: string | null;
  /** Cùng ngữ cảnh với pill/MiniPipeline của trang (`pillCtx`) — để danh sách mobile mờ đúng chặng như dải mini. */
  ctx?: Parameters<typeof pipelineRoles>[0];
}) {
  const mobile = useIsMobileState();
  const hostRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    setWidth(el.clientWidth);
    let cur = el.clientWidth;
    const minWidth = journeyMinWidth(props.stages.length);
    const ro = new ResizeObserver(() => {
      const w = el.clientWidth;
      if (w === cur) return;
      const isNarrow = cur < minWidth;
      const shouldBeNarrow = isNarrow ? w < minWidth + 16 : w < minWidth;
      if (isNarrow !== shouldBeNarrow || Math.abs(w - cur) >= 16) {
        cur = w;
        setWidth(w);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [props.stages.length]);
  const { ctx, replaying, ...rest } = props;
  const tooNarrow = width !== null && width < journeyMinWidth(props.stages.length);
  let body: React.ReactNode;
  if (mobile === undefined || width === null) {
    body = <Skeleton className="w-full rounded-xl" style={{ height: journeyHeight(props.branches.length) + 30 }} />;
  } else if (mobile || tooNarrow) {
    body = <JourneyList {...rest} ctx={ctx} replaying={replaying} />;
  } else {
    body = (
      <div className="flow-canvas overflow-hidden rounded-xl border" style={{ height: journeyHeight(props.branches.length) + 30, borderColor: "var(--flow-card-border)" }}>
        <JourneyCanvas {...rest} replaying={replaying} />
      </div>
    );
  }
  return <div ref={hostRef}>{body}</div>;
}
