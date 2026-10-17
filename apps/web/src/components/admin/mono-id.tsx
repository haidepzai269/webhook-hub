"use client";

import { cn } from "cn";

import { CopyButton } from "@/components/admin/copy-button";
import { CellTooltip } from "@/components/ui/cell-tooltip";
import { shortId } from "@/lib/hub/format";

/**
 * Mã định danh (uuid, correlation id…) MỘT kiểu (ADR-246): font mono, rút gọn `n` ký tự (mặc định 8) — tooltip luôn hiện
 * đủ mã — kèm nút sao chép tuỳ chọn. `n="full"`: hiện đủ, cắt bằng CSS (truncate) và tooltip chỉ mở khi bị cắt.
 * Thay `id.slice(0, 8)` / `title={id}` / `<span font-mono>` + `CopyButton` tự ráp.
 */
export function MonoId({
  id,
  n = 8,
  copy = false,
  className,
}: {
  id: string;
  n?: number | "full";
  copy?: boolean;
  className?: string;
}) {
  const full = n === "full";
  return (
    <span className={cn("inline-flex min-w-0 max-w-full items-center gap-1 align-middle", className)}>
      <CellTooltip text={id} always={!full}>
        <span data-cell-text className={cn("font-mono text-xs", full ? "truncate" : "whitespace-nowrap")}>
          {full ? id : shortId(id, n)}
        </span>
      </CellTooltip>
      {copy && <CopyButton value={id} />}
    </span>
  );
}
