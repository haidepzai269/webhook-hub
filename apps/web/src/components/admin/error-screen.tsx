"use client";

import { useEffect } from "react";

import { TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { TranslateFn } from "@/lib/i18n/dictionary";
import { reportClientError } from "@/lib/sentry/report";

import { StatusScreen } from "./status-screen";

/**
 * Màn lỗi dùng chung cho `error.tsx` và `global-error.tsx` (ADR-264). Nhận `t` qua prop vì `global-error` thay cả root layout
 * (không có provider preference). Báo lỗi qua `reportClientError` — cửa duy nhất tới Sentry (no-op khi không có DSN).
 * `error.digest` là hash của Next (nối với log server), không phải nội dung lỗi nên an toàn để hiện.
 */
export function ErrorScreen({ error, reset, t, className }: { error: Error & { digest?: string }; reset: () => void; t: TranslateFn; className?: string }) {
  useEffect(() => {
    reportClientError(error);
  }, [error]);
  return (
    <StatusScreen
      icon={TriangleAlert}
      title={t("boundary.title")}
      className={className}
      description={
        <>
          <p>{t("boundary.desc")}</p>
          {error.digest && <p className="mt-2 font-mono text-xs">{t("boundary.ref", { digest: error.digest })}</p>}
        </>
      }
    >
      <Button className="min-h-10" onClick={reset}>
        {t("boundary.retry")}
      </Button>
      <Button variant="outline" className="min-h-10" onClick={() => window.location.reload()}>
        {t("boundary.reload")}
      </Button>
    </StatusScreen>
  );
}
