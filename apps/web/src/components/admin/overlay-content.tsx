"use client";

import type { ComponentProps } from "react";

import { DialogContent } from "@/components/ui/dialog";
import { SheetContent } from "@/components/ui/sheet";
import { useT } from "@/lib/i18n/use-t";

/**
 * DialogContent / SheetContent của admin với nhãn nút đóng ĐÃ DỊCH ("Đóng" / "Close"). Primitive ở components/ui giữ mặc
 * định "Close" và không phụ thuộc i18n (Shop dùng chung, không có provider ngôn ngữ của admin).
 */
export function AdminDialogContent(props: ComponentProps<typeof DialogContent>) {
  const t = useT();
  return <DialogContent closeLabel={t("common.close")} {...props} />;
}

export function AdminSheetContent(props: ComponentProps<typeof SheetContent>) {
  const t = useT();
  return <SheetContent closeLabel={t("common.close")} {...props} />;
}
