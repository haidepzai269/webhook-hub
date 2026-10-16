import { PageSkeleton } from "@/components/admin/skeletons";

/** ADR-238: chuyển trang trong dashboard — khung sidebar/thanh trên giữ nguyên (layout), vùng nội dung hiện khung chờ. */
export default function DashboardLoading() {
  return <PageSkeleton />;
}
