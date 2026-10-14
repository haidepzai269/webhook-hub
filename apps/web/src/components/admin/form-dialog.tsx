"use client";

import type { ReactNode } from "react";

import { AdminDialogContent } from "@/components/admin/overlay-content";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { OverlaySize } from "@/components/ui/overlay-size";
import { useT } from "@/lib/i18n/use-t";

/**
 * Khung Dialog chung cho các form "Tạo mới" — form thật (RHF + Zod) do từng trang truyền vào. Tiêu đề và nút Huỷ/Tạo
 * đứng yên, form cuộn trong DialogBody (UI-MS). `size` theo bộ cỡ chung (mặc định md).
 */
export function FormDialog({
  open,
  onOpenChange,
  title,
  description,
  formId,
  submitting,
  submitLabel,
  size = "md",
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  formId: string;
  submitting: boolean;
  submitLabel?: string;
  size?: OverlaySize;
  children: ReactNode;
}) {
  const t = useT();
  return (
    <Dialog open={open} onOpenChange={(o) => !submitting && onOpenChange(o)}>
      <AdminDialogContent size={size}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        <DialogBody>{children}</DialogBody>
        <DialogFooter>
          <Button type="button" variant="outline" disabled={submitting} onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" form={formId} disabled={submitting}>
            {submitting ? t("common.saving") : (submitLabel ?? t("common.create"))}
          </Button>
        </DialogFooter>
      </AdminDialogContent>
    </Dialog>
  );
}
