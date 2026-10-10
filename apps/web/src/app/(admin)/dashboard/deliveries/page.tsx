"use client";

import { useState } from "react";

import { DataTable } from "@/components/admin/data-table";
import { PageHeader } from "@/components/admin/page-header";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useDeliveries } from "@/lib/hub/queries";
import { DELIVERY_STATUSES, type DeliveryStatus } from "@/lib/hub/types";

import { deliveryColumns } from "./_components/delivery-columns";

export default function DeliveriesPage() {
  const [status, setStatus] = useState<DeliveryStatus | "ALL">("ALL");
  const { data, isLoading, isPlaceholderData, error } = useDeliveries(status === "ALL" ? undefined : status);

  return (
    <>
      <PageHeader
        title="Deliveries"
        description="Mỗi delivery = một sự kiện × một subscription × một generation. 50 bản ghi mới nhất theo bộ lọc."
      />
      <DataTable
        data={data}
        columns={deliveryColumns}
        getRowId={(d) => d.id}
        isLoading={isLoading}
        isStale={isPlaceholderData}
        error={error}
        searchPlaceholder="Lọc theo đích, loại sự kiện, lỗi…"
        emptyText="Không có delivery nào ở trạng thái này."
        toolbar={
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            value={status}
            onValueChange={(v) => v && setStatus(v as DeliveryStatus | "ALL")}
            className="flex-wrap"
          >
            <ToggleGroupItem value="ALL">Tất cả</ToggleGroupItem>
            {DELIVERY_STATUSES.map((s) => (
              <ToggleGroupItem key={s} value={s} className="font-mono text-[11px]">
                {s}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        }
      />
    </>
  );
}
