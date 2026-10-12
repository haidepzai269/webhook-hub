"use client";

import { Badge } from "@/components/ui/badge";
import { useRealtimeStore } from "@/lib/hub/socket";
import { useT } from "@/lib/i18n/use-t";

export function RealtimeBadge() {
  const t = useT();
  const connected = useRealtimeStore((s) => s.connected);
  return (
    <Badge variant="outline" className="gap-1.5" title={t("admin.realtime.title")}>
      <span className={`size-2 rounded-full ${connected ? "bg-emerald-500" : "bg-rose-500"}`} />
      <span className="hidden sm:inline">{connected ? t("admin.realtime.connected") : t("admin.realtime.disconnected")}</span>
    </Badge>
  );
}
