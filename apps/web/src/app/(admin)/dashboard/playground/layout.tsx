import type { ReactNode } from "react";

import { ScreenGuard } from "@/components/admin/screen-guard";

/** Tầng C (ADR-261): form + khối JSON song song, cần ≥ 1024px. */
export default function Layout({ children }: Readonly<{ children: ReactNode }>) {
  return <ScreenGuard minWidth={1024}>{children}</ScreenGuard>;
}
