import { cn } from "cn";
import { LoaderCircle } from "lucide-react";

const SIZE = { auto: "", sm: "size-3.5", md: "size-4", lg: "size-6" } as const;

/**
 * Vòng quay chờ MỘT kiểu (ADR-247) — thay `Loader2`/`LoaderCircle` + `animate-spin` rải rác. Giảm chuyển động đã tắt
 * `animate-spin` ở globals.css. `size="auto"` để cha tự đặt cỡ (vd. svg trong Button theo size của nút).
 * Có `label` thì là `role="status"` đọc được; không thì chỉ trang trí (`aria-hidden`).
 */
export function Spinner({
  size = "md",
  label,
  className,
}: {
  size?: keyof typeof SIZE;
  label?: string;
  className?: string;
}) {
  return (
    <LoaderCircle
      className={cn("shrink-0 animate-spin", SIZE[size], className)}
      {...(label ? { role: "status", "aria-label": label } : { "aria-hidden": true })}
    />
  );
}
