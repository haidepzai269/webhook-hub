"use client";

import Link from "next/link";

import { DataTable } from "@/components/admin/data-table";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useEvents } from "@/lib/hub/queries";

import { eventColumns } from "../events/_components/event-columns";

export function RecentEvents() {
  const { data, isLoading, error } = useEvents(undefined, 10);
  return (
    <Card>
      <CardHeader>
        <CardTitle>10 sự kiện gần nhất</CardTitle>
        <CardDescription>Tự cập nhật khi hub nhận webhook mới</CardDescription>
        <CardAction>
          <Button asChild variant="outline" size="sm">
            <Link href="/dashboard/events">Xem tất cả</Link>
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        <DataTable
          data={data?.events}
          columns={eventColumns}
          getRowId={(e) => e.id}
          isLoading={isLoading}
          error={error}
          pageSize={false}
          emptyText="Chưa có sự kiện nào. Thử bắn một webhook ở Playground."
        />
      </CardContent>
    </Card>
  );
}
