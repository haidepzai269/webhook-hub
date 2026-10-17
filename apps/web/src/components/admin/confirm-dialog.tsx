"use client";

import { LoaderCircle } from "lucide-react";
import { type ReactNode, useCallback, useRef, useState } from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogBody,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useT } from "@/lib/i18n/use-t";

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  /** Mặc định `common.confirm`; nút xoá/thu hồi truyền nhãn riêng ("Xoá", "Thu hồi"). */
  confirmLabel?: ReactNode;
  /** Mặc định `common.cancel`. */
  cancelLabel?: ReactNode;
  /** Thao tác không hoàn tác được (xoá, thu hồi) -> nút xác nhận đỏ. */
  destructive?: boolean;
  /** Đang chạy mutation: khoá hai nút, hiện spinner, chặn đóng bằng Esc/click ngoài. */
  pending?: boolean;
  /** Nội dung thêm dưới mô tả (ô nhập xác nhận, cảnh báo…). */
  children?: ReactNode;
  /** Hộp KHÔNG tự đóng sau khi xác nhận — nơi gọi đóng khi mutation xong (giữ hộp mở nếu lỗi). */
  onConfirm: () => void | Promise<void>;
  confirmDisabled?: boolean;
  /** Hộp rộng hơn (`md`) khi footer có nút phụ / mô tả dài. */
  size?: "default" | "sm" | "md";
  /** Nút phụ đặt giữa Huỷ và nút xác nhận (vd "Ngắt kết nối" cạnh "Xoá"). */
  extraActions?: ReactNode;
}

/** Hộp xác nhận dùng chung (thay `window.confirm` và AlertDialog chép tay). */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  cancelLabel,
  destructive,
  pending,
  children,
  onConfirm,
  confirmDisabled,
  size,
  extraActions,
}: ConfirmDialogProps) {
  const t = useT();
  return (
    <AlertDialog open={open} onOpenChange={(o) => !(pending && !o) && onOpenChange(o)}>
      <AlertDialogContent size={size} {...(description ? {} : { "aria-describedby": undefined })}>
        <AlertDialogBody>
          <AlertDialogHeader>
            <AlertDialogTitle>{title}</AlertDialogTitle>
            {description ? (
              <AlertDialogDescription asChild>
                <div>{description}</div>
              </AlertDialogDescription>
            ) : null}
          </AlertDialogHeader>
          {children}
        </AlertDialogBody>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>{cancelLabel ?? t("common.cancel")}</AlertDialogCancel>
          {extraActions}
          <AlertDialogAction
            variant={destructive ? "destructive" : "default"}
            disabled={pending === true || confirmDisabled === true}
            onClick={(e) => {
              e.preventDefault();
              void onConfirm();
            }}
          >
            {pending ? <LoaderCircle className="size-4 animate-spin" aria-hidden /> : null}
            {confirmLabel ?? t("common.confirm")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export interface ConfirmOptions {
  title: ReactNode;
  description?: ReactNode;
  confirmLabel?: ReactNode;
  cancelLabel?: ReactNode;
  destructive?: boolean;
}

/**
 * Thay `window.confirm` kiểu Promise: `const { confirm, confirmDialog } = useConfirm();`
 * rồi `if (!(await confirm({ title, destructive: true }))) return;` — nhớ render `{confirmDialog}` trong JSX.
 */
export function useConfirm() {
  const [opts, setOpts] = useState<ConfirmOptions | null>(null);
  const resolver = useRef<((ok: boolean) => void) | null>(null);

  const settle = useCallback((ok: boolean) => {
    resolver.current?.(ok);
    resolver.current = null;
    setOpts(null);
  }, []);

  const confirm = useCallback((o: ConfirmOptions) => {
    resolver.current?.(false); // hộp cũ còn mở -> coi là huỷ
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
      setOpts(o);
    });
  }, []);

  const confirmDialog = (
    <ConfirmDialog
      open={opts !== null}
      onOpenChange={(o) => !o && settle(false)}
      title={opts?.title}
      description={opts?.description}
      confirmLabel={opts?.confirmLabel}
      cancelLabel={opts?.cancelLabel}
      destructive={opts?.destructive}
      onConfirm={() => settle(true)}
    />
  );

  return { confirm, confirmDialog };
}
