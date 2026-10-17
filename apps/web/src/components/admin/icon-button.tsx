"use client";

import type { ComponentProps, ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

type ButtonProps = ComponentProps<typeof Button>;

export interface IconButtonProps extends Omit<ButtonProps, "children" | "title" | "aria-label" | "size"> {
  /** Nhãn đọc cho trình đọc màn hình (`aria-label`); cũng là nội dung tooltip nếu không có `tooltip`. */
  label: string;
  /** Nội dung tooltip khác nhãn (vd nhãn aria có tên dòng, tooltip chỉ nói hành động). Thay `title=` trần. */
  tooltip?: string;
  /** Icon (lucide) — nút chỉ có icon. */
  icon: ReactNode;
  size?: "icon" | "icon-xs" | "icon-sm" | "icon-lg";
  tooltipSide?: ComponentProps<typeof TooltipContent>["side"];
}

/** Nút chỉ có icon: Button + Tooltip + aria-label. TooltipProvider gốc đã bọc ở layout admin. */
export function IconButton({ label, tooltip, icon, size = "icon-sm", variant = "ghost", tooltipSide, type = "button", ...props }: IconButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button type={type} variant={variant} size={size} aria-label={label} {...props}>
          {icon}
        </Button>
      </TooltipTrigger>
      <TooltipContent side={tooltipSide}>{tooltip ?? label}</TooltipContent>
    </Tooltip>
  );
}
