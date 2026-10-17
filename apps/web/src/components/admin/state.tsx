"use client";

import type { ReactNode } from "react";

import { cn } from "cn";
import { RefreshCw } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n/use-t";

/**
 * Trạng thái rỗng / lỗi MỘT kiểu cho cả admin (ADR-246) — trang chỉ truyền chữ, không tự dựng `<p className="text-muted…">`.
 */

/**
 * Trạng thái rỗng.
 * - `icon`: phần tử icon (vd `<Inbox />`) đặt trong vòng tròn muted; `illustration`: hình vẽ riêng thay cho vòng tròn.
 * - `size="sm"`: chỗ hẹp (popover, thẻ, ô bảng) — không viền nét đứt; `md`: khoảng trống cả vùng.
 */
export function EmptyState({
  icon,
  illustration,
  title,
  description,
  action,
  size = "md",
  className,
}: {
  icon?: ReactNode;
  illustration?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  size?: "sm" | "md";
  className?: string;
}) {
  return (
    <div
      data-slot="empty-state"
      data-size={size}
      className={cn(
        "flex flex-col items-center justify-center text-center",
        size === "md" ? "gap-3 rounded-xl border border-dashed px-6 py-16" : "gap-2 px-4 py-6",
        className,
      )}
    >
      {illustration ??
        (icon && (
          <span
            aria-hidden
            className={cn(
              "flex items-center justify-center rounded-full bg-muted text-muted-foreground",
              size === "md" ? "size-12 [&_svg]:size-6" : "size-9 [&_svg]:size-4",
            )}
          >
            {icon}
          </span>
        ))}
      <div className="space-y-1">
        <p className={cn("font-medium", size === "sm" && "text-sm")}>{title}</p>
        {description && (
          <p className={cn("mx-auto max-w-sm text-muted-foreground", size === "sm" ? "text-xs" : "text-sm")}>{description}</p>
        )}
      </div>
      {action}
    </div>
  );
}

/**
 * Lỗi tải dữ liệu, dựng trên `Alert variant="destructive"` (role=alert).
 * - `message`: câu đã dịch (vd `t("page.events.load-error", { message })`); vắng → "Không tải được dữ liệu: <error.message>".
 * - `onRetry`: có thì hiện nút "Thử lại" (thường `() => void query.refetch()`).
 * - `inline`: một dòng chữ đỏ không khung — dùng trong ô/thẻ đã có khung riêng.
 */
export function ErrorState({
  error,
  message,
  onRetry,
  inline = false,
  className,
}: {
  error?: Error | null;
  message?: ReactNode;
  onRetry?: () => void;
  inline?: boolean;
  className?: string;
}) {
  const t = useT();
  const text = message ?? (error ? `${t("common.load-error")}: ${error.message}` : t("common.load-error"));
  const retry = onRetry && (
    <Button type="button" variant="outline" size="xs" onClick={onRetry}>
      <RefreshCw />
      {t("common.retry")}
    </Button>
  );
  if (inline) {
    return (
      <div data-slot="error-state" role="alert" className={cn("flex flex-wrap items-center gap-2 text-destructive text-sm", className)}>
        <span>{text}</span>
        {retry}
      </div>
    );
  }
  return (
    <Alert data-slot="error-state" variant="destructive" className={className}>
      <AlertDescription>
        <span>{text}</span>
        {retry}
      </AlertDescription>
    </Alert>
  );
}
