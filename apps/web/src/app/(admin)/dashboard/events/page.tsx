"use client";

import { useState } from "react";

import { ChevronLeft, ChevronRight } from "lucide-react";

import { DataTable } from "@/components/admin/data-table";
import { PageHeader } from "@/components/admin/page-header";
import { Button } from "@/components/ui/button";
import { useEvents } from "@/lib/hub/queries";

import { eventColumns } from "./_components/event-columns";
import { EventSheet } from "./_components/event-sheet";
import { OrphanBanner } from "./_components/orphan-banner";
import { TraceFeed } from "./_components/trace-feed";

const PAGE_SIZE = 25;

/**
 * Phân trang bằng cursor (`after` = id event cuối trang trước) — giống cách polling client
 * tiêu thụ API (ADR-016). Giữ một stack cursor để quay lại trang trước.
 */
export default function EventsPage() {
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  // Giữ id khi Sheet đóng (chỉ tắt `open`) để nội dung không nháy "không tìm thấy" lúc trượt ra.
  const [selected, setSelected] = useState<{ id: string | null; open: boolean }>({ id: null, open: false });
  const after = cursors.at(-1);
  const { data, isLoading, isFetching, isPlaceholderData, error } = useEvents(after, PAGE_SIZE);
  const page = cursors.length;

  return (
    <>
      <PageHeader
        title="Sự kiện"
        description="Sự kiện đã chuẩn hoá, mới nhất trước. Bấm một dòng để xem payload và các delivery."
      />
      <OrphanBanner />
      <TraceFeed />
      <DataTable
        data={data?.events}
        columns={eventColumns}
        getRowId={(e) => e.id}
        isLoading={isLoading}
        error={error}
        pageSize={false}
        searchPlaceholder="Lọc trong trang này…"
        onRowClick={(e) => setSelected({ id: e.id, open: true })}
        isStale={isPlaceholderData}
        emptyText={page > 1 ? "Hết sự kiện." : "Chưa có sự kiện nào."}
        toolbar={
          <div className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">
              Trang {page}
              {isFetching ? " · đang tải…" : ""}
            </span>
            <Button variant="outline" size="sm" disabled={page === 1} onClick={() => setCursors((c) => c.slice(0, -1))}>
              <ChevronLeft />
              Trước
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={!data?.nextCursor || isPlaceholderData}
              onClick={() => data?.nextCursor && setCursors((c) => [...c, data.nextCursor ?? undefined])}
            >
              Sau
              <ChevronRight />
            </Button>
          </div>
        }
      />
      <EventSheet
        eventId={selected.id}
        open={selected.open}
        onClose={() => setSelected((s) => ({ ...s, open: false }))}
      />
    </>
  );
}
