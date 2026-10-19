import type { MobileCardSpec } from "./responsive-table-logic";

/**
 * ADR-261 (pha 2, tầng B): khai báo thẻ mobile của các bảng cấu hình. Tách khỏi `page.tsx` vì Next không cho trang export
 * thứ khác ngoài default; id cột phải khớp bảng (khoá bởi `mobile-card-specs.spec.ts`).
 */

/** ADR-261 (pha 2): thẻ nguồn dưới `md` — tên + trạng thái / nhà cung cấp, "Giữ lâu" / nhịp sự kiện, URL, ngày tạo / nút thao tác. */
export const SOURCE_MOBILE_CARD: MobileCardSpec = {
  title: "name",
  badge: "isActive",
  meta: ["provider", "keepLonger", "insight", "webhookUrl", "createdAt"],
  wide: ["insight", "webhookUrl"],
  actions: "connection",
};

/** ADR-261 (pha 2): thẻ đích dưới `md` — tên + kiểu / xác minh, mạch / nhịp, giới hạn, ký / nút xem·xoá. */
export const DESTINATION_MOBILE_CARD: MobileCardSpec = {
  title: "name",
  badge: "type",
  meta: ["verification", "circuit", "insight", "rateLimit", "signing", "createdAt"],
  wide: ["verification", "insight"],
  actions: "actions",
};

/** ADR-261 (pha 2): thẻ đăng ký dưới `md` — tên + trạng thái / kiểu sự kiện, đích, mẫu, ngày tạo / nút Tắt·Xoá. */
export const SUBSCRIPTION_MOBILE_CARD: MobileCardSpec = {
  title: "name",
  badge: "isActive",
  meta: ["eventTypes", "destination", "template", "createdAt"],
  wide: ["eventTypes", "template"],
  actions: "actions",
};

/** ADR-261 (pha 2): thẻ nhật ký dưới `md` — hành động làm tiêu đề; thời gian, người làm / đối tượng, lý do. */
export const AUDIT_MOBILE_CARD: MobileCardSpec = {
  title: "action",
  meta: ["createdAt", "actor", "entity", "reason"],
  wide: ["entity", "reason"],
};

/** ADR-261 (pha 2): thẻ dự án dưới `md` — tên làm tiêu đề, môi trường làm huy hiệu; slug, vai trò, dung lượng, hạn mức / nút Chọn. */
export const PROJECT_MOBILE_CARD: MobileCardSpec = {
  title: "name",
  badge: "environment",
  meta: ["slug", "role", "usage", "quota"],
  wide: ["usage", "quota"],
  actions: "actions",
};
