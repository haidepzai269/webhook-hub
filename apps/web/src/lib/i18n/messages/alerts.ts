import { defineMessages } from "../locales";

/**
 * CB4 (SPEC-canh-bao-nhan-dinh §4, §8): câu chữ cảnh báo — chuông, banner, toast, chi tiết. API chỉ trả `rule` + `facts`
 * (§7: câu chữ nằm ở i18n phía web). Khoá theo luật: `alerts.rule.<mã luật, '_' -> '-'>.<phần>` — mã luật có dấu chấm
 * (`destination.auth_rejected` -> `alerts.rule.destination.auth-rejected.title`), xem `lib/alerts/message.ts#ruleSegment`.
 * BB-1: không câu nào biết nghiệp vụ (đơn hàng, số tiền) — chỉ nguồn / đích / sự kiện / lượt giao.
 */
export const alerts = defineMessages("alerts", {
  vi: {
    "alerts.severity.critical": "Nghiêm trọng",
    "alerts.severity.warning": "Cần chú ý",
    "alerts.severity.info": "Thông tin",
    "alerts.state.open": "Đang mở",
    "alerts.state.resolved": "Đã ổn",
    "alerts.subject.destination": "Đích",
    "alerts.subject.source": "Nguồn",
    "alerts.subject.project": "Toàn dự án",
    "alerts.subject.fallback": "{type} {id}",
    "alerts.headline": "{subject}: {title}",

    // ---- luật (§4)
    "alerts.rule.destination.auth-rejected.name": "Đích từ chối xác thực",
    "alerts.rule.destination.auth-rejected.title": "Bên nhận từ chối xác thực ({status})",
    "alerts.rule.destination.auth-rejected.message": "{count} lần thử liên tiếp bị từ chối kể từ {since}.",
    "alerts.rule.destination.auth-rejected.impact": "{dead} sự kiện đã DEAD ngay vì lỗi 4xx không được thử lại.",
    "alerts.rule.destination.auth-rejected.fix":
      "Thường do secret phía nhận đã đổi. Cập nhật secret của đích, kiểm tra lại, rồi phát lại hàng đợi lỗi.",

    "alerts.rule.destination.client-error.name": "Đích từ chối nội dung",
    "alerts.rule.destination.client-error.title": "Bên nhận từ chối nội dung ({status})",
    "alerts.rule.destination.client-error.message": "{count} lần thử liên tiếp bị trả {status} kể từ {since}.",
    "alerts.rule.destination.client-error.fix":
      "Yêu cầu bị từ chối vì nội dung. Kiểm tra bên nhận có hiểu kiểu sự kiện và khuôn dữ liệu hub gửi.",

    "alerts.rule.destination.failing.name": "Đích lỗi hoặc chậm",
    "alerts.rule.destination.failing.title": "Bên nhận lỗi hoặc chậm: {pct}% thất bại",
    "alerts.rule.destination.failing.message": "{failed}/{total} lần thử trong 15 phút gần nhất thất bại: {breakdown}.",
    "alerts.rule.destination.failing.reassure": "Hub vẫn đang tự thử lại giúp bạn.",
    "alerts.rule.destination.failing.fix.server-error": "Lỗi nằm ở phía bên nhận (5xx). Xem nhật ký của bên nhận.",
    "alerts.rule.destination.failing.fix.no-response": "Bên nhận không trả lời: kiểm tra nó còn chạy và mạng tới được.",
    "alerts.rule.destination.failing.fix.throttled": "Bên nhận đang bảo chậm lại (408/429): hạ giới hạn RPS của đích.",
    "alerts.rule.destination.failing.fix.unexpected": "Bên nhận trả mã 3xx: kiểm tra lại URL của đích, có thể địa chỉ đã chuyển.",
    "alerts.class.server-error": "{n} lỗi 5xx",
    "alerts.class.no-response": "{n} không phản hồi",
    "alerts.class.throttled": "{n} lần bị bảo chậm lại",
    "alerts.class.unexpected": "{n} mã 3xx/lạ",

    "alerts.rule.destination.circuit-open.name": "Tạm ngưng gửi (mạch bảo vệ)",
    "alerts.rule.destination.circuit-open.title": "Hub tạm ngưng gửi tới đích này",
    "alerts.rule.destination.circuit-open.message": "Mạch bảo vệ đang mở để bên nhận có thời gian hồi phục.",
    "alerts.rule.destination.circuit-open.retry-at": "Hub thử lại lúc {at}.",
    "alerts.rule.destination.circuit-open.fix":
      "Không cần làm gì nếu bên nhận tự hồi phục. Nếu kéo dài, kiểm tra bên nhận và các lượt giao gần nhất.",

    "alerts.rule.delivery.dead-spike.name": "Nhiều sự kiện ngừng thử",
    "alerts.rule.delivery.dead-spike.title": "{count} sự kiện đã ngừng thử trong 1 giờ",
    "alerts.rule.delivery.dead-spike.message": "Các lượt giao này đã vào hàng đợi lỗi (DEAD) và sẽ không tự gửi lại.",
    "alerts.rule.delivery.dead-spike.fix": "Mở hàng đợi lỗi (đã lọc 1 giờ), sửa nguyên nhân ở bên nhận rồi phát lại hàng loạt.",

    "alerts.rule.source.signature-failing.name": "Chữ ký sai",
    "alerts.rule.source.signature-failing.title": "Chữ ký sai ở {failed}/{total} yêu cầu",
    "alerts.rule.source.signature-failing.message":
      "{pct}% yêu cầu tới nguồn này trong 15 phút gần nhất bị từ chối vì chữ ký không khớp.",
    "alerts.rule.source.signature-failing.fix":
      "Hoặc secret của nguồn sai, hoặc có người đang gửi yêu cầu giả. Đối chiếu secret với nhà cung cấp, xoay secret nếu nghi bị lộ.",

    "alerts.rule.source.connection-broken.name": "Kết nối nhà cung cấp hỏng",
    "alerts.rule.source.connection-broken.title.failed": "Kết nối {provider} bị lỗi",
    "alerts.rule.source.connection-broken.title.drifted": "Webhook phía {provider} đã bị đổi hoặc gỡ",
    "alerts.rule.source.connection-broken.title.pending": "Kết nối {provider} bị kẹt",
    "alerts.rule.source.connection-broken.message.failed": "Hub không đăng ký được webhook với {provider}.",
    "alerts.rule.source.connection-broken.message.drifted": "Hub sẽ không nhận được sự kiện từ {provider} cho tới khi kết nối lại.",
    "alerts.rule.source.connection-broken.message.pending": "Lần kết nối bắt đầu từ {since} vẫn chưa xong.",
    "alerts.rule.source.connection-broken.fix": "Mở trang Nguồn và bấm Kết nối lại.",

    "alerts.rule.source.silent.name": "Nguồn im lặng",
    "alerts.rule.source.silent.title": "Nguồn im lặng {duration}",
    "alerts.rule.source.silent.message": "Bình thường khoảng {gap} có một sự kiện. Sự kiện cuối lúc {last}.",
    "alerts.rule.source.silent.fix": "Nhà cung cấp có thể đã ngừng gửi. Kiểm tra cấu hình webhook ở phía nhà cung cấp.",

    "alerts.rule.normalize.backlog.name": "Sự kiện thô chưa chuẩn hoá",
    "alerts.rule.normalize.backlog.title": "{count} sự kiện thô chưa được chuẩn hoá",
    "alerts.rule.normalize.backlog.message": "Đã nhận và lưu an toàn nhưng quá 10 phút chưa chuẩn hoá, nên chưa được giao.",
    "alerts.rule.normalize.backlog.fix": "Kiểm tra tiến trình worker, rồi bấm Chuẩn hoá lại ở trang Hành trình sự kiện.",

    "alerts.rule.unknown.title": "Cảnh báo {rule}",

    // ---- hành động (deep link)
    "alerts.action.view-deliveries": "Xem lượt giao",
    "alerts.action.check-destination": "Kiểm tra lại đích",
    "alerts.action.open-dlq": "Mở hàng đợi lỗi",
    "alerts.action.view-rejected": "Xem yêu cầu bị từ chối",
    "alerts.action.open-sources": "Mở trang Nguồn",
    "alerts.action.view-source-events": "Xem sự kiện của nguồn",
    "alerts.action.renormalize": "Chuẩn hoá lại",

    // ---- đơn vị thời lượng
    "alerts.unit.seconds": "{n} giây",
    "alerts.unit.minutes": "{n} phút",
    "alerts.unit.hours": "{n} giờ",
    "alerts.unit.days": "{n} ngày",

    // ---- lý do đóng
    "alerts.reason.archived": "Đóng vì đối tượng đã bị lưu trữ hoặc xoá.",
    "alerts.reason.inactive": "Đóng vì đối tượng đã bị ngắt.",
    "alerts.reason.disconnected": "Đóng vì kết nối với nhà cung cấp đã được gỡ.",

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

    // ---- số liệu (facts) dạng bảng đọc được
    "alerts.fact.count": "Số lần",
    "alerts.fact.http-status": "Mã HTTP",
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
    "alerts.severity.critical": "Critical",
    "alerts.severity.warning": "Warning",
    "alerts.severity.info": "Info",
    "alerts.state.open": "Open",
    "alerts.state.resolved": "Resolved",
    "alerts.subject.destination": "Destination",
    "alerts.subject.source": "Source",
    "alerts.subject.project": "Whole project",
    "alerts.subject.fallback": "{type} {id}",
    "alerts.headline": "{subject}: {title}",

    "alerts.rule.destination.auth-rejected.name": "Destination rejects authentication",
    "alerts.rule.destination.auth-rejected.title": "Receiver rejected authentication ({status})",
    "alerts.rule.destination.auth-rejected.message": "{count} attempts in a row rejected since {since}.",
    "alerts.rule.destination.auth-rejected.impact": "{dead} events went DEAD immediately because 4xx errors are not retried.",
    "alerts.rule.destination.auth-rejected.fix":
      "Usually the receiver's secret changed. Update the destination's secret, re-check it, then replay the dead-letter queue.",

    "alerts.rule.destination.client-error.name": "Destination rejects content",
    "alerts.rule.destination.client-error.title": "Receiver rejected the content ({status})",
    "alerts.rule.destination.client-error.message": "{count} attempts in a row answered {status} since {since}.",
    "alerts.rule.destination.client-error.fix":
      "The request is rejected for its content. Check that the receiver understands the event type and the payload shape the hub sends.",

    "alerts.rule.destination.failing.name": "Destination failing or slow",
    "alerts.rule.destination.failing.title": "Receiver failing or slow: {pct}% failed",
    "alerts.rule.destination.failing.message": "{failed}/{total} attempts in the last 15 minutes failed: {breakdown}.",
    "alerts.rule.destination.failing.reassure": "The hub keeps retrying for you.",
    "alerts.rule.destination.failing.fix.server-error": "The fault is on the receiver's side (5xx). Check the receiver's logs.",
    "alerts.rule.destination.failing.fix.no-response": "The receiver does not answer: check that it is running and reachable.",
    "alerts.rule.destination.failing.fix.throttled": "The receiver is asking to slow down (408/429): lower the destination's RPS limit.",
    "alerts.rule.destination.failing.fix.unexpected": "The receiver answers 3xx: check the destination URL, it may have moved.",
    "alerts.class.server-error": "{n} 5xx errors",
    "alerts.class.no-response": "{n} with no response",
    "alerts.class.throttled": "{n} asked to slow down",
    "alerts.class.unexpected": "{n} 3xx/unexpected",

    "alerts.rule.destination.circuit-open.name": "Sending paused (circuit breaker)",
    "alerts.rule.destination.circuit-open.title": "Hub paused sending to this destination",
    "alerts.rule.destination.circuit-open.message": "The circuit breaker is open so the receiver has time to recover.",
    "alerts.rule.destination.circuit-open.retry-at": "The hub tries again at {at}.",
    "alerts.rule.destination.circuit-open.fix":
      "Nothing to do if the receiver recovers on its own. If it persists, check the receiver and its recent deliveries.",

    "alerts.rule.delivery.dead-spike.name": "Many events stopped retrying",
    "alerts.rule.delivery.dead-spike.title": "{count} events stopped retrying in the last hour",
    "alerts.rule.delivery.dead-spike.message": "These deliveries are now in the dead-letter queue (DEAD) and will not be sent again on their own.",
    "alerts.rule.delivery.dead-spike.fix": "Open the dead-letter queue (filtered to 1 hour), fix the cause on the receiver, then bulk replay.",

    "alerts.rule.source.signature-failing.name": "Invalid signatures",
    "alerts.rule.source.signature-failing.title": "Invalid signature on {failed}/{total} requests",
    "alerts.rule.source.signature-failing.message":
      "{pct}% of requests to this source in the last 15 minutes were rejected for a mismatched signature.",
    "alerts.rule.source.signature-failing.fix":
      "Either the source secret is wrong, or someone is sending forged requests. Compare the secret with the provider and rotate it if you suspect a leak.",

    "alerts.rule.source.connection-broken.name": "Provider connection broken",
    "alerts.rule.source.connection-broken.title.failed": "{provider} connection failed",
    "alerts.rule.source.connection-broken.title.drifted": "The webhook on {provider}'s side was changed or removed",
    "alerts.rule.source.connection-broken.title.pending": "{provider} connection is stuck",
    "alerts.rule.source.connection-broken.message.failed": "The hub could not register its webhook with {provider}.",
    "alerts.rule.source.connection-broken.message.drifted": "The hub will not receive events from {provider} until you reconnect.",
    "alerts.rule.source.connection-broken.message.pending": "The connection attempt started at {since} has not finished.",
    "alerts.rule.source.connection-broken.fix": "Open Sources and click Reconnect.",

    "alerts.rule.source.silent.name": "Silent source",
    "alerts.rule.source.silent.title": "Source silent for {duration}",
    "alerts.rule.source.silent.message": "Normally one event about every {gap}. Last event at {last}.",
    "alerts.rule.source.silent.fix": "The provider may have stopped sending. Check the webhook settings on the provider's side.",

    "alerts.rule.normalize.backlog.name": "Raw events not normalized",
    "alerts.rule.normalize.backlog.title": "{count} raw events not normalized",
    "alerts.rule.normalize.backlog.message": "Received and stored safely, but not normalized for over 10 minutes, so not delivered yet.",
    "alerts.rule.normalize.backlog.fix": "Check the worker process, then click Re-normalize on the Event journeys page.",

    "alerts.rule.unknown.title": "Alert {rule}",

    "alerts.action.view-deliveries": "View deliveries",
    "alerts.action.check-destination": "Re-check destination",
    "alerts.action.open-dlq": "Open dead-letter queue",
    "alerts.action.view-rejected": "View rejected requests",
    "alerts.action.open-sources": "Open Sources",
    "alerts.action.view-source-events": "View source events",
    "alerts.action.renormalize": "Re-normalize",

    "alerts.unit.seconds": "{n} s",
    "alerts.unit.minutes": "{n} min",
    "alerts.unit.hours": "{n} h",
    "alerts.unit.days": "{n} d",

    "alerts.reason.archived": "Closed because the subject was archived or deleted.",
    "alerts.reason.inactive": "Closed because the subject was disabled.",
    "alerts.reason.disconnected": "Closed because the provider connection was removed.",

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

    "alerts.fact.count": "Count",
    "alerts.fact.http-status": "HTTP status",
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
