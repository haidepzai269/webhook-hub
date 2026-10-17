"use client";

import { useState } from "react";

import { Check, Copy } from "lucide-react";
import { toast } from "sonner";

import { useT } from "@/lib/i18n/use-t";
import { Button } from "@/components/ui/button";
import { JsonViewer } from "@/components/flow/json-viewer";
import { IconButton } from "@/components/admin/icon-button";

/**
 * Nút sao chép MỘT kiểu (ADR-247): `variant="icon"` (mặc định) là IconButton nhỏ có tooltip — dùng trong ô bảng/góc khối;
 * `variant="labeled"` là nút outline có chữ ("Sao chép" -> "Đã chép") — dùng khi nút là hành động chính (hộp secret một lần).
 * `label` là tên hành động (tooltip / chữ nút).
 */
export function CopyButton({
  value,
  label,
  variant = "icon",
}: {
  value: string;
  label?: string;
  variant?: "icon" | "labeled";
}) {
  const t = useT();
  const text = label ?? t("common.copy");
  const [done, setDone] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setDone(true);
      setTimeout(() => setDone(false), 1500);
    } catch {
      toast.error(t("admin.copy.blocked"));
    }
  };
  if (variant === "labeled") {
    return (
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={(e) => {
          e.stopPropagation();
          void copy();
        }}
      >
        {done ? <Check /> : <Copy />}
        {done ? t("common.copied") : text}
      </Button>
    );
  }
  return (
    <IconButton
      size="icon-xs"
      onClick={(e) => {
        e.stopPropagation();
        void copy();
      }}
      label={text}
      icon={done ? <Check /> : <Copy />}
    />
  );
}

/**
 * Khối JSON MỘT kiểu (ADR-247): `JsonViewer` (tô cú pháp, gập/mở, số dòng) + nút chép JSON ở góc. Event-sheet, playground và
 * thẻ chi tiết hành trình đều đi qua đây/`JsonViewer` — không còn `<pre>` riêng.
 */
export function JsonBlock({ value, maxHeight = "24rem" }: { value: unknown; maxHeight?: string }) {
  const t = useT();
  const text = JSON.stringify(value, null, 2) ?? "null";
  return (
    <div className="relative">
      <div className="absolute top-1 right-1 z-10 rounded-md bg-background/80">
        <CopyButton value={text} label={t("admin.copy.json")} />
      </div>
      <JsonViewer value={value} maxHeight={maxHeight} />
    </div>
  );
}
