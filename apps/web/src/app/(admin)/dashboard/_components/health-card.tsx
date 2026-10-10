"use client";

import { Badge } from "@/components/ui/badge";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useHealth } from "@/lib/hub/queries";

const DEP_LABEL: Record<string, string> = {
  postgres: "PostgreSQL",
  redis: "Redis",
  rabbitmq: "RabbitMQ",
};

// Vai trò của từng dependency — để người xem hiểu "Redis chết" khác "Postgres chết" ra sao (BB-2).
const DEP_ROLE: Record<string, string> = {
  postgres: "trọng tài idempotency — chết là ngừng nhận",
  redis: "chỉ là đường tắt — chết thì chậm đi, không sai",
  rabbitmq: "hàng đợi — chết thì outbox giữ sự kiện chờ",
};

export function HealthCard() {
  const { data, isLoading } = useHealth();

  const status = data?.status;
  const statusBadge =
    status === "healthy" ? (
      <Badge className="bg-emerald-600 text-white">Khoẻ</Badge>
    ) : status === "degraded" ? (
      <Badge className="bg-amber-500 text-white">Suy giảm</Badge>
    ) : status === "offline" ? (
      <Badge variant="destructive">Không kết nối</Badge>
    ) : null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Sức khoẻ hệ thống</CardTitle>
        <CardDescription>GET /health · tự làm mới 15 giây</CardDescription>
        <CardAction>{statusBadge}</CardAction>
      </CardHeader>
      <CardContent className="space-y-2">
        {isLoading ? (
          <Skeleton className="h-20 w-full" />
        ) : status === "offline" || !data?.dependencies ? (
          <p className="text-muted-foreground text-sm">Không gọi được hub-api.</p>
        ) : (
          Object.entries(data.dependencies).map(([name, dep]) => (
            <div key={name} className="flex items-start justify-between gap-3 text-sm">
              <div className="min-w-0">
                <div className="font-medium">{DEP_LABEL[name] ?? name}</div>
                <div className="truncate text-muted-foreground text-xs" title={dep.message}>
                  {dep.status === "down" && dep.message ? dep.message : DEP_ROLE[name]}
                </div>
              </div>
              <span
                className={`mt-1 inline-flex shrink-0 items-center gap-1.5 font-mono text-xs ${
                  dep.status === "up" ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"
                }`}
              >
                <span className={`size-2 rounded-full ${dep.status === "up" ? "bg-emerald-500" : "bg-rose-500"}`} />
                {dep.status.toUpperCase()}
              </span>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}
