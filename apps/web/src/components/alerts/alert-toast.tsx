"use client";

import { X } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import type { AlertSeverity } from "@/lib/alerts/types";

import { ProjectChip, SEVERITY_COLOR, SeverityIcon } from "./alert-ui";

/**
 * CB4 §8.3: toast cảnh báo TUỲ BIẾN (không dùng toast mặc định của sonner) — icon mức, chip project, tiêu đề, MỘT dòng
 * mô tả, nút "Xem". warning tự đóng sau 6s, critical (project khác) dính tới khi đóng; rê chuột thì sonner dừng đếm;
 * tối đa 3 toast cùng lúc (`visibleToasts` của Toaster). Chữ đã dịch sẵn lúc tạo — component không cần context React.
 */
export interface AlertToastProps {
  toastId: string | number;
  severity: AlertSeverity;
  severityLabel: string;
  projectName: string;
  title: string;
  description: string;
  viewLabel: string;
  dismissLabel: string;
  onView: () => void;
}

function AlertToast(p: AlertToastProps) {
  return (
    <div
      role="status"
      className="flex w-[356px] max-w-[calc(100vw-2rem)] gap-3 rounded-lg border border-border border-l-4 bg-popover p-3 pr-2 text-popover-foreground shadow-lg"
      style={{ borderLeftColor: SEVERITY_COLOR[p.severity] }}
    >
      <SeverityIcon severity={p.severity} className="mt-0.5" />
      <div className="min-w-0 flex-1">
        <div className="mb-1 flex min-w-0 items-center gap-1.5">
          <ProjectChip name={p.projectName} />
          <span className="truncate text-[11px] text-muted-foreground">{p.severityLabel}</span>
        </div>
        <p className="line-clamp-2 font-medium text-sm leading-5">{p.title}</p>
        {p.description && (
          <p className="mt-0.5 truncate text-muted-foreground text-xs" title={p.description}>
            {p.description}
          </p>
        )}
        <div className="mt-2">
          <Button
            size="xs"
            variant="outline"
            onClick={() => {
              toast.dismiss(p.toastId);
              p.onView();
            }}
          >
            {p.viewLabel}
          </Button>
        </div>
      </div>
      <Button
        size="icon-xs"
        variant="ghost"
        className="-mt-1 shrink-0 text-muted-foreground"
        aria-label={p.dismissLabel}
        onClick={() => toast.dismiss(p.toastId)}
      >
        <X />
      </Button>
    </div>
  );
}

/** Hiện toast cho một cảnh báo (id ổn định theo cảnh báo — gọi hai lần không ra hai toast). */
export function showAlertToast(alertId: string, durationMs: number, props: Omit<AlertToastProps, "toastId">) {
  const id = `alert-${alertId}`;
  toast.custom((tid) => <AlertToast {...props} toastId={tid} />, { id, duration: durationMs });
}
