"use client";

import Link from "next/link";

import { DataTable } from "@/components/admin/data-table";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useEvents } from "@/lib/hub/queries";
import { useT } from "@/lib/i18n/use-t";

import { EVENT_MOBILE_CARD, useEventColumns } from "../events/_components/event-columns";

export function RecentEvents() {
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
