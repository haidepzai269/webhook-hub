"use client";

import { Badge } from "@/components/ui/badge";
import { isUnverified, type SIGNATURE_VIEW, type VerifiedFlag } from "@/lib/hub/unverified";
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

/**
 * REVIEW-PK5-R2 TB-1b: nhãn chữ ký dùng chung cho xem nhanh (event-sheet) và bước ① (trace-timeline). Trạng thái lấy từ
 * `signatureView` (đi qua isUnverified) — sự kiện chưa xác thực ra "Chưa xác thực" hổ phách, không bao giờ "Chữ ký hợp lệ".
 */
export function SignatureBadge({ view, title }: { view: (typeof SIGNATURE_VIEW)[keyof typeof SIGNATURE_VIEW]; title?: string }) {
  const t = useT();
  return (
    <Badge variant={view.variant} className={view.className || undefined} title={title}>
      {t(view.key)}
    </Badge>
  );
}
