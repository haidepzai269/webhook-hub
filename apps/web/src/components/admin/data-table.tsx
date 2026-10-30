"use client";

import { type ReactNode, useEffect, useRef, useState } from "react";

import {
  type ColumnDef,
  type ColumnVisibilityState,
  type PaginationState,
  type RowData,
  type SortingState,
  useTable,
} from "@tanstack/react-table";
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronLeft, ChevronRight, Columns3 } from "lucide-react";

import { cn } from "cn";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SearchInput } from "@/components/admin/search-input";
import { TableRowsSkeleton } from "@/components/admin/skeletons";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { useIsMobileState } from "@/hooks/use-mobile";
import { type DataTableFeatures, dataTableFeatures } from "@/lib/data-table-features";
import { useT } from "@/lib/i18n/use-t";

import { type FitColumn, hideCandidates, type MobileCardSpec, planMobileCard } from "./responsive-table-logic";
import { useFitColumns } from "./use-fit-columns";

export type HubColumn<T extends RowData> = ColumnDef<DataTableFeatures, T>;

/** Id cột như TanStack suy ra: `id` tường minh, không thì `accessorKey`. */
function columnIdOf<T extends RowData>(c: HubColumn<T>): string {
  const d = c as { id?: string; accessorKey?: string | number };
  return String(d.id ?? d.accessorKey ?? "");
}

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
  /**
   * Dưới bảng, canh phải — chỗ của `CursorPager` (phân trang phía server). Có `footer` nghĩa là bảng chỉ chứa MỘT TRANG dữ liệu:
   * ô tìm và sắp xếp chỉ tác động trong trang này (hiện ghi chú bên cạnh ô tìm).
   */
  footer?: ReactNode;
  /** Class thêm cho từng hàng (vd làm mờ hàng đã thu hồi). */
  rowClassName?: (row: T) => string | undefined;
  /** Dưới `md` vẽ DANH SÁCH THẺ thay bảng (ADR-261). Không khai báo = giữ bảng cuộn ngang như cũ. */
  mobile?: MobileCardSpec;
}

