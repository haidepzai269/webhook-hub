import { cn } from "cn"

// ADR-238: shimmer thay cho animate-pulse — dải quét ở styles/skeleton.css (tắt khi prefers-reduced-motion).
function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      aria-hidden="true"
      className={cn("skeleton-shimmer rounded-md bg-muted", className)}
      {...props}
    />
  )
}

export { Skeleton }
