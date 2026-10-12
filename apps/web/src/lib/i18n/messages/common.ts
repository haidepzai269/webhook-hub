import { defineMessages } from "../locales";

/** Từ dùng chung nhiều nơi (chế độ sáng/tối, tên ngôn ngữ; sau này: Lưu, Huỷ, Xoá…). */
export const common = defineMessages("common", {
  vi: {
    "common.theme.light": "Sáng",
    "common.theme.dark": "Tối",
    "common.theme.system": "Theo hệ thống",
    // Tên ngôn ngữ viết bằng chính ngôn ngữ đó — người không đọc được UI hiện tại vẫn nhận ra.
    "common.language.vi": "Tiếng Việt",
    "common.language.en": "English",
    // Phân trang Trước/Sau theo cursor (components/admin/cursor-pager.tsx, ADR-163).
    "common.pager.label": "Phân trang",
    "common.pager.newest": "Mới nhất",
    "common.pager.prev": "Trước",
    "common.pager.next": "Sau",
    "common.pager.loading": "đang tải…",
    "common.pager.at-newest": "Trang mới nhất",
    "common.pager.older": "Trang cũ hơn",
    "common.filters.clear": "Bỏ lọc",
  },
  en: {
    "common.theme.light": "Light",
    "common.theme.dark": "Dark",
    "common.theme.system": "System",
    "common.language.vi": "Tiếng Việt",
    "common.language.en": "English",
    "common.pager.label": "Pagination",
    "common.pager.newest": "Newest",
    "common.pager.prev": "Previous",
    "common.pager.next": "Next",
    "common.pager.loading": "loading…",
    "common.pager.at-newest": "Newest page",
    "common.pager.older": "Older page",
    "common.filters.clear": "Clear filters",
  },
});
