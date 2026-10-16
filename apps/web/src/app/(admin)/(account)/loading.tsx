import { PageSkeleton } from "@/components/admin/skeletons";

/** ADR-238: chuyển giữa `/alerts` ⇄ `/settings` — thanh trên tầng tài khoản giữ nguyên, nội dung hiện khung chờ. */
export default function AccountLoading() {
  return <PageSkeleton />;
}
