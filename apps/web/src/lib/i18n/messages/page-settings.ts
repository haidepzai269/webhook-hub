import { defineMessages } from "../locales";

/**
 * CB5 (SPEC-canh-bao-nhan-dinh §8.5): trang Cài đặt → mục "Cảnh báo" (chỉ operator). Tên luật dùng `alerts.rule.<luật>.name`
 * (chung với email); mô tả một câu của từng luật ở `page.settings.rule.<luật>` (chỉ trang này dùng).
 */
export const pageSettings = defineMessages("page.settings", {
  vi: {
    "page.settings.title": "Cài đặt",
    "page.settings.description": "Tuỳ chọn của riêng bạn, áp cho mọi dự án.",
    "page.settings.operator-only":
      "Hiện chưa có cài đặt nào cho tài khoản của bạn. Mục Cảnh báo chỉ dành cho người vận hành hub.",
    "page.settings.load-error": "Không tải được cài đặt.",
    "page.settings.saved": "Đã lưu.",

    "page.settings.alerts.title": "Cảnh báo",
    "page.settings.alerts.lead":
      "Chuông trong console luôn hiện mọi cảnh báo. Ở đây bạn chọn thêm cảnh báo nào được gửi về email.",
    "page.settings.alerts.email-toggle": "Gửi cảnh báo về email của tôi",
    "page.settings.alerts.email-to": "Gửi tới: {email} (email tài khoản, đổi ở hồ sơ đăng nhập)",
    "page.settings.alerts.locked.unverified":
      "Email {email} chưa được xác minh. Mở link xác minh trong hộp thư trước khi bật.",
    "page.settings.alerts.locked.no-email": "Tài khoản chưa có email nên không gửi được cảnh báo.",
    "page.settings.alerts.rules.title": "Loại cảnh báo được gửi email",
    "page.settings.alerts.rules.col.rule": "Cảnh báo",
    "page.settings.alerts.rules.col.severity": "Mức",
    "page.settings.alerts.rules.col.send": "Gửi email",
    "page.settings.alerts.preset.critical": "Chỉ nghiêm trọng",
    "page.settings.alerts.preset.all": "Tất cả",
    "page.settings.alerts.on-resolve": "Gửi email khi đã ổn trở lại",
    "page.settings.alerts.on-resolve-hint": "Chỉ gửi cho cảnh báo đã từng gửi email lúc mở.",
    "page.settings.alerts.muted.title": "Tắt email theo dự án",
    "page.settings.alerts.muted.hint": "Dự án được tắt vẫn hiện cảnh báo trong chuông, chỉ không gửi email.",
    "page.settings.alerts.muted.label": "Tắt email cho {name}",
    "page.settings.alerts.muted.empty": "Chưa có dự án nào.",
    "page.settings.alerts.test.button": "Gửi email thử",
    "page.settings.alerts.test.sent": "Đã gửi email thử tới {email}. Còn {remaining} lần trong giờ này.",
    "page.settings.alerts.test.note":
      "Tối đa {cap} email mỗi giờ, phần vượt được gộp vào email kế tiếp. Gửi thử tối đa {perHour} lần mỗi giờ.",

    "page.settings.rule.destination-auth-rejected":
      "Bên nhận trả 401/403 liên tiếp: sự kiện bị DEAD ngay vì lỗi này không được thử lại.",
    "page.settings.rule.destination-client-error": "Bên nhận từ chối nội dung (4xx khác) nhiều lần liên tiếp.",
    "page.settings.rule.destination-failing":
      "Từ một nửa số lần gửi trong 15 phút thất bại vì lỗi 5xx, hết giờ hoặc mạng; hub vẫn thử lại.",
    "page.settings.rule.destination-circuit-open": "Hub tạm ngưng gửi tới một đích để bảo vệ nó.",
    "page.settings.rule.delivery-dead-spike": "Từ 10 sự kiện ngừng thử trong một giờ ở một dự án.",
    "page.settings.rule.source-signature-failing": "Nhiều yêu cầu tới một nguồn bị từ chối vì chữ ký sai.",
    "page.settings.rule.source-connection-broken": "Kết nối với nhà cung cấp bị lỗi, bị gỡ hoặc bị kẹt.",
    "page.settings.rule.source-silent": "Một nguồn vốn đều đặn bỗng không gửi gì lâu hơn bình thường nhiều lần.",
    "page.settings.rule.normalize-backlog": "Có sự kiện thô đã nhận nhưng quá 10 phút chưa được chuẩn hoá.",
  },
  en: {
    "page.settings.title": "Settings",
    "page.settings.description": "Your own preferences, applied across all projects.",
    "page.settings.operator-only":
      "There are no settings for your account yet. The Alerts section is for hub operators only.",
    "page.settings.load-error": "Could not load settings.",
    "page.settings.saved": "Saved.",

    "page.settings.alerts.title": "Alerts",
    "page.settings.alerts.lead":
      "The console bell always shows every alert. Here you choose which alerts are also emailed to you.",
    "page.settings.alerts.email-toggle": "Email alerts to me",
    "page.settings.alerts.email-to": "Sent to: {email} (your account email, change it in your sign-in profile)",
    "page.settings.alerts.locked.unverified":
      "The email {email} is not verified yet. Open the verification link in your inbox first.",
    "page.settings.alerts.locked.no-email": "Your account has no email address, so alerts cannot be emailed.",
    "page.settings.alerts.rules.title": "Alert types sent by email",
    "page.settings.alerts.rules.col.rule": "Alert",
    "page.settings.alerts.rules.col.severity": "Severity",
    "page.settings.alerts.rules.col.send": "Send email",
    "page.settings.alerts.preset.critical": "Critical only",
    "page.settings.alerts.preset.all": "All",
    "page.settings.alerts.on-resolve": "Email me when it is back to normal",
    "page.settings.alerts.on-resolve-hint": "Only for alerts that were emailed when they opened.",
    "page.settings.alerts.muted.title": "Mute email per project",
    "page.settings.alerts.muted.hint": "Muted projects still show alerts in the bell; they are just not emailed.",
    "page.settings.alerts.muted.label": "Mute email for {name}",
    "page.settings.alerts.muted.empty": "No projects yet.",
    "page.settings.alerts.test.button": "Send test email",
    "page.settings.alerts.test.sent": "Test email sent to {email}. {remaining} left this hour.",
    "page.settings.alerts.test.note":
      "At most {cap} emails per hour; the rest are rolled into the next email. Up to {perHour} test emails per hour.",

    "page.settings.rule.destination-auth-rejected":
      "The receiver answers 401/403 repeatedly: events go DEAD at once because this error is not retried.",
    "page.settings.rule.destination-client-error":
      "The receiver rejects the content (other 4xx) several times in a row.",
    "page.settings.rule.destination-failing":
      "Half or more of the attempts in 15 minutes fail with 5xx, timeouts or network errors; the hub keeps retrying.",
    "page.settings.rule.destination-circuit-open": "The hub paused sending to a destination to protect it.",
    "page.settings.rule.delivery-dead-spike": "10 or more events stopped retrying within an hour in one project.",
    "page.settings.rule.source-signature-failing": "Many requests to a source are rejected for an invalid signature.",
    "page.settings.rule.source-connection-broken": "The provider connection failed, was removed, or is stuck.",
    "page.settings.rule.source-silent": "A normally steady source has sent nothing for several times its usual gap.",
    "page.settings.rule.normalize-backlog": "Raw events were received but not normalized for over 10 minutes.",
  },
});
