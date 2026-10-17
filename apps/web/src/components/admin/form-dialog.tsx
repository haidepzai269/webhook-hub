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
 * - `footer`: thay hai nút mặc định (vd bước "secret chỉ hiện một lần" chỉ có nút Đóng).
 * - `submitDisabled`: khoá nút gửi khi form chưa hợp lệ; `submittingLabel`: chữ khi đang gửi (mặc định "Đang lưu…").
 */
export function FormDialog({
  open,
  onOpenChange,
  title,
  description,
  formId,
  submitting,
  submitLabel,
  submittingLabel,
  submitDisabled = false,
  footer,
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
  submittingLabel?: string;
  submitDisabled?: boolean;
  footer?: ReactNode;
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
          {footer ?? (
            <>
              <Button type="button" variant="outline" disabled={submitting} onClick={() => onOpenChange(false)}>
                {t("common.cancel")}
              </Button>
              <Button type="submit" form={formId} disabled={submitting || submitDisabled}>
                {submitting ? (submittingLabel ?? t("common.saving")) : (submitLabel ?? t("common.create"))}
              </Button>
            </>
          )}
        </DialogFooter>
      </AdminDialogContent>
    </Dialog>
  );
}
