import type { ReactNode } from "react";

import { ScreenGuard } from "@/components/admin/screen-guard";

/** Tầng C (ADR-261): form cài đặt email cảnh báo, đủ từ 768px. */
export default function Layout({ children }: Readonly<{ children: ReactNode }>) {
  return <ScreenGuard minWidth={768}>{children}</ScreenGuard>;
}
