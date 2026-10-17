import type * as React from "react";

import { cn } from "cn";
import { Search } from "lucide-react";

import { Input } from "@/components/ui/input";

/**
 * Ô tìm kiếm MỘT kiểu (ADR-247): icon kính lúp `pointer-events-none` (bấm xuyên vào ô nhập), chừa lề trái cho icon.
 * `size="sm"` cao 7 (khớp Button/SelectTrigger sm trong thanh lọc dày), mặc định cao 8.
 * `className` áp lên `<input>`; `wrapperClassName` áp lên khung bọc (đặt chiều rộng ở đây).
 */
export function SearchInput({
  size = "default",
  className,
  wrapperClassName,
  ...props
}: Omit<React.ComponentProps<typeof Input>, "size"> & { size?: "default" | "sm"; wrapperClassName?: string }) {
  const sm = size === "sm";
  return (
    <div data-slot="search-input" className={cn("relative", wrapperClassName)}>
      <Search
        aria-hidden
        className={cn(
          "pointer-events-none absolute top-1/2 -translate-y-1/2 text-muted-foreground",
          sm ? "left-2 size-3.5" : "left-2.5 size-4",
        )}
      />
      <Input className={cn(sm ? "h-7 pl-7" : "h-8 pl-8", className)} {...props} />
    </div>
  );
}
