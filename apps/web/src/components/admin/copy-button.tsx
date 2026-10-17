"use client";

import { useState } from "react";

import { Check, Copy } from "lucide-react";
import { toast } from "sonner";

import { useT } from "@/lib/i18n/use-t";
import { IconButton } from "@/components/admin/icon-button";

export function CopyButton({ value, label }: { value: string; label?: string }) {
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

export function JsonBlock({ value, maxHeight = "24rem" }: { value: unknown; maxHeight?: string }) {
  const t = useT();
  const text = JSON.stringify(value, null, 2) ?? "null";
  return (
    <div className="relative rounded-md border bg-muted/40">
      <div className="absolute top-1 right-1">
        <CopyButton value={text} label={t("admin.copy.json")} />
      </div>
      <pre className="overflow-auto p-3 pr-9 font-mono text-xs leading-relaxed" style={{ maxHeight }}>
        {text}
      </pre>
    </div>
  );
}
