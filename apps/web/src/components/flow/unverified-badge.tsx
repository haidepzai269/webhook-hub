"use client";

import { Badge } from "@/components/ui/badge";
import { isUnverified, type VerifiedFlag } from "@/lib/hub/unverified";
import { useT } from "@/lib/i18n/use-t";

/**
 * PK5 khoá 2 (ADR-206, REVIEW-PK5 TB-1): nhãn "Chưa xác thực" ở MỌI nơi hiện sự kiện (danh sách, chi tiết, hành trình,
 * lượt giao). Màu cảnh báo (hổ phách), không bao giờ xanh. Không phải sự kiện chưa xác thực -> không vẽ gì.
 */
export function UnverifiedBadge({ of, className }: { of: VerifiedFlag | null | undefined; className?: string }) {
  const t = useT();
  if (!isUnverified(of)) return null;
  return (
    <Badge
      variant="outline"
      title={t("page.events.unverified-hint")}
      className={`shrink-0 border-amber-500/50 text-[10px] text-amber-700 dark:text-amber-400 ${className ?? ""}`}
    >
      {t("page.events.unverified")}
    </Badge>
  );
}