/** Bảng dữ liệu chung của admin — khung data-table của Studio Admin (TanStack Table v9). */
export function DataTable<T extends RowData>({
  data,
  columns,
  getRowId,
  isLoading,
  error,
  isStale,
  emptyText,
  searchPlaceholder,
  pageSize = 20,
  onRowClick,
  toolbar,
  footer,
  rowClassName,
  mobile,
}: DataTableProps<T>) {
  const t = useT();
  // Có `mobile`: chưa đo viewport thì vẽ khung chờ (không nháy bảng rộng rồi mới sang thẻ); không có `mobile` thì như cũ.
  const viewport = useIsMobileState();
  const measuring = Boolean(mobile) && viewport === undefined;
  const cards = Boolean(mobile) && viewport === true;
  const [globalFilter, setGlobalFilter] = useState("");
  const [sorting, setSorting] = useState<SortingState>([]);
  // Cột người dùng chọn qua nút "Cột" (true = chủ động bật → ghim, không tự ẩn). Cột bị TỰ ẨN vì khung hẹp (ADR-270)
  // không nằm ở đây: chúng chỉ chồng lên lúc dựng `columnVisibility`, nên rộng ra là hiện lại.
  const [userVisibility, setUserVisibility] = useState<ColumnVisibilityState>({});
  const [pagination, setPagination] = useState<PaginationState>({
    pageIndex: 0,
    pageSize: pageSize === false ? Number.MAX_SAFE_INTEGER : pageSize,
  });
  const wrapRef = useRef<HTMLDivElement>(null);
  const candidates = hideCandidates(
    columns.map(
      (c): FitColumn => {
        const id = columnIdOf(c);
        return { id, canHide: c.enableHiding !== false, userVisible: userVisibility[id] !== false, pinned: userVisibility[id] === true };
      },
    ),
    mobile ? [mobile.title, mobile.badge, mobile.actions].filter((x): x is string => Boolean(x)) : [],
  );
  const fit = useFitColumns(wrapRef, candidates.length, data);
  const autoHidden = candidates.slice(0, fit.hidden);
  const columnVisibility: ColumnVisibilityState = { ...userVisibility, ...Object.fromEntries(autoHidden.map((id) => [id, false])) };

  const table = useTable({
    features: dataTableFeatures,
    data: data ?? [],
    columns,
    state: { globalFilter, sorting, columnVisibility, pagination },
    // (columnVisibility ở trên = người dùng chọn + tự ẩn theo bề rộng)
    getRowId: (row) => getRowId(row),
    globalFilterFn: "includesString",
    onGlobalFilterChange: setGlobalFilter,
    onSortingChange: setSorting,
    onColumnVisibilityChange: (updater) => {
      const next = typeof updater === "function" ? updater(columnVisibility) : updater;
      // Chỉ ghi nhận cột người dùng VỪA đổi; cột đang tự ẩn mà họ không đụng tới thì không biến thành lựa chọn của họ.
      setUserVisibility((prev) => {
        const out = { ...prev };
        for (const [id, v] of Object.entries(next)) if ((columnVisibility[id] ?? true) !== v) out[id] = v;
        return out;
      });
    },
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
  const hideable = cards ? [] : table.getAllLeafColumns().filter((c) => c.getCanHide());
  const cardPlan = mobile ? planMobileCard(mobile, table.getVisibleLeafColumns().map((c) => c.id)) : null;

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        {searchPlaceholder ? (
          <SearchInput
            wrapperClassName="w-full sm:w-72"
            placeholder={searchPlaceholder}
            aria-label={searchPlaceholder}
            value={globalFilter}
            onChange={(e) => {
              setGlobalFilter(e.target.value);
              table.setPageIndex(0);
            }}
          />
        ) : (
          <div />
        )}
        {footer && searchPlaceholder && (
          <span className="hidden text-muted-foreground text-xs sm:mr-auto sm:ml-2 lg:inline">{t("admin.table.search-in-page")}</span>
        )}
        <div className="flex flex-wrap items-center gap-2">
          {toolbar}
          {hideable.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm">
                  <Columns3 />
                  {t("admin.table.columns")}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                <DropdownMenuLabel>{t("admin.table.show-columns")}</DropdownMenuLabel>
                <DropdownMenuSeparator />
                {autoHidden.length > 0 && (
                  <DropdownMenuLabel className="font-normal text-muted-foreground text-xs">
                    {t("admin.table.auto-hidden", { n: autoHidden.length })}
                  </DropdownMenuLabel>
                )}
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

      {measuring ? (
        <div aria-busy="true" className="space-y-2">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-24 w-full rounded-lg" />
          ))}
        </div>
      ) : cards && cardPlan ? (
        <ul className={`space-y-2 transition-opacity ${isStale ? "opacity-60" : ""}`}>
          {isLoading && !data ? (
            [0, 1, 2, 3].map((i) => (
              <li key={i}>
                <Skeleton className="h-24 w-full rounded-lg" />
              </li>
            ))
          ) : error ? (
            <li className="rounded-lg border bg-card p-4 text-center text-destructive text-sm">
              {t("common.load-error")}: {error.message}
            </li>
          ) : rows.length ? (
            rows.map((row) => {
              const byId = new Map(row.getVisibleCells().map((c) => [c.column.id, c]));
              const render = (id: string | null) => {
                const cell = id ? byId.get(id) : undefined;
                return cell ? <table.FlexRender cell={cell} /> : null;
              };
              const headerOf = (id: string) => {
                const h = table.getColumn(id)?.columnDef.header;
                return typeof h === "string" ? h : id;
              };
              return (
                <li key={row.id}>
                  {/* Thẻ bấm được giữ ngữ nghĩa của hàng bảng: focus bàn phím + Enter/Space. */}
                  <div
                    className={cn(
                      "rounded-lg border bg-card p-3",
                      onRowClick && "cursor-pointer active:bg-muted/60 focus-visible:bg-muted focus-visible:outline-none",
                      rowClassName?.(row.original),
                    )}
                    role={onRowClick ? "button" : undefined}
                    tabIndex={onRowClick ? 0 : undefined}
                    onClick={onRowClick ? () => onRowClick(row.original) : undefined}
                    onKeyDown={
                      onRowClick
                        ? (e) => {
                            if (e.target !== e.currentTarget) return;
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              onRowClick(row.original);
                            }
                          }
                        : undefined
                    }
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">{render(cardPlan.title)}</div>
                      {cardPlan.badge && <div className="shrink-0">{render(cardPlan.badge)}</div>}
                    </div>
                    {cardPlan.meta.length > 0 && (
                      <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
                        {cardPlan.meta.map((m) => (
                          <div key={m.id} className={cn("min-w-0", m.wide && "col-span-2")}>
                            <dt className="text-muted-foreground">{headerOf(m.id)}</dt>
                            <dd className="min-w-0 break-words [&_[data-cell-text]]:max-w-full">{render(m.id)}</dd>
                          </div>
                        ))}
                      </dl>
                    )}
                    {cardPlan.actions && (
                      // Vùng chạm ≥ 40px; bấm nút không kích hoạt onRowClick của thẻ.
                      // biome-ignore lint/a11y/useKeyWithClickEvents: chỉ chặn nổi bọt, nút bên trong tự xử lý phím
                      <div className="mt-3 flex [&_button]:min-h-10 [&_button]:flex-1" onClick={(e) => e.stopPropagation()}>
                        {render(cardPlan.actions)}
                      </div>
                    )}
                  </div>
                </li>
              );
            })
          ) : (
            <li className="rounded-lg border bg-card p-6 text-center text-muted-foreground text-sm">{emptyText ?? t("common.empty")}</li>
          )}
        </ul>
      ) : (
      <div
        ref={wrapRef}
        data-fit-crush={fit.crush}
        className={`fit-table overflow-hidden rounded-lg border bg-card transition-opacity ${isStale ? "opacity-60" : ""}`}
      >
        <Table>
          <TableHeader className="bg-muted/30">
            {table.getHeaderGroups().map((hg) => (
              <TableRow key={hg.id}>
                {hg.headers.map((header) => (
                  // Tiêu đề dài ("Giới hạn (yêu cầu/giây)", "Cầu dao ngắt mạch") được xuống dòng khi trang hẹp — đủ chỗ
                  // thì bảng tự động vẫn để một dòng; không thì bảng tràn ngang và cắt cột cuối ở 1280–1440px.
                  <TableHead
                    key={header.id}
                    colSpan={header.colSpan}
                    aria-sort={header.column.getCanSort() ? sortAria(header.column.getIsSorted()) : undefined}
                    className="h-10 whitespace-normal px-3 py-1.5 font-medium leading-tight"
                  >
                    {!header.isPlaceholder && header.column.getCanSort() && (
                      <button
                        type="button"
                        onClick={header.column.getToggleSortingHandler()}
                        className="-mx-1 inline-flex cursor-pointer items-center gap-1 rounded px-1 text-left hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
                      >
                        <table.FlexRender header={header} />
                        <SortIcon dir={header.column.getIsSorted()} />
                      </button>
                    )}
                    {!header.isPlaceholder && !header.column.getCanSort() && <table.FlexRender header={header} />}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {isLoading && !data ? (
              // ADR-238: khung chờ theo TỪNG cột (độ rộng lệch nhau như chữ thật), cao bằng dòng thật — không nhảy bảng.
              <TableRowsSkeleton cols={colCount} rows={5} cellClassName="px-3" />
            ) : error ? (
              <TableRow>
                <TableCell colSpan={colCount} className="h-24 text-center text-destructive">
                  {t("common.load-error")}: {error.message}
                </TableCell>
              </TableRow>
            ) : rows.length ? (
              rows.map((row) => (
                <TableRow
                  key={row.id}
                  className={cn(onRowClick && "cursor-pointer focus-visible:bg-muted focus-visible:outline-none", rowClassName?.(row.original))}
                  tabIndex={onRowClick ? 0 : undefined}
                  onClick={onRowClick ? () => onRowClick(row.original) : undefined}
                  onKeyDown={
                    onRowClick
                      ? (e) => {
                          // Chỉ khi phím rơi đúng vào hàng — nút/liên kết bên trong ô tự xử lý Enter/Space của chúng.
                          if (e.target !== e.currentTarget) return;
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            onRowClick(row.original);
                          }
                        }
                      : undefined
                  }
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
                  {emptyText ?? t("common.empty")}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
      )}

      {footer && <div className="flex justify-end">{footer}</div>}

      {pageSize !== false && table.getPageCount() > 1 && (
        <div className="flex items-center justify-end gap-2 text-sm">
          <span className="text-muted-foreground">
            {t("admin.table.page", { page: table.state.pagination.pageIndex + 1, total: table.getPageCount() })}
          </span>
          <Button
            variant="outline"
            size="icon-sm"
            onClick={() => table.previousPage()}
            disabled={!table.getCanPreviousPage()}
            aria-label={t("admin.table.prev-page")}
          >
            <ChevronLeft />
          </Button>
          <Button
            variant="outline"
            size="icon-sm"
            onClick={() => table.nextPage()}
            disabled={!table.getCanNextPage()}
            aria-label={t("admin.table.next-page")}
          >
            <ChevronRight />
          </Button>
        </div>
      )}
    </div>
  );
}

function sortAria(dir: false | "asc" | "desc"): "ascending" | "descending" | "none" {
  if (dir === "asc") return "ascending";
  if (dir === "desc") return "descending";
  return "none";
}

function SortIcon({ dir }: { dir: false | "asc" | "desc" }) {
  if (dir === "asc") return <ArrowUp className="size-3.5" aria-hidden />;
  if (dir === "desc") return <ArrowDown className="size-3.5" aria-hidden />;
  return <ArrowUpDown className="size-3.5 opacity-40" aria-hidden />;
}
