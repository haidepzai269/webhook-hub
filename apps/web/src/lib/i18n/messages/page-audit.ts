import { defineMessages } from "../locales";

/** Trang Nhật ký thao tác (dashboard/audit). Tên hành động (`source.create`…) là định danh kỹ thuật — không dịch. */
export const pageAudit = defineMessages("page.audit", {
  vi: {
    "page.audit.title": "Nhật ký thao tác",
    "page.audit.description":
      "Ai đã làm gì, lúc nào, vì sao: phát lại, phát lại hàng loạt, chuẩn hoá lại, tạo/sửa/xoá nguồn, đích, đăng ký nhận.",
    "page.audit.col.time": "Thời gian",
    "page.audit.col.actor": "Người thực hiện",
    "page.audit.col.action": "Hành động",
    "page.audit.col.entity": "Đối tượng",
    "page.audit.col.reason": "Lý do",
    "page.audit.meta.count": "{count} mục",
    "page.audit.meta.fields": "sửa: {fields}",
    "page.audit.meta.generation": "→ thế hệ {generation}",
    "page.audit.filter.actor": "Người thực hiện",
    "page.audit.filter.actor-placeholder": "Người thực hiện (email…)",
    "page.audit.filter.action": "Hành động",
    "page.audit.filter.all-actions": "Mọi hành động",
    "page.audit.filter.entity-type": "Loại đối tượng",
    "page.audit.filter.all-entity-types": "Mọi loại đối tượng",
    "page.audit.search-placeholder": "Lọc trong trang này…",
    "page.audit.empty-filtered": "Không có thao tác nào khớp bộ lọc.",
    "page.audit.empty": "Chưa có hành động nào được ghi.",
  },
  en: {
    "page.audit.title": "Audit log",
    "page.audit.description":
      "Who did what, when and why: replays, bulk replays, re-normalization, creating/editing/deleting sources, destinations, subscriptions.",
    "page.audit.col.time": "Time",
    "page.audit.col.actor": "Actor",
    "page.audit.col.action": "Action",
    "page.audit.col.entity": "Entity",
    "page.audit.col.reason": "Reason",
    "page.audit.meta.count": "{count} items",
    "page.audit.meta.fields": "edited: {fields}",
    "page.audit.meta.generation": "→ generation {generation}",
    "page.audit.filter.actor": "Actor",
    "page.audit.filter.actor-placeholder": "Actor (email…)",
    "page.audit.filter.action": "Action",
    "page.audit.filter.all-actions": "All actions",
    "page.audit.filter.entity-type": "Entity type",
    "page.audit.filter.all-entity-types": "All entity types",
    "page.audit.search-placeholder": "Filter this page…",
    "page.audit.empty-filtered": "No actions match the filters.",
    "page.audit.empty": "No actions recorded yet.",
  },
});
