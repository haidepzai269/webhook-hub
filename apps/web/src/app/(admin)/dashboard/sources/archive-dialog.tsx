"use client";

import { useRef } from "react";

import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";

import { ConfirmDialog } from "@/components/admin/confirm-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { HubApiError, hubFetch } from "@/lib/hub/client";
import { useFlowArchive } from "@/lib/hub/flow-queries";
import { archiveWarningMode, errorTextOf } from "@/lib/hub/ui-logic";
import { useT } from "@/lib/i18n/use-t";

/**
 * Lưu trữ nguồn từ trang Nguồn (ADR-260). Gọi lại `POST /sources/:id/archive` của ADR-161 qua `useFlowArchive`
 * (cùng route với "Xoá" trên bản đồ luồng) — không logic mới phía backend. Archive KHÔNG gỡ URL ở provider: nguồn có
 * kết nối do hub quản lý thì nhắc "Ngắt" trước; nguồn tạo tay thì nhắc gỡ URL ở dashboard provider.
 */
export function ArchiveSourceDialog({
  source,
  onClose,
  onOpenConnection,
}: {
  source: { id: string; name: string } | null;
  onClose: () => void;
  onOpenConnection: (id: string) => void;
}) {
  const t = useT();
  const archive = useFlowArchive();
  const id = source?.id ?? null;
  // Cùng queryKey với ConnectionDialog -> dùng chung cache; 404 = nguồn tạo tay.
  const conn = useQuery({
    queryKey: ["connection", id],
    queryFn: () =>
      hubFetch<{ status: string }>(`/api/v1/sources/${encodeURIComponent(id ?? "")}/connection`).catch((e: unknown) => {
        if (e instanceof HubApiError && e.status === 404) return null;
        throw e;
      }),
    enabled: Boolean(id),
  });
  const mode = archiveWarningMode(conn.data, { isPending: conn.isPending, isError: conn.isError });
  const managed = mode === "managed";
  // Giữ tên cuối cùng: sau khi lưu trữ `source` về null trong lúc hộp còn đang đóng -> tiêu đề không nháy “”.
  const lastName = useRef("");
  if (source) lastName.current = source.name;

  const remove = () => {
    if (!source) return;
    archive.mutate(
      { kind: "source", id: source.id },
      {
        onSuccess: () => {
          toast.success(t("page.sources.archive.done", { name: source.name }));
          onClose();
        },
        onError: (e) => toast.error(errorTextOf(e, t)),
      },
    );
  };

  return (
    <ConfirmDialog
      open={Boolean(source)}
      onOpenChange={(o) => !o && !archive.isPending && onClose()}
      size="md"
      title={t("page.sources.archive.title", { name: source?.name ?? lastName.current })}
      description={
        <div className="space-y-2">
          <p>{t("page.sources.archive.effect")}</p>
          <p>
            {t("page.sources.archive.history")} {t("page.sources.archive.cascade")} {t("page.sources.archive.irreversible")}
          </p>
          <Alert variant="warning">
            <AlertDescription>
              <p>
                {mode === "managed"
                  ? t("page.sources.archive.managed")
                  : mode === "manual"
                    ? t("page.sources.archive.manual")
                    : mode === "error"
                      ? t("page.sources.archive.error")
                      : t("page.sources.archive.checking")}
              </p>
            </AlertDescription>
          </Alert>
        </div>
      }
      pending={archive.isPending}
      confirmDisabled={mode === "pending" || mode === "error"}
      destructive
      confirmLabel={archive.isPending ? t("page.sources.archive.confirming") : t("page.sources.archive.confirm")}
      onConfirm={remove}
      extraActions={
        (managed || mode === "error") && source ? (
          <Button
            variant="outline"
            disabled={archive.isPending}
            onClick={() => {
              onClose();
              onOpenConnection(source.id);
            }}
          >
            {t("page.sources.archive.managed-open")}
          </Button>
        ) : undefined
      }
    />
  );
}
