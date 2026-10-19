"use client";

import { ErrorScreen } from "@/components/admin/error-screen";
import { useT } from "@/lib/i18n/use-t";

/** Error boundary của nhóm (admin) (ADR-264): lỗi render trong trang -> màn StatusScreen + báo Sentry (nếu bật). */
export default function AdminError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <ErrorScreen error={error} reset={reset} t={useT()} />;
}
