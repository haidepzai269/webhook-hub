"use client";

import { useAuthBooting } from "@/components/admin/auth-guard";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useRealtimeStore } from "@/lib/hub/socket";
import type { RealtimeStatus } from "@/lib/hub/realtime-connector";
import { useT } from "@/lib/i18n/use-t";

const DOT: Record<RealtimeStatus, string> = {
  connected: "bg-emerald-500",
  // ADR-243: đang nối/nối lại (server có thể đang khởi động) — vàng nhạt, nhấp nháy nhẹ (tắt khi prefers-reduced-motion).
  connecting: "bg-amber-300 motion-safe:animate-pulse",
  disconnected: "bg-rose-500",
};

export function RealtimeBadge() {
  const t = useT();
  const status = useRealtimeStore((s) => s.status);
  const booting = useAuthBooting();
  // ADR-238: socket chỉ nối sau khi phiên xác nhận — lúc khởi động đừng báo đỏ "Mất kết nối". Cùng cỡ Badge (h-5).
  if (booting) return <Skeleton className="h-5 w-7 rounded-full sm:w-28" />;
  const label = t(`admin.realtime.${status}`);
  const hint = t(`admin.realtime.hint.${status}`);
  return (
    <Badge
      variant="outline"
      className="gap-1.5"
      title={`${t("admin.realtime.title")} — ${hint}`}
      role="status"
      aria-live="polite"
      data-status={status}
    >
      <span className={`size-2 rounded-full ${DOT[status]}`} aria-hidden />
      {/* Màn hẹp chỉ còn chấm màu: nhãn vẫn đọc được bằng trình đọc màn hình (sr-only), gợi ý ở title + sr-only. */}
      <span className="sr-only sm:not-sr-only">{label}</span>
      <span className="sr-only">{hint}</span>
    </Badge>
  );
}
