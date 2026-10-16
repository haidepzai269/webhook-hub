import { AccountTopBar } from "@/components/admin/account-menu";
import { PageHeaderSkeleton } from "@/components/admin/skeletons";
import { Skeleton } from "@/components/ui/skeleton";

import { GridSkeleton } from "./_components/projects-home";

/** ADR-238: `/projects` — cùng khung với trang thật (thanh trên + tiêu đề + ô tìm + lưới thẻ) để không nhảy khi thay vào. */
export default function ProjectsLoading() {
  return (
    <div className="min-h-screen bg-background">
      <AccountTopBar />
      <main className="mx-auto w-full max-w-6xl px-4 py-8 md:px-6">
        <PageHeaderSkeleton actions />
        <div className="mb-4">
          <Skeleton className="h-9 w-full sm:max-w-xs" />
        </div>
        <GridSkeleton />
      </main>
    </div>
  );
}
