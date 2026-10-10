"use client";

import { useState } from "react";

import { Check, Copy } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";

export function CopyButton({ value, label = "Sao chép" }: { value: string; label?: string }) {
  const [done, setDone] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setDone(true);
      setTimeout(() => setDone(false), 1500);
    } catch {
      toast.error("Trình duyệt chặn clipboard (cần HTTPS hoặc localhost).");
    }
  };
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      onClick={(e) => {
        e.stopPropagation();
        void copy();
      }}
      aria-label={label}
      title={label}
    >
      {done ? <Check /> : <Copy />}
    </Button>
  );
}

export function JsonBlock({ value, maxHeight = "24rem" }: { value: unknown; maxHeight?: string }) {
  const text = JSON.stringify(value, null, 2) ?? "null";
  return (
    <div className="relative rounded-md border bg-muted/40">
      <div className="absolute top-1 right-1">
        <CopyButton value={text} label="Sao chép JSON" />
      </div>
      <pre className="overflow-auto p-3 pr-9 font-mono text-xs leading-relaxed" style={{ maxHeight }}>
        {text}
      </pre>
    </div>
  );
}
