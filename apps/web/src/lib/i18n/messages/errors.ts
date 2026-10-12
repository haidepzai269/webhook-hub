import { defineMessages } from "../locales";

/**
 * Thông báo do CLIENT tự dựng từ mã/số liệu của hub (lib/hub/ui-logic.ts, lib/credential-input.ts) — không phải câu
 * server gửi về (câu đó hiển thị nguyên văn). `errors.verification.<mã hub, '_' → '-'>` khớp mã `verificationError` của hub.
 */
export const errors = defineMessages("errors", {
  vi: {
    "errors.delete-conflict.destination":
      "Đích còn {subscriptions} đăng ký nhận trỏ vào ({deliveries} lượt giao trong lịch sử). Tắt các đăng ký nhận đó; đích chỉ xoá được khi không còn đăng ký nhận nào.",
    "errors.delete-conflict.subscription":
      "Đăng ký nhận còn {deliveries} lượt giao trong lịch sử (kể cả lượt hỏng hẳn) — không xoá để giữ bằng chứng. Hãy bấm “Tắt” để ngừng gửi.",
    "errors.delete-conflict.generic": "Xung đột (409)",
    "errors.verification.label.pending": "Đang chờ",
    "errors.verification.label.failed": "Thất bại",
    "errors.verification.label.verified": "Đã xác minh",
    "errors.verification.pending": "Đang chờ đích trả lời thử thách xác minh.",
    "errors.verification.failed": "Xác minh thất bại.",
    "errors.verification.http": "Đích trả HTTP {code} cho thử thách xác minh (phải trả 200).",
    "errors.verification.unknown": "Lỗi xác minh: {code}",
    "errors.verification.ssrf-blocked":
      "URL trỏ vào địa chỉ nội bộ/riêng — hub chặn để chống SSRF. Hãy đăng ký URL công khai (https) của dịch vụ.",
    "errors.verification.timeout": "Đích không trả lời thử thách xác minh trong 10 giây.",
    "errors.verification.challenge-mismatch":
      'Đích trả lời sai thử thách xác minh — phải trả đúng {"challenge": "<giá trị nhận được>"}.',
    "errors.verification.invalid-json": "Đích trả về nội dung không phải JSON.",
    "errors.verification.unreachable": "Hub không kết nối được tới đích (lỗi DNS, bị từ chối kết nối hoặc lỗi TLS).",
    "errors.verification.invalid-url": "Đích không có URL http(s) hợp lệ.",
    "errors.verification.no-signing-secret": "Đích chưa có khoá ký.",
    "errors.credential.looks-like-email": "Đây có vẻ là email, không phải {label}",
  },
  en: {
    "errors.delete-conflict.destination":
      "{subscriptions} subscription(s) still point to this destination ({deliveries} past deliveries). Disable those subscriptions; a destination can only be deleted once no subscription uses it.",
    "errors.delete-conflict.subscription":
      "This subscription has {deliveries} deliveries in its history (including dead ones) — it is kept as evidence. Click “Disable” to stop sending.",
    "errors.delete-conflict.generic": "Conflict (409)",
    "errors.verification.label.pending": "Pending",
    "errors.verification.label.failed": "Failed",
    "errors.verification.label.verified": "Verified",
    "errors.verification.pending": "Waiting for the endpoint to answer the challenge.",
    "errors.verification.failed": "Verification failed.",
    "errors.verification.http": "The endpoint returned HTTP {code} for the challenge (must return 200).",
    "errors.verification.unknown": "Verification error: {code}",
    "errors.verification.ssrf-blocked":
      "The URL points to an internal/private address — blocked by the hub (SSRF). Register the service's public (https) URL.",
    "errors.verification.timeout": "The endpoint did not answer the challenge within 10 seconds.",
    "errors.verification.challenge-mismatch":
      'The endpoint answered the challenge incorrectly — it must return exactly {"challenge": "<received value>"}.',
    "errors.verification.invalid-json": "The endpoint returned a non-JSON response.",
    "errors.verification.unreachable": "The hub could not reach the endpoint (DNS, connection refused or TLS error).",
    "errors.verification.invalid-url": "The endpoint has no valid http(s) URL.",
    "errors.verification.no-signing-secret": "The endpoint has no signing secret.",
    "errors.credential.looks-like-email": "This looks like an email address, not a {label}",
  },
});
