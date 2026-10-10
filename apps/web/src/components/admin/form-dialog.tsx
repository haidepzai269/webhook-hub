"use client";

import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/** Khung Dialog chung cho các form "Tạo mới" — form thật (RHF + Zod) do từng trang truyền vào. */
export function FormDialog({
  open,
  onOpenChange,
  title,
  description,
  formId,
  submitting,
  submitLabel = "Tạo",
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  formId: string;
  submitting: boolean;
  submitLabel?: string;
  children: ReactNode;
}) {
  return (
    <Dialog open={open} onOpenChange={(o) => !submitting && onOpenChange(o)}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        {children}
        <DialogFooter>
          <Button type="button" variant="outline" disabled={submitting} onClick={() => onOpenChange(false)}>
            Huỷ
          </Button>
          <Button type="submit" form={formId} disabled={submitting}>
            {submitting ? "Đang lưu…" : submitLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
