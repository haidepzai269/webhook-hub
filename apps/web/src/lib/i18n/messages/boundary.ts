import { defineMessages } from "../locales";

/** Màn lỗi toàn trang (`global-error.tsx`, `error.tsx` — ADR-264): dùng khuôn StatusScreen như 404 (ADR-261). */
export const boundary = defineMessages("boundary", {
  vi: {
    "boundary.title": "Có lỗi xảy ra",
    "boundary.desc": "Trang gặp sự cố ngoài ý muốn. Lỗi đã được ghi lại để chúng tôi xử lý. Bạn có thể thử lại hoặc tải lại trang.",
    "boundary.retry": "Thử lại",
    "boundary.reload": "Tải lại trang",
    "boundary.ref": "Mã tham chiếu: {digest}",
  },
  en: {
    "boundary.title": "Something went wrong",
    "boundary.desc": "The page hit an unexpected problem. It has been recorded so we can look into it. You can try again or reload the page.",
    "boundary.retry": "Try again",
    "boundary.reload": "Reload page",
    "boundary.ref": "Reference: {digest}",
  },
});
