import type { ReactNode } from "react";

import { ScreenGuard } from "@/components/admin/screen-guard";

/** Tầng C (ADR-261): form cài đặt dự án một cột, đủ từ 768px (tablet dọc). */
export default function Layout({ children }: Readonly<{ children: ReactNode }>) {
  return <ScreenGuard minWidth={768}>{children}</ScreenGuard>;
}
