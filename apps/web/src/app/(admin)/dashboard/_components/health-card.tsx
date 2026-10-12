"use client";

import { Badge } from "@/components/ui/badge";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useHealth } from "@/lib/hub/queries";
import type { MessageKey } from "@/lib/i18n/dictionary";
import { useT } from "@/lib/i18n/use-t";

const DEP_LABEL: Record<string, string> = {
  postgres: "PostgreSQL",
  redis: "Redis",
  rabbitmq: "RabbitMQ",
};

// Vai trò của từng dependency — để người xem hiểu "Redis chết" khác "Postgres chết" ra sao (BB-2).
const DEP_ROLE: Record<string, MessageKey> = {
  postgres: "page.dashboard.health.role.postgres",
  redis: "page.dashboard.health.role.redis",
  rabbitmq: "page.dashboard.health.role.rabbitmq",
};

export function HealthCard() {
  const { data, isLoading } = useHealth();
  const t = useT();

  const status = data?.status;
  const statusBadge =
    status === "healthy" ? (
      <Badge className="bg-emerald-600 text-white">{t("page.dashboard.health.healthy")}</Badge>
    ) : status === "degraded" ? (
      <Badge className="bg-amber-500 text-white">{t("page.dashboard.health.degraded")}</Badge>
    ) : status === "offline" ? (
      <Badge variant="destructive">{t("page.dashboard.health.offline")}</Badge>
    ) : null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("page.dashboard.health.title")}</CardTitle>
        <CardDescription>{t("page.dashboard.health.desc")}</CardDescription>
        <CardAction>{statusBadge}</CardAction>
      </CardHeader>
      <CardContent className="space-y-2">
        {isLoading ? (
          <Skeleton className="h-20 w-full" />
        ) : status === "offline" || !data?.dependencies ? (
          <p className="text-muted-foreground text-sm">{t("page.dashboard.health.unreachable")}</p>
        ) : (
          Object.entries(data.dependencies).map(([name, dep]) => (
            <div key={name} className="flex items-start justify-between gap-3 text-sm">
              <div className="min-w-0">
                <div className="font-medium">{DEP_LABEL[name] ?? name}</div>
                <div className="truncate text-muted-foreground text-xs" title={dep.message}>
                  {dep.status === "down" && dep.message ? dep.message : DEP_ROLE[name] && t(DEP_ROLE[name])}
                </div>
              </div>
              <span
                className={`mt-1 inline-flex shrink-0 items-center gap-1.5 text-xs ${
                  dep.status === "up" ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"
                }`}
              >
                <span className={`size-2 rounded-full ${dep.status === "up" ? "bg-emerald-500" : "bg-rose-500"}`} />
                {t(dep.status === "up" ? "page.dashboard.health.up" : "page.dashboard.health.down")}
              </span>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}
