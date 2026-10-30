"use client";

import { type MouseEvent, type RefObject, useLayoutEffect, useState } from "react";

import { FIT_INITIAL, type FitState, fitStep } from "./responsive-table-logic";

/** Khung rộng thêm ít hơn ngần này px (cỡ một thanh cuộn dọc) thì không coi là đổi bề rộng. */
export const GROW_HYSTERESIS_PX = 20;

/**
 * Tự co bảng cho vừa khung, KHÔNG thanh cuộn ngang (ADR-271). Đo `[data-slot=table-container]` trong `wrapRef`:
 * tràn → `fitStep` (ẩn thêm một cột phụ, hết cột thì bóp ô) → vẽ lại → đo lại, tất cả trong layout effect nên chưa kịp
 * vẽ ra màn hình. Khung đổi bề rộng hoặc `resetKey` đổi (dữ liệu mới) → làm lại từ đầu, nhờ vậy cột tự hiện lại khi rộng ra.
 */
export function useFitColumns(wrapRef: RefObject<HTMLElement | null>, candidates: number, ...resetKeys: readonly unknown[]): FitState {
  const [state, setState] = useState<FitState>(FIT_INITIAL);

  // Dữ liệu/bộ cột đổi → đo lại từ đầu (object mới để chắc chắn vẽ lại).
  // Số phần tử của resetKeys cố định theo từng nơi gọi (dữ liệu, trang, sắp xếp, bộ lọc) nên mảng deps không đổi độ dài.
  // biome-ignore lint/correctness/useExhaustiveDependencies: resetKeys chỉ là tín hiệu "làm lại"
  useLayoutEffect(() => {
    setState({ ...FIT_INITIAL });
  }, [...resetKeys, candidates]);

  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let width = el.clientWidth;
    const ro = new ResizeObserver(() => {
      const w = el.clientWidth;
      // Chống dao động ở ngưỡng: ẩn cột → trang ngắn lại → mất thanh cuộn dọc → khung rộng thêm vài px → cột hiện lại → tràn
      // → ẩn… Khung RỘNG THÊM dưới GROW_HYSTERESIS_PX thì bỏ qua (mốc `width` giữ nguyên nên rộng dần vẫn cộng dồn). Hẹp đi
      // thì luôn đo lại ngay.
      if (w === width || (w > width && w - width < GROW_HYSTERESIS_PX)) return;
      width = w;
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

/**
 * `onMouseEnter` cho ô bảng bị cắt bằng "…" (.fit-table td): đặt `title` = CHỮ ĐANG HIỂN THỊ của ô (textContent), chỉ khi ô
 * thật sự bị cắt. Không lấy từ `getValue()` vì giá trị cột có thể khác chữ trong ô (ghép nhiều trường, ẩn một phần).
 */
export function revealClippedText(e: MouseEvent<HTMLElement>): void {
  const td = e.currentTarget;
  if (td.title || td.scrollWidth <= td.clientWidth + 1) return;
  const text = td.textContent?.trim();
  if (text) td.title = text;
}
