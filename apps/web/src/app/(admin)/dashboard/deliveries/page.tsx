"use client";

import { Suspense, useEffect, useState } from "react";

import { X } from "lucide-react";

import { CursorPager } from "@/components/admin/cursor-pager";
import { DataTable } from "@/components/admin/data-table";
import { PageHeader } from "@/components/admin/page-header";
import { TimeRange } from "@/components/admin/time-range";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PageSkeleton } from "@/components/admin/skeletons";
import { DELIVERY_PARAMS, DELIVERY_STATUS_VALUES, toApiQuery } from "@/lib/hub/list-url";
import { useDeliveries, useDestinations } from "@/lib/hub/queries";
import { useUrlParams } from "@/lib/hub/use-url-params";
import type { MessageKey } from "@/lib/i18n/dictionary";
import { useT } from "@/lib/i18n/use-t";
import { deliveryStatusKey } from "@/components/admin/status-badge";

import { useDeliveryColumns } from "./_components/delivery-columns";

const ALL = "__all";
const CODE_PRESETS = ["2xx", "4xx", "5xx", "none"] as const;
// Sender quy lỗi mạng / timeout về 500 -> lớp 5xx gồm cả lỗi mạng (ADR-163).
const CODE_LABEL: Record<string, MessageKey | null> = {
  "2xx": null,
  "4xx": null,
  "5xx": "page.deliveries.filter.code-5xx",
  none: "page.deliveries.filter.code-none",
};

/**
 * Lượt giao (ADR-163): phân trang Trước/Sau theo cursor keyset, 50 dòng/trang. Bộ lọc trạng thái, đích, HTTP code
 * (lần thử cuối) và khoảng thời gian nằm trên URL — F5 / gửi link giữ nguyên trang đang xem.
 */
function DeliveriesView() {
  const t = useT();
  const columns = useDeliveryColumns();
  const url = useUrlParams(DELIVERY_PARAMS);
  const v = url.values;
  const { data, isLoading, isPlaceholderData, error } = useDeliveries(toApiQuery(v));
  const destinations = useDestinations();
  // Ô mã HTTP: gõ tự do (vd 404), ghi URL khi hợp lệ.
  const [codeInput, setCodeInput] = useState(v.code ?? "");
  // URL đổi hoặc "Bỏ lọc" (resetToken) -> ô theo URL, kể cả mã gõ dở chưa hợp lệ.
  // biome-ignore lint/correctness/useExhaustiveDependencies: resetToken là tín hiệu xoá ô
  useEffect(() => setCodeInput(v.code ?? ""), [v.code, url.resetToken]);
  const commitCode = (raw: string) => {
    const c = raw.trim().toLowerCase();
    if (c === "" || /^([1-5]\d{2}|[1-5]xx|none)$/.test(c)) url.setFilter({ code: c || null });
  };
  const filtered = Boolean(v.status || v.destination || v.code || v.from || v.to);

  return (
    <>
      <PageHeader
        title={t("page.deliveries.title")}
        description={t("page.deliveries.description")}
      />
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Select value={v.status ?? ALL} onValueChange={(s) => url.setFilter({ status: s === ALL ? null : s })}>
          <SelectTrigger size="sm" className="w-40" aria-label={t("page.deliveries.filter.status")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{t("page.deliveries.filter.all-statuses")}</SelectItem>
            {DELIVERY_STATUS_VALUES.map((s) => (
              <SelectItem key={s} value={s} title={s}>
                {t(deliveryStatusKey(s))}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={v.destination ?? ALL} onValueChange={(d) => url.setFilter({ destination: d === ALL ? null : d })}>
          <SelectTrigger size="sm" className="w-52" aria-label={t("page.deliveries.filter.destination")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{t("page.deliveries.filter.all-destinations")}</SelectItem>
            {(destinations.data ?? []).map((d) => (
              <SelectItem key={d.id} value={d.id}>
                {d.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={CODE_PRESETS.includes(v.code as never) ? (v.code as string) : ALL} onValueChange={(c) => url.setFilter({ code: c === ALL ? null : c })}>
          <SelectTrigger size="sm" className="w-40" aria-label={t("page.deliveries.filter.code")}>
            <SelectValue placeholder={t("page.deliveries.filter.code")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{t("page.deliveries.filter.all-codes")}</SelectItem>
            {CODE_PRESETS.map((c) => (
              <SelectItem key={c} value={c}>
                {CODE_LABEL[c] ? t(CODE_LABEL[c] as MessageKey) : c}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          value={codeInput}
          onChange={(e) => setCodeInput(e.target.value)}
          onBlur={(e) => commitCode(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && commitCode(codeInput)}
          placeholder={t("page.deliveries.filter.code-exact")}
          className="h-8 w-36 font-mono text-xs"
          aria-label={t("page.deliveries.filter.code-exact-aria")}
        />
        <TimeRange key={url.resetToken} from={v.from} to={v.to} onChange={(r) => url.setFilter(r)} />
        {filtered && (
          <Button variant="ghost" size="sm" onClick={url.clear}>
            <X />
            {t("common.filters.clear")}
          </Button>
        )}
      </div>
      <DataTable
        data={data?.items}
        columns={columns}
        getRowId={(d) => d.id}
        isLoading={isLoading}
        isStale={isPlaceholderData}
        error={error}
        pageSize={false}
        searchPlaceholder={t("page.deliveries.search")}
        emptyText={filtered ? t("page.deliveries.no-match") : t("page.deliveries.empty")}
        toolbar={
          <CursorPager
            next={data?.next}
            prev={data?.prev}
            loading={isPlaceholderData}
            onNext={(c) => url.setCursor({ before: c })}
            onPrev={(c) => url.setCursor({ after: c })}
            onNewest={() => url.setCursor({})}
          />
        }
      />
    </>
  );
}

export default function DeliveriesPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <DeliveriesView />
    </Suspense>
  );
}
