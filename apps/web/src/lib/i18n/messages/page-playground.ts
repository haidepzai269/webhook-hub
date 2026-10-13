import { defineMessages } from "../locales";

/** Trang Thử nghiệm (dashboard/playground) + lỗi dựng yêu cầu (playground/_components/build-request.ts). */
export const pagePlayground = defineMessages("page.playground", {
  vi: {
    "page.playground.title": "Thử nghiệm",
    "page.playground.description":
      "Bắn một webhook thử vào hub, ký đúng như nhà cung cấp thật — rồi xem nó chảy qua Sự kiện → Lượt giao.",
    "page.playground.request.title": "Yêu cầu",
    "page.playground.request.desc": "Gửi thẳng từ trình duyệt tới {url}/hooks/…",
    "page.playground.field.source": "Nguồn",
    "page.playground.field.source-placeholder": "Chọn nguồn",
    "page.playground.no-sources.before": "Chưa có nguồn —",
    "page.playground.no-sources.link": "tạo một nguồn",
    "page.playground.no-sources.after": "trước.",
    "page.playground.generic-hidden":
      "Ẩn {count} nguồn \"Nhà cung cấp khác\": trang này chưa ký theo cấu hình riêng của nguồn. Gửi thử từ nhà cung cấp (hoặc tự ký rồi gửi bằng `curl`), rồi xem kết quả ở nút Lắng nghe trên trang Nguồn.",
    "page.playground.secret.sepay": "Khoá API",
    "page.playground.secret.payos": "Khoá kiểm tổng",
    "page.playground.secret.sign": "Khoá bí mật để ký",
    "page.playground.secret.placeholder": "Để trống = gửi chữ ký sai",
    "page.playground.secret.hint":
      "Tính HMAC ngay trong trình duyệt (WebCrypto), không gửi khoá bí mật đi đâu. Để trống để xem hub trả 401.",
    "page.playground.body.label": "Nội dung (gửi nguyên văn)",
    "page.playground.body.sample": "Mẫu mới",
    "page.playground.body.hint":
      "Gửi lại đúng nội dung này hai lần (cùng id) để thấy cơ chế chống trùng: lần hai không tạo sự kiện mới.",
    "page.playground.send": "Gửi webhook",
    "page.playground.sending": "Đang gửi…",
    "page.playground.response.title": "Phản hồi",
    "page.playground.response.desc":
      "Hub chỉ trả 2xx SAU khi ghi sự kiện gốc vào Postgres (BB-3) — 2xx nghĩa là sự kiện không thể mất.",
    "page.playground.send-error": "Không gửi được: {message}",
    "page.playground.nothing-sent": "Chưa gửi gì.",
    "page.playground.response.body": "Nội dung phản hồi",
    "page.playground.response.headers": "Tiêu đề HTTP đã gửi",
    "page.playground.view-events": "Xem trong Hành trình sự kiện →",
    "page.playground.error.payos-json": "Nội dung PayOS phải là JSON hợp lệ để ký",
    "page.playground.error.payos-object": "Nội dung PayOS phải là đối tượng JSON",
  },
  en: {
    "page.playground.title": "Playground",
    "page.playground.description":
      "Fire a test webhook at the hub, signed exactly like the real provider — then watch it flow through Events → Deliveries.",
    "page.playground.request.title": "Request",
    "page.playground.request.desc": "Sent straight from the browser to {url}/hooks/…",
    "page.playground.field.source": "Source",
    "page.playground.field.source-placeholder": "Choose a source",
    "page.playground.no-sources.before": "No sources yet —",
    "page.playground.no-sources.link": "create a source",
    "page.playground.no-sources.after": "first.",
    "page.playground.generic-hidden":
      "Hiding {count} \"Other provider\" source(s): this page does not sign with a source's own configuration yet. Send a test from the provider (or sign it yourself and send with `curl`), then check the Listen button on the Sources page.",
    "page.playground.secret.sepay": "API key",
    "page.playground.secret.payos": "Checksum key",
    "page.playground.secret.sign": "Signing secret",
    "page.playground.secret.placeholder": "Leave empty = send a wrong signature",
    "page.playground.secret.hint":
      "HMAC is computed in the browser (WebCrypto); the secret is never sent anywhere. Leave empty to see the hub return 401.",
    "page.playground.body.label": "Body (sent verbatim)",
    "page.playground.body.sample": "New sample",
    "page.playground.body.hint":
      "Send this exact body twice (same id) to see idempotency: the second send creates no new event.",
    "page.playground.send": "Send webhook",
    "page.playground.sending": "Sending…",
    "page.playground.response.title": "Response",
    "page.playground.response.desc":
      "The hub returns 2xx only AFTER committing the raw event to Postgres (BB-3) — 2xx means the event can't be lost.",
    "page.playground.send-error": "Couldn't send: {message}",
    "page.playground.nothing-sent": "Nothing sent yet.",
    "page.playground.response.body": "Response body",
    "page.playground.response.headers": "Headers sent",
    "page.playground.view-events": "View in Event journeys →",
    "page.playground.error.payos-json": "PayOS body must be valid JSON to sign",
    "page.playground.error.payos-object": "PayOS body must be a JSON object",
  },
});
