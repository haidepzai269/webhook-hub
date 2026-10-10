"use client";

import { Badge } from "@/components/ui/badge";
import { useRealtimeStore } from "@/lib/hub/socket";

export function RealtimeBadge() {
  const connected = useRealtimeStore((s) => s.connected);
  return (
    <Badge variant="outline" className="gap-1.5" title="Kết nối Socket.IO tới hub-api">
      <span className={`size-2 rounded-full ${connected ? "bg-emerald-500" : "bg-rose-500"}`} />
      <span className="hidden sm:inline">{connected ? "Realtime" : "Mất kết nối"}</span>
    </Badge>
  );
}
