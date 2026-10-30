"use client";

import { type ReactNode, useRef } from "react";

import { cn } from "cn";

import { TableRowsSkeleton } from "@/components/admin/skeletons";
import { ErrorState } from "@/components/admin/state";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useT } from "@/lib/i18n/use-t";

import { hideCandidates } from "./responsive-table-logic";
import { revealClippedText, useFitColumns } from "./use-fit-columns";

export interface SimpleColumn<T> {
  key: string;
  header: ReactNode;
  cell: (row: T, index: number) => ReactNode;
  /** Căn lề cột (tiêu đề + ô). Mặc định trái. */
  align?: "left" | "center" | "right";
  /** Class thêm cho CẢ tiêu đề lẫn ô (vd `w-36`, `whitespace-normal`). */
  className?: string;
  /** Cột phụ: khi khung hẹp bảng tự ẩn dần các cột `optional` từ phải sang trái (ADR-271). Cột đầu và cột cuối luôn hiện. */
  optional?: boolean;
}

const ALIGN = { left: "", center: "text-center", right: "text-right" } as const;

/**
 * Bảng nhỏ KHÔNG cần sắp xếp/phân trang/chọn cột (cài đặt, lưu lượng, nhật ký trong sheet) — cùng token khung/tiêu đề/ô
 * với `DataTable` để hai loại bảng nhìn như một (ADR-246). Cần tìm kiếm/sắp xếp/phân trang → dùng `DataTable`.
 * - `framed` (mặc định): viền bo + nền card như DataTable; `false` khi bảng đã nằm trong khung riêng.
 * - `loading` → khung chờ theo cột; `error` → ErrorState; `rows` rỗng → `empty` (mặc định "Chưa có dữ liệu").
 */
export function SimpleTable<T>({
  columns,
  rows,
  getRowKey,
  loading,
  error,
  onRetry,
  empty,
  framed = true,
  rowClassName,
  className,
}: {
  columns: SimpleColumn<T>[];
  rows: T[] | undefined;
  getRowKey: (row: T, index: number) => string;
  loading?: boolean;
  error?: Error | null;
  onRetry?: () => void;
  empty?: ReactNode;
  framed?: boolean;
  rowClassName?: (row: T) => string | undefined;
  className?: string;
}) {
  const t = useT();
  const list = rows ?? [];
  const wrapRef = useRef<HTMLDivElement>(null);
  const candidates = hideCandidates(columns.map((c) => ({ id: c.key, canHide: c.optional === true, userVisible: true, pinned: false })));
  const fit = useFitColumns(wrapRef, candidates.length, rows);
  const hidden = new Set(candidates.slice(0, fit.hidden));
  const cols = columns.filter((c) => !hidden.has(c.key));
  const colSpan = cols.length;
  let body: ReactNode;
  if (loading && !rows) {
    body = <TableRowsSkeleton cols={colSpan} cellClassName="px-3" />;
  } else if (error) {
    body = (
      <TableRow>
        <TableCell colSpan={colSpan} className="p-3">
          <ErrorState error={error} onRetry={onRetry} inline />
        </TableCell>
      </TableRow>
    );
  } else if (list.length === 0) {
    body = (
      <TableRow>
        <TableCell colSpan={colSpan} className="h-20 text-center text-muted-foreground">
          {empty ?? t("common.empty")}
        </TableCell>
      </TableRow>
    );
  } else {
    body = list.map((row, i) => (
      <TableRow key={getRowKey(row, i)} className={rowClassName?.(row)}>
        {cols.map((c) => (
          <TableCell key={c.key} className={cn("px-3 py-2 align-middle", ALIGN[c.align ?? "left"], c.className)} onMouseEnter={revealClippedText}>
            {c.cell(row, i)}
          </TableCell>
        ))}
      </TableRow>
    ));
  }
  return (
    <div ref={wrapRef} data-fit-crush={fit.crush} className={cn("fit-table", framed && "overflow-hidden rounded-lg border bg-card", className)}>
      <Table>
        <TableHeader className="bg-muted/30">
          <TableRow>
            {cols.map((c) => (
              <TableHead key={c.key} className={cn("h-10 whitespace-normal px-3 py-1.5 font-medium leading-tight", ALIGN[c.align ?? "left"], c.className)}>
                {c.header}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>{body}</TableBody>
      </Table>
    </div>
  );
}
