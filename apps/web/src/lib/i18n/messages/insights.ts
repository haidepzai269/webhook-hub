import { defineMessages } from "../locales";

/**
 * CB6 (SPEC-canh-bao-nhan-dinh §7): câu chữ NHẬN ĐỊNH — Tổng quan (I-dup, I-dead), Đích (I-dest), Nguồn (I-silent).
 * API chỉ trả `code + level + facts`; câu dựng ở `lib/insights/message.ts`. Không bao giờ chỉ một con số: nhãn nói
 * "chuyện gì", dòng phụ nói "bao nhiêu / so với gì". BB-1: không câu nào biết nghiệp vụ.
 */
export const insights = defineMessages("insights", {
  vi: {
    "insights.col.dest": "1 giờ qua",
    "insights.col.silent": "Nhịp sự kiện",
    "insights.ago": "{d} trước",

    // ---- I-dest
    "insights.dest.healthy.label": "Khoẻ",
    "insights.dest.healthy.detail": "{success}/{total} lần giao thành công trong 1 giờ qua.",
    "insights.dest.auth-rejected.label": "Từ chối xác thực",
    "insights.dest.auth-rejected.detail":
      "Lần thử gần nhất bị trả {status} lúc {at}. Lỗi 4xx không được thử lại — sự kiện vào hàng đợi lỗi ngay. Thường do secret phía nhận đã đổi.",
    "insights.dest.client-error.label": "Bên nhận từ chối nội dung",
    "insights.dest.client-error.detail":
      "Lần thử gần nhất bị trả {status} lúc {at}. Lỗi 4xx không được thử lại — kiểm tra bên nhận có hiểu kiểu sự kiện.",
    "insights.dest.receiver-failing.label": "Lỗi/chậm phía nhận (đang thử lại)",
    "insights.dest.receiver-failing.detail":
      "{failed}/{total} lần thử trong 1 giờ qua thất bại; hub vẫn đang tự thử lại giúp bạn.",
    "insights.dest.circuit-open.label": "Tạm ngưng (cầu dao)",
    "insights.dest.circuit-open.detail": "Hub tạm ngưng gửi để bảo vệ bên nhận và sẽ tự thử lại khi cầu dao nửa mở.",
    "insights.dest.no-deliveries.label": "Chưa có lượt giao",
    "insights.dest.no-deliveries.detail": "Không có lần giao nào trong 1 giờ qua.",

    // ---- I-silent
    "insights.silent.last": "Sự kiện cuối {ago}",
    "insights.silent.normal": "Bình thường — khoảng {gap} một sự kiện.",
    "insights.silent.normal-nogap": "Bình thường.",
    "insights.silent.quiet":
      "Im lặng lâu bất thường — bình thường khoảng {gap} một sự kiện. Nhà cung cấp có thể đã ngừng gửi.",
    "insights.silent.learning": "Chưa đủ {min} sự kiện trong 7 ngày để biết nhịp (mới có {n}).",
    "insights.silent.none": "Chưa có sự kiện trong 7 ngày",
    "insights.silent.none-detail": "Nguồn chưa nhận sự kiện nào trong 7 ngày qua.",

    // ---- I-dup
    "insights.dup.title": "Hôm nay hub đã chặn {n} sự kiện trùng",
    "insights.dup.none": "Hôm nay chưa có sự kiện trùng nào",
    "insights.dup.breakdown": "Theo nhà cung cấp: {list}",
    "insights.dup.tooltip":
      "Nhà cung cấp gửi lại khi không nhận được 2xx kịp lúc (mạng chập chờn, quá thời gian chờ) hoặc theo lịch thử lại của họ. Hub chỉ trả 2xx sau khi đã ghi vào PostgreSQL, và PostgreSQL quyết định bản nào là trùng — gửi lại bao nhiêu lần cũng chỉ xử lý một lần, kể cả khi Redis mất dữ liệu.",

    // ---- I-dead
    "insights.dead.title": "{n} lượt giao cần xử lý trong hàng đợi lỗi, {k} trong 24 giờ qua",
    "insights.dead.title-capped": "Ít nhất {n} lượt giao cần xử lý trong hàng đợi lỗi, {k} trong 24 giờ qua",
    "insights.dead.none": "Không có lượt giao nào cần xử lý trong hàng đợi lỗi",
    "insights.dead.archived": "(+{m} thuộc đích đã lưu trữ)",
    "insights.dead.detail": "Hub đã ngừng thử các lượt giao này. Sửa nguyên nhân rồi phát lại từ hàng đợi lỗi.",
    "insights.dead.none-detail": "Không có lượt giao nào đã ngừng thử.",
  },
  en: {
    "insights.col.dest": "Last hour",
    "insights.col.silent": "Event rhythm",
    "insights.ago": "{d} ago",

    "insights.dest.healthy.label": "Healthy",
    "insights.dest.healthy.detail": "{success}/{total} deliveries succeeded in the last hour.",
    "insights.dest.auth-rejected.label": "Authentication rejected",
    "insights.dest.auth-rejected.detail":
      "The latest attempt got {status} at {at}. 4xx is not retried — events go to the dead-letter queue right away. Usually the receiver's secret changed.",
    "insights.dest.client-error.label": "Receiver rejects the content",
    "insights.dest.client-error.detail":
      "The latest attempt got {status} at {at}. 4xx is not retried — check that the receiver understands the event type.",
    "insights.dest.receiver-failing.label": "Receiver failing/slow (retrying)",
    "insights.dest.receiver-failing.detail":
      "{failed}/{total} attempts in the last hour failed; the hub keeps retrying for you.",
    "insights.dest.circuit-open.label": "Paused (circuit breaker)",
    "insights.dest.circuit-open.detail":
      "The hub paused sending to protect the receiver and will try again when the breaker half-opens.",
    "insights.dest.no-deliveries.label": "No deliveries yet",
    "insights.dest.no-deliveries.detail": "No delivery attempts in the last hour.",

    "insights.silent.last": "Last event {ago}",
    "insights.silent.normal": "Normal — about one event every {gap}.",
    "insights.silent.normal-nogap": "Normal.",
    "insights.silent.quiet":
      "Unusually quiet — normally about one event every {gap}. The provider may have stopped sending.",
    "insights.silent.learning": "Fewer than {min} events in 7 days to learn the rhythm (only {n} so far).",
    "insights.silent.none": "No events in 7 days",
    "insights.silent.none-detail": "This source received no events in the last 7 days.",

    "insights.dup.title": "Today the hub blocked {n} duplicate events",
    "insights.dup.none": "No duplicate events today",
    "insights.dup.breakdown": "By provider: {list}",
    "insights.dup.tooltip":
      "Providers resend when they do not get a 2xx in time (flaky network, timeout) or on their own retry schedule. The hub only answers 2xx after writing to PostgreSQL, and PostgreSQL decides what is a duplicate — however many times an event is resent it is processed once, even if Redis loses its data.",

    "insights.dead.title": "{n} deliveries to handle in the dead-letter queue, {k} in the last 24 hours",
    "insights.dead.title-capped":
      "At least {n} deliveries to handle in the dead-letter queue, {k} in the last 24 hours",
    "insights.dead.none": "No deliveries to handle in the dead-letter queue",
    "insights.dead.archived": "(+{m} for archived destinations)",
    "insights.dead.detail":
      "The hub stopped retrying these deliveries. Fix the cause, then replay them from the dead-letter queue.",
    "insights.dead.none-detail": "No deliveries have stopped retrying.",
  },
});
