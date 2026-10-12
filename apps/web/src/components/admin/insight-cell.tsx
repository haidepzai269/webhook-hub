"use client";

import { createContext, useContext } from "react";

import Link from "next/link";

import { useInsights } from "@/lib/hub/insight-queries";
import {
  INSIGHT_DOT,
  INSIGHT_TONE,
  insightActions,
  insightsBySubject,
  insightText,
  type InsightCode,
  type InsightView,
} from "@/lib/insights/message";
import { useLocale, useT } from "@/lib/i18n/use-t";

/** Nhận định theo id đối tượng của bảng đang hiện; `loading` = chưa có dữ liệu (ô hiện "…"). */
interface InsightRows {
  bySubject: Map<string, InsightView>;
  loading: boolean;
}
const InsightRowsContext = createContext<InsightRows>({ bySubject: new Map(), loading: false });

/**
 * CB6 (SPEC §7): bọc một bảng (Đích -> `I-dest`, Nguồn -> `I-silent`) — MỘT lời gọi `/insights?codes=<code>` cho cả bảng,
 * từng ô đọc nhận định của dòng mình qua context (cột của DataTable là hàm thuần, không gọi hook theo dòng).
 */
export function InsightRowsProvider({ code, children }: { code: InsightCode; children: React.ReactNode }) {
  const { data, isLoading } = useInsights([code]);
  return (
    <InsightRowsContext.Provider value={{ bySubject: insightsBySubject(data, code), loading: isLoading }}>
      {children}
    </InsightRowsContext.Provider>
  );
}

/** Ô nhãn một câu + dòng phụ; trạng thái cần làm gì thì kèm link hành động đầu. Không có nhận định (Ngắt/lưu trữ) -> "—". */
export function InsightCell({ id }: { id: string }) {
  const t = useT();
  const locale = useLocale();
  const { bySubject, loading } = useContext(InsightRowsContext);
  const i = bySubject.get(id);
  if (!i) return <span className="text-muted-foreground text-xs">{loading ? "…" : "—"}</span>;
  const text = insightText(i, t, { locale, now: Date.now() });
  if (!text) return <span className="text-muted-foreground text-xs">—</span>;
  const action = text.level === "warning" || text.level === "critical" ? insightActions(i)[0] : undefined;
  return (
    <div className="flex max-w-xs flex-col gap-0.5" title={text.detail}>
      <span className={`inline-flex items-center gap-1.5 font-medium text-xs ${INSIGHT_TONE[text.level]}`}>
        <span className={`size-1.5 shrink-0 rounded-full ${INSIGHT_DOT[text.level]}`} aria-hidden />
        {text.label}
      </span>
      <span className="line-clamp-2 text-muted-foreground text-[11px]">{text.detail}</span>
      {action && (
        <Link href={action.href} className="w-fit text-[11px] underline underline-offset-2 hover:text-foreground">
          {t(action.labelKey)}
        </Link>
      )}
    </div>
  );
}
