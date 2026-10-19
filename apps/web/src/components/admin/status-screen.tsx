import type { ReactNode } from "react";

import type { LucideIcon } from "lucide-react";

/**
 * Khuôn "màn trạng thái toàn trang" kiểu 404 (ADR-261) — dùng chung cho `not-found` và màn xin lỗi của ScreenGuard để hai
 * màn cùng một ngôn ngữ thiết kế. Server-safe (không hook). `code`: dòng chữ lớn mờ phía sau minh hoạ (vd "404");
 * `children`: cụm hành động. Hoạt ảnh nhẹ chỉ chạy khi người dùng không chọn giảm chuyển động (`motion-safe`).
 */
export function StatusScreen({
  icon: Icon,
  code,
  title,
  description,
  children,
  className = "min-h-dvh",
}: {
  icon: LucideIcon;
  code?: string;
  title: string;
  description: ReactNode;
  children?: ReactNode;
  /** Chiều cao tối thiểu — toàn màn (mặc định) hoặc trừ phần thanh trên khi nằm trong layout dashboard. */
  className?: string;
}) {
  return (
    <div className={`grid place-items-center bg-background px-4 py-10 ${className}`}>
      <div className="flex w-full max-w-md flex-col items-center text-center">
        <div className="relative grid size-40 place-items-center" aria-hidden>
          {code && (
            <span className="absolute inset-0 grid place-items-center font-bold text-7xl text-muted-foreground/15 tabular-nums tracking-tighter">
              {code}
            </span>
          )}
          <span className="absolute size-36 rounded-full border border-primary/20 motion-safe:animate-pulse [animation-duration:3s]" />
          <span className="absolute size-28 rounded-full border border-primary/30" />
          <span className="relative grid size-20 place-items-center rounded-full bg-primary/10 text-primary ring-1 ring-primary/20">
            <Icon className="size-9" strokeWidth={1.5} />
          </span>
        </div>
        <h1 className="mt-6 text-balance font-semibold text-xl tracking-tight">{title}</h1>
        <div className="mt-2 text-pretty text-muted-foreground text-sm">{description}</div>
        {children && <div className="mt-6 flex w-full flex-col items-stretch gap-2 sm:w-auto sm:flex-row sm:items-center">{children}</div>}
      </div>
    </div>
  );
}
