"use client";

import { type RefObject, useLayoutEffect, useState } from "react";

import { FIT_INITIAL, type FitState, fitStep } from "./responsive-table-logic";

/**
 * Tự co bảng cho vừa khung, KHÔNG thanh cuộn ngang (ADR-270). Đo `[data-slot=table-container]` trong `wrapRef`:
 * tràn → `fitStep` (ẩn thêm một cột phụ, hết cột thì bóp ô) → vẽ lại → đo lại, tất cả trong layout effect nên chưa kịp
 * vẽ ra màn hình. Khung đổi bề rộng hoặc `resetKey` đổi (dữ liệu mới) → làm lại từ đầu, nhờ vậy cột tự hiện lại khi rộng ra.
 */
export function useFitColumns(wrapRef: RefObject<HTMLElement | null>, candidates: number, resetKey: unknown): FitState {
  const [state, setState] = useState<FitState>(FIT_INITIAL);

  // Dữ liệu/bộ cột đổi → đo lại từ đầu (object mới để chắc chắn vẽ lại).
  // biome-ignore lint/correctness/useExhaustiveDependencies: resetKey chỉ là tín hiệu "làm lại"
  useLayoutEffect(() => {
    setState({ ...FIT_INITIAL });
  }, [resetKey, candidates]);

  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let width = el.clientWidth;
    const ro = new ResizeObserver(() => {
      if (el.clientWidth === width) return;
      width = el.clientWidth;
      setState({ ...FIT_INITIAL });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [wrapRef]);

  // Không deps: chạy sau MỖI lần vẽ cho tới khi vừa (tối đa số cột + 1 vòng).
  useLayoutEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const target = wrap.querySelector<HTMLElement>("[data-slot=table-container]") ?? wrap;
    const next = fitStep(state, target.scrollWidth > target.clientWidth + 1, candidates);
    if (next !== state) setState(next);
  });

  return state;
}
