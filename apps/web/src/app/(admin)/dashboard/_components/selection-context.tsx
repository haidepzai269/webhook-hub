"use client";

import { createContext, type ReactNode, Suspense, useCallback, useContext, useEffect, useMemo, useState } from "react";

import { CardSkeleton } from "@/components/admin/skeletons";
import { DASHBOARD_RANGE_PARAMS } from "@/lib/hub/list-url";
import { useUrlParams } from "@/lib/hub/use-url-params";

import { type Selection, parseSelection } from "./chart-selection";

/**
 * ADR-262: vùng chọn trên biểu đồ nằm TRÊN URL (`?from=&to=`) — biểu đồ ghi, khối sự kiện bên dưới đọc. `hoverAt` = mốc
 * của dòng đang rê (vạch dọc trên biểu đồ), chỉ ở bộ nhớ.
 */
interface Ctx {
  selection: Selection | null;
  select: (s: Selection | null) => void;
  hoverAt: string | null;
  setHoverAt: (iso: string | null) => void;
}

const SelectionCtx = createContext<Ctx>({ selection: null, select: () => {}, hoverAt: null, setHoverAt: () => {} });

export const useChartSelection = () => useContext(SelectionCtx);

function Inner({ children }: { children: ReactNode }) {
  const url = useUrlParams(DASHBOARD_RANGE_PARAMS);
  const { from, to } = url.values;
  const selection = useMemo(() => parseSelection(from, to), [from, to]);
  const { setFilter } = url;
  const select = useCallback((s: Selection | null) => setFilter({ from: s?.from ?? null, to: s?.to ?? null }), [setFilter]);
  const [hoverAt, setHoverAt] = useState<string | null>(null);

  // Esc = bỏ chọn (trừ khi đang gõ trong ô nhập hoặc một lớp phủ đã xử lý phím).
  useEffect(() => {
    if (!selection) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const el = e.target as HTMLElement | null;
      if (el?.closest("input, textarea, select, [role=dialog], [role=menu], [role=listbox]")) return;
      select(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selection, select]);

  const value = useMemo(() => ({ selection, select, hoverAt, setHoverAt }), [selection, select, hoverAt]);
  return <SelectionCtx.Provider value={value}>{children}</SelectionCtx.Provider>;
}

export function SelectionProvider({ children }: { children: ReactNode }) {
  // useSearchParams cần Suspense; dữ liệu bên trong vốn tải phía client nên khung chờ chỉ là thoáng qua.
  return (
    <Suspense fallback={<CardSkeleton lines={6} className="h-64" />}>
      <Inner>{children}</Inner>
    </Suspense>
  );
}
