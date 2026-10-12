import { defineMessages } from "../locales";

/**
 * Trạng thái lượt giao (DeliveryStatus của hub) hiển thị cho người đọc. Mã gốc (PENDING, DEAD…) vẫn là định danh kỹ
 * thuật — badge hiện nhãn dịch và đặt mã gốc ở `title`. Khoá `status.delivery.<mã viết thường>`.
 */
export const status = defineMessages("status", {
  vi: {
    "status.delivery.pending": "Chờ gửi",
    "status.delivery.delivering": "Đang gửi",
    "status.delivery.retrying": "Chờ thử lại",
    "status.delivery.succeeded": "Đã giao",
    "status.delivery.dead": "Hỏng hẳn",
    "status.delivery.none": "— chưa phân phát",
  },
  en: {
    "status.delivery.pending": "Pending",
    "status.delivery.delivering": "Delivering",
    "status.delivery.retrying": "Retrying",
    "status.delivery.succeeded": "Delivered",
    "status.delivery.dead": "Dead",
    "status.delivery.none": "— not fanned out",
  },
});
