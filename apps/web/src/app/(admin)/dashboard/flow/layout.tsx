import type { ReactNode } from "react";

import { ScreenGuard } from "@/components/admin/screen-guard";

/** Tầng C (ADR-261): canvas cấu hình luồng (kéo thả), cần ≥ 1024px. */
export default function Layout({ children }: Readonly<{ children: ReactNode }>) {
  return <ScreenGuard minWidth={1024}>{children}</ScreenGuard>;
}
