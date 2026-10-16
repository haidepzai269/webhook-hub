"use client";

import { useAuthBooting } from "@/components/admin/auth-guard";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useRealtimeStore } from "@/lib/hub/socket";
import { useT } from "@/lib/i18n/use-t";

export function RealtimeBadge() {
  const t = useT();
  const connected = useRealtimeStore((s) => s.connected);
  const booting = useAuthBooting();
  // ADR-238: socket chỉ nối sau khi phiên xác nhận — lúc khởi động đừng báo đỏ "Mất kết nối". Cùng cỡ Badge (h-5).
  if (booting) return <Skeleton className="h-5 w-7 rounded-full sm:w-28" />;
  return (
    <Badge variant="outline" className="gap-1.5" title={t("admin.realtime.title")}>
      <span className={`size-2 rounded-full ${connected ? "bg-emerald-500" : "bg-rose-500"}`} />
      <span className="hidden sm:inline">{connected ? t("admin.realtime.connected") : t("admin.realtime.disconnected")}</span>
    </Badge>
  );
}
