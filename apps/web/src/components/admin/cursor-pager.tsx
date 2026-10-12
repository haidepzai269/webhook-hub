"use client";

import { ChevronLeft, ChevronRight, ChevronsLeft } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n/use-t";

/**
 * Trước / Sau theo cursor keyset (ADR-163) — không số trang, không OFFSET: "Sau" gửi `before=next` (cũ hơn),
 * "Trước" gửi `after=prev` (mới hơn), "Mới nhất" bỏ cursor. Trang đầu = không có `prev`.
 * `loading` = trang VỪA YÊU CẦU đang tải (isPlaceholderData) — không phải mọi lần refetch nền.
 * Nút dùng `aria-disabled` (không `disabled`) để bấm liên tục bằng bàn phím không mất focus khi trang đang tải.
 */
export function CursorPager({
  next,
  prev,
  loading,
  onNext,
  onPrev,
  onNewest,
}: {
  next: string | null | undefined;
  prev: string | null | undefined;
  loading?: boolean;
  onNext: (cursor: string) => void;
  onPrev: (cursor: string) => void;
  onNewest: () => void;
}) {
  const t = useT();
  const canPrev = Boolean(prev) && !loading;
  const canNext = Boolean(next) && !loading;
  const off = "aria-disabled:pointer-events-auto aria-disabled:cursor-not-allowed aria-disabled:opacity-50";
  return (
    <nav aria-label={t("common.pager.label")} className="flex items-center gap-2 text-sm">
      <span className="text-muted-foreground text-xs" aria-live="polite">
        {prev ? t("common.pager.older") : t("common.pager.at-newest")}
        {loading ? ` · ${t("common.pager.loading")}` : ""}
      </span>
      <Button
        variant="ghost"
        size="sm"
        className={off}
        aria-disabled={!canPrev}
        onClick={() => canPrev && onNewest()}
        title={t("common.pager.newest")}
      >
        <ChevronsLeft />
        <span className="sr-only sm:not-sr-only">{t("common.pager.newest")}</span>
      </Button>
      <Button variant="outline" size="sm" className={off} aria-disabled={!canPrev} onClick={() => canPrev && prev && onPrev(prev)}>
        <ChevronLeft />
        {t("common.pager.prev")}
      </Button>
      <Button variant="outline" size="sm" className={off} aria-disabled={!canNext} onClick={() => canNext && next && onNext(next)}>
        {t("common.pager.next")}
        <ChevronRight />
      </Button>
    </nav>
  );
}
