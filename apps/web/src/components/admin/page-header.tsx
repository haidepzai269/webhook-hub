import type { ReactNode } from "react";

import { cn } from "cn";
import { ArrowLeft } from "lucide-react";
import Link from "next/link";

import { ICON } from "@/components/admin/icon";

/**
 * Đầu trang MỘT kiểu (ADR-247). `back`: liên kết "← quay lại" phía trên tiêu đề (trang chi tiết); `adornment`: huy hiệu/pill
 * ngay cạnh h1 (trạng thái, cảnh báo chưa xác thực…); `meta`: dòng phụ dưới tiêu đề (mã định danh + nút chép…);
 * `description`: câu mô tả; `actions`: cụm nút bên phải. `className` để bỏ lề dưới khi cha đã `space-y-*`.
 */
export function PageHeader({
  title,
  description,
  actions,
  back,
  adornment,
  meta,
  className,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  back?: { href: string; label: string };
  adornment?: ReactNode;
  meta?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("mb-4 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between", className)}>
      <div className="min-w-0 space-y-1">
        {back && (
          <Link href={back.href} className="inline-flex items-center gap-1 text-muted-foreground text-sm hover:text-foreground">
            <ArrowLeft {...ICON} aria-hidden /> {back.label}
          </Link>
        )}
        {adornment ? (
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="font-semibold text-xl tracking-tight">{title}</h1>
            {adornment}
          </div>
        ) : (
          <h1 className="font-semibold text-xl tracking-tight">{title}</h1>
        )}
        {meta && <div className="flex items-center gap-1 text-muted-foreground text-xs">{meta}</div>}
        {description && <p className="text-muted-foreground text-sm">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
