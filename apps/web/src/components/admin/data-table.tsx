"use client";

import { type ReactNode, useEffect, useState } from "react";

import {
  type ColumnDef,
  type ColumnVisibilityState,
  type PaginationState,
  type RowData,
  type SortingState,
  useTable,
} from "@tanstack/react-table";
import { ChevronLeft, ChevronRight, Columns3, Search } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { type DataTableFeatures, dataTableFeatures } from "@/lib/data-table-features";

export type HubColumn<T extends RowData> = ColumnDef<DataTableFeatures, T>;

interface DataTableProps<T extends RowData> {
  data: T[] | undefined;
  columns: HubColumn<T>[];
  getRowId: (row: T) => string;
  isLoading?: boolean;
  error?: Error | null;
  /** Đang hiển thị dữ liệu cũ trong lúc tải bộ lọc mới (keepPreviousData) → làm mờ. */
  isStale?: boolean;
  emptyText?: string;
  /** Ô tìm kiếm lọc trên mọi cột (phía client). */
  searchPlaceholder?: string;
  /** Phân trang phía client. Tắt khi trang tự phân trang bằng cursor phía server. */
  pageSize?: number | false;
  onRowClick?: (row: T) => void;
  /** Nút/bộ lọc riêng của từng trang, đặt bên trái nút "Cột". */
  toolbar?: ReactNode;
}

/** Bảng dữ liệu chung của admin — khung data-table của Studio Admin (TanStack Table v9). */
export function DataTable<T extends RowData>({
  data,
  columns,
  getRowId,
  isLoading,
  error,
  isStale,
  emptyText = "Chưa có dữ liệu.",
  searchPlaceholder,
  pageSize = 20,
  onRowClick,
  toolbar,
}: DataTableProps<T>) {
  const [globalFilter, setGlobalFilter] = useState("");
  const [sorting, setSorting] = useState<SortingState>([]);
  const [columnVisibility, setColumnVisibility] = useState<ColumnVisibilityState>({});
  const [pagination, setPagination] = useState<PaginationState>({
    pageIndex: 0,
    pageSize: pageSize === false ? Number.MAX_SAFE_INTEGER : pageSize,
  });

  const table = useTable({
    features: dataTableFeatures,
    data: data ?? [],
    columns,
    state: { globalFilter, sorting, columnVisibility, pagination },
    getRowId: (row) => getRowId(row),
    globalFilterFn: "includesString",
    onGlobalFilterChange: setGlobalFilter,
    onSortingChange: setSorting,
    onColumnVisibilityChange: setColumnVisibility,
    onPaginationChange: setPagination,
    autoResetPageIndex: false,
  });

  // Dữ liệu co lại (đổi bộ lọc, replay làm DLQ ngắn đi) khi đang ở trang cuối → kéo về trang
  // hợp lệ, nếu không bảng hiện "trống" mà pager đã biến mất, không có đường quay lại.
  const pageCount = table.getPageCount();
  useEffect(() => {
    if (pagination.pageIndex > 0 && pagination.pageIndex >= pageCount) {
      setPagination((p) => ({ ...p, pageIndex: Math.max(0, pageCount - 1) }));
    }
  }, [pageCount, pagination.pageIndex]);

  const rows = table.getRowModel().rows;
  const colCount = table.getVisibleLeafColumns().length;
  const hideable = table.getAllLeafColumns().filter((c) => c.getCanHide());

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        {searchPlaceholder ? (
          <div className="relative w-full sm:w-72">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="h-8 pl-8"
              placeholder={searchPlaceholder}
              value={globalFilter}
              onChange={(e) => {
                setGlobalFilter(e.target.value);
                table.setPageIndex(0);
              }}
            />
          </div>
        ) : (
          <div />
        )}
        <div className="flex flex-wrap items-center gap-2">
          {toolbar}
          {hideable.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm">
                  <Columns3 />
                  Cột
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                <DropdownMenuLabel>Hiện cột</DropdownMenuLabel>
                <DropdownMenuSeparator />
                {hideable.map((col) => (
                  <DropdownMenuCheckboxItem
                    key={col.id}
                    checked={col.getIsVisible()}
                    onCheckedChange={(v) => col.toggleVisibility(Boolean(v))}
                    onSelect={(e) => e.preventDefault()}
                  >
                    {typeof col.columnDef.header === "string" ? col.columnDef.header : col.id}
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>

      <div className={`overflow-x-auto rounded-lg border bg-card transition-opacity ${isStale ? "opacity-60" : ""}`}>
        <Table>
          <TableHeader className="bg-muted/30">
            {table.getHeaderGroups().map((hg) => (
              <TableRow key={hg.id}>
                {hg.headers.map((header) => (
                  <TableHead key={header.id} colSpan={header.colSpan} className="h-10 px-3 font-medium">
                    {header.isPlaceholder ? null : <table.FlexRender header={header} />}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {isLoading && !data ? (
              Array.from({ length: 5 }, (_, i) => (
                <TableRow key={`sk-${i}`}>
                  <TableCell colSpan={colCount} className="px-3">
                    <Skeleton className="h-5 w-full" />
                  </TableCell>
                </TableRow>
              ))
            ) : error ? (
              <TableRow>
                <TableCell colSpan={colCount} className="h-24 text-center text-destructive">
                  Không tải được dữ liệu: {error.message}
                </TableCell>
              </TableRow>
            ) : rows.length ? (
              rows.map((row) => (
                <TableRow
                  key={row.id}
                  className={onRowClick ? "cursor-pointer" : undefined}
                  onClick={onRowClick ? () => onRowClick(row.original) : undefined}
                >
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id} className="px-3 py-2 align-middle">
                      <table.FlexRender cell={cell} />
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={colCount} className="h-24 text-center text-muted-foreground">
                  {emptyText}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {pageSize !== false && table.getPageCount() > 1 && (
        <div className="flex items-center justify-end gap-2 text-sm">
          <span className="text-muted-foreground">
            Trang {table.state.pagination.pageIndex + 1}/{table.getPageCount()}
          </span>
          <Button
            variant="outline"
            size="icon-sm"
            onClick={() => table.previousPage()}
            disabled={!table.getCanPreviousPage()}
            aria-label="Trang trước"
          >
            <ChevronLeft />
          </Button>
          <Button
            variant="outline"
            size="icon-sm"
            onClick={() => table.nextPage()}
            disabled={!table.getCanNextPage()}
            aria-label="Trang sau"
          >
            <ChevronRight />
          </Button>
        </div>
      )}
    </div>
  );
}
