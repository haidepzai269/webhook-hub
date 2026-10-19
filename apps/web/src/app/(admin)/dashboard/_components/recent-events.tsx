"use client";

import Link from "next/link";

import { DataTable } from "@/components/admin/data-table";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useEvents } from "@/lib/hub/queries";
import { useT } from "@/lib/i18n/use-t";

import { RangeEvents } from "./range-events";
import { useChartSelection } from "./selection-context";
import { EVENT_MOBILE_CARD, useEventColumns } from "../events/_components/event-columns";

/** Không có vùng chọn: 10 sự kiện gần nhất, trực tiếp (như cũ). Có vùng chọn trên biểu đồ (ADR-262): khối theo khoảng. */
export function RecentEvents() {
  const { selection } = useChartSelection();
  return selection ? <RangeEvents selection={selection} /> : <LiveRecent />;
}

function LiveRecent() {
  const { data, isLoading, error } = useEvents(undefined, 10);
  const t = useT();
  const columns = useEventColumns();
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("page.dashboard.recent.title")}</CardTitle>
        <CardDescription>{t("page.dashboard.recent.desc")}</CardDescription>
        <CardAction>
          <Button asChild variant="outline" size="sm">
            <Link href="/dashboard/events">{t("page.dashboard.recent.view-all")}</Link>
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        <DataTable
          data={data?.events}
          columns={columns}
          getRowId={(e) => e.id}
          isLoading={isLoading}
          error={error}
          pageSize={false}
          mobile={EVENT_MOBILE_CARD}
          emptyText={t("page.dashboard.recent.empty")}
        />
      </CardContent>
    </Card>
  );
}
