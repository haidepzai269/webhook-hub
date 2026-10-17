"use client";

import { cn } from "cn";
import { useCallback, useRef, useState, type ReactNode } from "react";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * CellTooltip — xem đủ nội dung của ô bảng bị truncate (ADR-244).
 *
 * - Dựng trên Tooltip Radix (`ui/tooltip.tsx`): nội dung đi qua Portal nên không bị `overflow-hidden`
 *   của ô/khung cắt, và Radix tự né mép viewport (collision) — không clamp `transform` thủ công.
 * - Controlled: chỉ cho mở khi phần tử `[data-cell-text]` bên trong thật sự bị cắt
 *   (scrollWidth > clientWidth). Không có `[data-cell-text]` thì đo chính wrapper.
 * - `always`: luôn mở khi hover — dùng khi tooltip là thông tin THÊM (vd `reason.message` ở "Hỏng ở"),
 *   không phải chữ bị cắt.
 * - TooltipProvider đã bọc ở `app/(admin)/layout.tsx` — mọi nơi dùng CellTooltip đều nằm trong đó.
 */
export function CellTooltip({
  text,
  children,
  always = false,
  className,
}: {
  /** Nội dung tooltip. Rỗng/undefined → không bao giờ mở, chỉ render children. */
  text?: string | null;
  /** Nội dung ô — thường chứa một `<span data-cell-text className="truncate">`. */
  children: ReactNode;
  /** Mở kể cả khi chữ không bị truncate. */
  always?: boolean;
  /** Class cho span wrapper (vd `flex` khi cần chiếm cả dòng). */
  className?: string;
}) {
  const wrapRef = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);

  const onOpenChange = useCallback(
    (next: boolean) => {
      if (!next) return setOpen(false);
      if (always) return setOpen(true);
      const el = wrapRef.current;
      if (!el) return;
      const inner = el.querySelector<HTMLElement>("[data-cell-text]") ?? el;
      // +1: làm tròn subpixel khiến scrollWidth lớn hơn clientWidth 1px dù không cắt.
      if (inner.scrollWidth > inner.clientWidth + 1) setOpen(true);
    },
    [always],
  );

  const wrapper = (
    <span ref={wrapRef} className={cn("inline-flex min-w-0 max-w-full", className)}>
      {children}
    </span>
  );

  if (!text) return wrapper;

  return (
    <Tooltip open={open} onOpenChange={onOpenChange} delayDuration={300}>
      <TooltipTrigger asChild>{wrapper}</TooltipTrigger>
      <TooltipContent sideOffset={6} collisionPadding={8} className="block max-w-80 whitespace-pre-wrap break-words">
        {text}
      </TooltipContent>
    </Tooltip>
  );
}
