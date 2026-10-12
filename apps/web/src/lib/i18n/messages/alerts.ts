import { ALERT_TEXT } from "@hub/common/alerts/text";

import { defineMessages } from "../locales";

/**
 * CB4 (SPEC-canh-bao-nhan-dinh §4, §8): câu chữ cảnh báo — chuông, banner, toast, chi tiết. API chỉ trả `rule` + `facts`
 * (§7: câu chữ nằm ở i18n phía web). Khoá theo luật: `alerts.rule.<mã luật, '_' -> '-'>.<phần>` — mã luật có dấu chấm
 * (`destination.auth_rejected` -> `alerts.rule.destination.auth-rejected.title`), xem `lib/alerts/message.ts#ruleSegment`.
 * BB-1: không câu nào biết nghiệp vụ (đơn hàng, số tiền) — chỉ nguồn / đích / sự kiện / lượt giao.
 */
export const alerts = defineMessages("alerts", {
  vi: {
    // Câu của từng luật, mức, đối tượng, đơn vị, lý do đóng: DÙNG CHUNG với email (libs/common/src/alerts/text.ts, CB5).
    ...ALERT_TEXT.vi,

    // ---- hành động (deep link)
    "alerts.action.view-deliveries": "Xem lượt giao",
    "alerts.action.check-destination": "Kiểm tra lại đích",
    "alerts.action.open-dlq": "Mở hàng đợi lỗi",
    "alerts.action.view-rejected": "Xem yêu cầu bị từ chối",
    "alerts.action.open-sources": "Mở trang Nguồn",
    "alerts.action.view-source-events": "Xem sự kiện của nguồn",
    "alerts.action.renormalize": "Chuẩn hoá lại",

    // ---- chuông (§8.1)
    "alerts.bell.label": "Cảnh báo",
    "alerts.bell.aria": "Cảnh báo: {count} chưa xem",
    "alerts.bell.aria-none": "Cảnh báo: không có gì mới",
    "alerts.bell.subtitle": "{count} đang mở",
    "alerts.bell.ack-all": "Đánh dấu đã xem tất cả",
    "alerts.bell.view-all": "Xem tất cả",
    "alerts.bell.empty-title": "Mọi thứ đang ổn.",
    "alerts.bell.empty-body": "Hub sẽ báo ở đây khi có chuyện.",
    "alerts.bell.more": "+{count} cảnh báo khác trong dự án này",
    "alerts.bell.error": "Không tải được cảnh báo.",
    "alerts.bell.acked": "đã xem",
    "alerts.bell.ack-all-done": "Đã đánh dấu {count} cảnh báo là đã xem.",

    // ---- banner (§8.2)
    "alerts.banner.region": "Cảnh báo nghiêm trọng",
    "alerts.banner.ack": "Đã xem",
    "alerts.banner.more": "+{count} cảnh báo nghiêm trọng khác",
    "alerts.banner.resolved": "Đã ổn trở lại",

    // ---- toast (§8.3)
    "alerts.toast.view": "Xem",
    "alerts.toast.dismiss": "Đóng thông báo",
    "alerts.toast.region": "Cảnh báo",

    // ---- số liệu (facts) dạng bảng đọc được
    "alerts.fact.count": "Số lần",
    "alerts.fact.http-status": "Mã HTTP",
    "alerts.fact.closed-by-status": "Mã HTTP lúc ổn trở lại",
    "alerts.fact.since-at": "Từ lúc",
    "alerts.fact.last-attempt-at": "Lần thử cuối đã xét",
    "alerts.fact.last-match-at": "Lần lỗi cùng loại cuối",
    "alerts.fact.dead": "Sự kiện đã DEAD",
    "alerts.fact.total": "Tổng số",
    "alerts.fact.failed": "Thất bại",
    "alerts.fact.pct": "Tỉ lệ thất bại",
    "alerts.fact.circuit-state": "Trạng thái mạch bảo vệ",
    "alerts.fact.half-open-at": "Thử lại lúc",
    "alerts.fact.window-from": "Tính từ",
    "alerts.fact.status": "Trạng thái kết nối",
    "alerts.fact.provider-label": "Nhà cung cấp",
    "alerts.fact.last-error": "Lỗi gần nhất",
    "alerts.fact.last-fix": "Gợi ý sửa",
    "alerts.fact.stuck-since": "Kẹt từ",
    "alerts.fact.last-event-at": "Sự kiện cuối",
    "alerts.fact.silent-ms": "Đã im lặng",
    "alerts.fact.median-gap-ms": "Nhịp bình thường",
    "alerts.fact.threshold-ms": "Ngưỡng im lặng",
    "alerts.fact.baseline": "Sự kiện trong 7 ngày",
    "alerts.fact.reason": "Lý do đóng",
    "alerts.fact.calm-streak": "Lượt êm liên tiếp",
    "alerts.fact.last-calm-at": "Lượt êm gần nhất",
    "alerts.fact.class.server-error": "Lỗi 5xx",
    "alerts.fact.class.no-response": "Không phản hồi (hết giờ, lỗi mạng)",
    "alerts.fact.class.throttled": "Bị bảo chậm lại (408/429)",
    "alerts.fact.class.unexpected": "Mã 3xx hoặc mã lạ",
  },
  en: {
    ...ALERT_TEXT.en,

    "alerts.action.view-deliveries": "View deliveries",
    "alerts.action.check-destination": "Re-check destination",
    "alerts.action.open-dlq": "Open dead-letter queue",
    "alerts.action.view-rejected": "View rejected requests",
    "alerts.action.open-sources": "Open Sources",
    "alerts.action.view-source-events": "View source events",
    "alerts.action.renormalize": "Re-normalize",

    "alerts.bell.label": "Alerts",
    "alerts.bell.aria": "Alerts: {count} unread",
    "alerts.bell.aria-none": "Alerts: nothing new",
    "alerts.bell.subtitle": "{count} open",
    "alerts.bell.ack-all": "Mark all as seen",
    "alerts.bell.view-all": "View all",
    "alerts.bell.empty-title": "All good.",
    "alerts.bell.empty-body": "The hub will tell you here when something needs attention.",
    "alerts.bell.more": "+{count} more alerts in this project",
    "alerts.bell.error": "Could not load alerts.",
    "alerts.bell.acked": "seen",
    "alerts.bell.ack-all-done": "Marked {count} alerts as seen.",

    "alerts.banner.region": "Critical alert",
    "alerts.banner.ack": "Seen",
    "alerts.banner.more": "+{count} more critical alerts",
    "alerts.banner.resolved": "Back to normal",

    "alerts.toast.view": "View",
    "alerts.toast.dismiss": "Dismiss notification",
    "alerts.toast.region": "Alerts",

    "alerts.fact.count": "Count",
    "alerts.fact.http-status": "HTTP status",
    "alerts.fact.closed-by-status": "HTTP status on recovery",
    "alerts.fact.since-at": "Since",
    "alerts.fact.last-attempt-at": "Last attempt checked",
    "alerts.fact.last-match-at": "Last same-kind failure",
    "alerts.fact.dead": "Events gone DEAD",
    "alerts.fact.total": "Total",
    "alerts.fact.failed": "Failed",
    "alerts.fact.pct": "Failure rate",
    "alerts.fact.circuit-state": "Circuit breaker state",
    "alerts.fact.half-open-at": "Retry at",
    "alerts.fact.window-from": "Counted from",
    "alerts.fact.status": "Connection state",
    "alerts.fact.provider-label": "Provider",
    "alerts.fact.last-error": "Last error",
    "alerts.fact.last-fix": "Suggested fix",
    "alerts.fact.stuck-since": "Stuck since",
    "alerts.fact.last-event-at": "Last event",
    "alerts.fact.silent-ms": "Silent for",
    "alerts.fact.median-gap-ms": "Normal rhythm",
    "alerts.fact.threshold-ms": "Silence threshold",
    "alerts.fact.baseline": "Events in 7 days",
    "alerts.fact.reason": "Close reason",
    "alerts.fact.calm-streak": "Calm checks in a row",
    "alerts.fact.last-calm-at": "Last calm check",
    "alerts.fact.class.server-error": "5xx errors",
    "alerts.fact.class.no-response": "No response (timeout, network)",
    "alerts.fact.class.throttled": "Asked to slow down (408/429)",
    "alerts.fact.class.unexpected": "3xx or unexpected codes",
  },
});
