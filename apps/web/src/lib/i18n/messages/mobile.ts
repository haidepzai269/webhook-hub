import { defineMessages } from "../locales";

/** Giao diện điện thoại (ADR-261): nút menu, banner "nên dùng máy tính", danh sách chặng hành trình. */
export const mobile = defineMessages("mobile", {
  vi: {
    "mobile.nav.open": "Mở menu điều hướng",
    "mobile.journey.aria": "Các chặng của hành trình",
    "mobile.journey.branch": "Giao tới {name}",
    "mobile.journey.attempts": "{count} lần thử",
    "mobile.journey.open": "Xem chi tiết",
    "mobile.guard.title": "Xin lỗi, chưa hỗ trợ kích thước màn hình này",
    "mobile.guard.desc":
      "Trang cấu hình này cần màn hình rộng ít nhất {min}px để thao tác chính xác và an toàn. Mong bạn thông cảm.",
    "mobile.guard.width": "Chiều rộng màn hình hiện tại: {width}px (cần từ {min}px)",
    "mobile.guard.hint": "Bạn có thể xoay ngang điện thoại, hoặc mở trang này trên máy tính.",
    "mobile.guard.home": "Về Tổng quan",
    "mobile.guard.copy": "Sao chép liên kết",
    "mobile.guard.copied": "Đã sao chép liên kết — hãy mở trên máy tính để tiếp tục.",
    "mobile.guard.copy-failed": "Không sao chép được liên kết. Hãy chép từ thanh địa chỉ.",
    "mobile.guard.continue": "Vẫn tiếp tục",
    "mobile.notfound.title": "Không tìm thấy trang bạn cần",
    "mobile.notfound.desc": "Đường dẫn có thể đã đổi hoặc không còn tồn tại. Xin lỗi vì sự bất tiện này.",
  },
  en: {
    "mobile.nav.open": "Open navigation menu",
    "mobile.journey.aria": "Journey stages",
    "mobile.journey.branch": "Delivery to {name}",
    "mobile.journey.attempts": "{count} attempts",
    "mobile.journey.open": "View details",
    "mobile.guard.title": "Sorry, this screen size isn't supported yet",
    "mobile.guard.desc":
      "This configuration page needs a screen at least {min}px wide so you can work on it accurately and safely. Thank you for understanding.",
    "mobile.guard.width": "Current screen width: {width}px (needs {min}px or more)",
    "mobile.guard.hint": "Try rotating your phone to landscape, or open this page on a computer.",
    "mobile.guard.home": "Back to Overview",
    "mobile.guard.copy": "Copy link",
    "mobile.guard.copied": "Link copied — open it on a computer to continue.",
    "mobile.guard.copy-failed": "Couldn't copy the link. Copy it from the address bar.",
    "mobile.guard.continue": "Continue anyway",
    "mobile.notfound.title": "We couldn't find that page",
    "mobile.notfound.desc": "The link may have changed or no longer exists. Sorry for the trouble.",
  },
});
