"use client";

import { createContext, type CSSProperties, type KeyboardEvent, type ReactNode, useContext } from "react";

import Link from "next/link";

import { cn } from "cn";

import { EmptyState, ErrorState } from "@/components/admin/state";
import { Skeleton } from "@/components/ui/skeleton";
import { useT } from "@/lib/i18n/use-t";

/**
 * Danh sách dạng lưới theo thời gian thực (ADR-246) — dùng cho trang Sự kiện và ngăn Nhật ký: khác `DataTable` ở chỗ
 * KHÔNG phân trang/sắp xếp mà cuộn vô hạn, hàng có viền trái theo tone, hoạt ảnh "unroll" khi dòng mới chảy vào.
 * Component chỉ lo KHUNG: tiêu đề cột, hàng bấm được (Enter/Space/focus), trạng thái rỗng/tải/lỗi. Cuộn vô hạn
 * (sentinel), unroll, `content-visibility`, lọc… vẫn do trang truyền vào (`style`/`className` của hàng, `children`).
 *
 * - `template`: giá trị `grid-template-columns` dùng chung cho tiêu đề và mọi hàng.
 * - `density`: `md` (trang, hàng cao, viền dưới) | `sm` (ngăn log, hàng sát).
 * - `stack` (ADR-261): dưới `md` ẩn tiêu đề cột và xếp hàng thành THẺ 2 cột (nơi dùng đặt `col-span-*` cho từng ô); từ `md`
 *   trở lên là lưới `template` như cũ.
 */

type Density = "md" | "sm";
const Ctx = createContext<{ template: string; density: Density; stack: boolean }>({ template: "none", density: "md", stack: false });

const HEADER_BASE: Record<Density, string> = {
  md: "border-b bg-muted/40 px-4 py-2 font-medium text-muted-foreground text-xs",
  sm: "border-b border-l-2 border-l-transparent px-3 py-1 font-sans text-2xs text-muted-foreground uppercase tracking-wide",
};

export function GridList({
  template,
  headers,
  density = "md",
  stack = false,
  sticky = false,
  minWidth,
  headerStyle,
  loading = false,
  error,
  onRetry,
  isEmpty = false,
  emptyText,
  className,
  children,
}: {
  template: string;
  /** Nhãn từng cột; chuỗi rỗng/`null` = cột không có tiêu đề. */
  headers: ReactNode[];
  density?: Density;
  stack?: boolean;
  /** Tiêu đề dính đầu vùng cuộn (ngăn log). */
  sticky?: boolean;
  /** Hẹp hơn mức này thì cuộn ngang trong khung cha thay vì đè chữ. */
  minWidth?: number | string;
  headerStyle?: CSSProperties;
  loading?: boolean;
  error?: Error | null;
  onRetry?: () => void;
  /** Đã tải xong, không lỗi, không có hàng. */
  isEmpty?: boolean;
  emptyText?: string;
  className?: string;
  children?: ReactNode;
}) {
  const t = useT();
  return (
    <Ctx.Provider value={{ template, density, stack }}>
      <div className={className} style={minWidth ? { minWidth } : undefined}>
        <div
          className={cn("grid items-center gap-3", HEADER_BASE[density], sticky && "sticky top-0 z-[1]", stack && "max-md:hidden")}
          style={{ gridTemplateColumns: template, ...headerStyle }}
        >
          {headers.map((h, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: cột cố định, không đổi thứ tự
            <span key={i} className={density === "sm" ? "truncate" : undefined}>
              {h}
            </span>
          ))}
        </div>
        {loading && (
          <div aria-busy="true" className={cn("space-y-2", density === "md" ? "p-4" : "px-3 py-2")}>
            <span className="sr-only">{t("common.loading")}</span>
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className={density === "md" ? "h-8 w-full" : "h-5 w-full"} />
            ))}
          </div>
        )}
        {error && <ErrorState inline className={cn("font-sans", density === "md" ? "p-4" : "px-3 py-2")} error={error} onRetry={onRetry} />}
        {!loading && !error && isEmpty && <EmptyState size="sm" className={density === "sm" ? "py-3 font-sans" : "py-8"} title={emptyText ?? t("common.empty")} />}
        {children}
      </div>
    </Ctx.Provider>
  );
}

/**
 * Một hàng của `GridList`. Có `href` → thẻ liên kết (Link); không thì `role="button"` với Enter/Space + focus-visible.
 * `tone` = màu viền trái (CSS color, thường `TONE_VAR[...]`). Phím chỉ kích hoạt khi rơi đúng vào hàng — nút bên trong
 * hàng tự xử lý phím của chúng.
 */
export function GridListRow({
  tone,
  href,
  onActivate,
  className,
  style,
  children,
}: {
  tone?: string;
  href?: string;
  onActivate?: () => void;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}) {
  const { template, density, stack } = useContext(Ctx);
  const cls = cn(
    "grid items-center gap-3 border-l-2 hover:bg-muted/40 focus-visible:bg-muted/60 focus-visible:outline-none",
    stack && "max-md:grid-cols-2 max-md:gap-y-1.5 max-md:py-3 md:[grid-template-columns:var(--gl-cols)]",
    density === "md" ? "cursor-pointer border-b px-4 py-2 text-sm last:border-b-0" : "px-3 py-1",
    className,
  );
  const st: CSSProperties = { ...(stack ? { "--gl-cols": template } : { gridTemplateColumns: template }), borderLeftColor: tone, ...style } as CSSProperties;
  if (href) {
    return (
      <Link href={href} className={cls} style={st}>
        {children}
      </Link>
    );
  }
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onActivate?.();
    }
  };
  return (
    // biome-ignore lint/a11y/useSemanticElements: hàng lưới bấm được, chứa nút/liên kết con nên không thể là <button>
    <div role="button" tabIndex={0} onClick={onActivate} onKeyDown={onKeyDown} className={cls} style={st}>
      {children}
    </div>
  );
}
