import { Skeleton } from "@/components/ui/skeleton";
import { TableCell, TableRow } from "@/components/ui/table";

/**
 * ADR-238 — khung chờ ghép từ <Skeleton> theo HÌNH của thành phần thật (cùng chiều cao -> không nhảy bố cục khi dữ liệu
 * về). Không dùng hook — dùng được cả ở server component (`loading.tsx`).
 */

const WIDTHS = [80, 55, 70, 40, 65] as const;

/** Các dòng chờ cho `<Table>` tự dựng (không qua DataTable): mỗi ô một thanh, độ rộng lệch nhau như chữ thật. */
export function TableRowsSkeleton({ cols, rows = 4 }: { cols: number; rows?: number }) {
  return Array.from({ length: rows }, (_, r) => (
    // biome-ignore lint/suspicious/noArrayIndexKey: khung chờ tĩnh
    <TableRow key={r}>
      {Array.from({ length: cols }, (_, c) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: khung chờ tĩnh
        <TableCell key={c}>
          <Skeleton className="h-5" style={{ width: `${WIDTHS[(r + c) % WIDTHS.length]}%` }} />
        </TableCell>
      ))}
    </TableRow>
  ));
}

/** Hình của `<PageHeader>` (mb-4, tiêu đề text-xl 28px + mô tả text-sm 20px). */
export function PageHeaderSkeleton({ actions = false }: { actions?: boolean }) {
  return (
    <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div className="space-y-1">
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-5 w-72 max-w-full" />
      </div>
      {actions && <Skeleton className="h-9 w-32" />}
    </div>
  );
}

/**
 * Khung trang chung cho `loading.tsx` (chuyển trang trong dashboard / tầng tài khoản): tiêu đề + thanh công cụ + bảng —
 * hình phổ biến nhất của các trang danh sách; trang thật thay vào khi chunk JS tải xong.
 */
export function PageSkeleton() {
  return (
    <div aria-busy="true">
      <PageHeaderSkeleton actions />
      <div className="mb-3 flex items-center justify-between gap-2">
        <Skeleton className="h-8 w-full max-w-xs" />
        <Skeleton className="h-8 w-20" />
      </div>
      <div className="overflow-hidden rounded-lg border bg-card">
        <div className="h-10 border-b bg-muted/30" />
        <div className="divide-y">
          {Array.from({ length: 6 }, (_, r) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: khung chờ tĩnh
            <div key={r} className="flex items-center gap-4 px-3 py-2">
              {Array.from({ length: 4 }, (_, c) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: khung chờ tĩnh
                <Skeleton key={c} className="h-5 flex-1" style={{ maxWidth: `${WIDTHS[(r + c) % WIDTHS.length]}%` }} />
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
