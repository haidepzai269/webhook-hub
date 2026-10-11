import { isFinalStatus, LATE_WEBHOOK_GRACE_MS, paymentQr, pollDeadline } from "./order-status";

/**
 * R2-L1 (ADR-144): EXPIRED chưa phải trạng thái cuối ngay tại hạn — khoản trả ĐÚNG hạn có webhook tới muộn (cold start)
 * vẫn kéo đơn sang PAID (M-1). Web phải tiếp tục hỏi trong cửa sổ grace, không dừng ở "đã hết hạn".
 */
describe("isFinalStatus / pollDeadline — checkout Shop", () => {
  const expiresAt = "2026-10-11T10:30:00.000Z";
  const at = (ms: number) => Date.parse(expiresAt) + ms;

  it("PAID, CANCELLED là cuối; PENDING/UNDERPAID không", () => {
    expect(isFinalStatus("PAID", expiresAt, at(0))).toBe(true);
    expect(isFinalStatus("CANCELLED", expiresAt, at(0))).toBe(true);
    expect(isFinalStatus("PENDING", expiresAt, at(LATE_WEBHOOK_GRACE_MS * 2))).toBe(false);
    expect(isFinalStatus("UNDERPAID", expiresAt, at(0))).toBe(false);
  });

  it("EXPIRED trong cửa sổ grace sau hạn -> CHƯA cuối (còn hỏi tiếp); quá grace -> cuối", () => {
    expect(isFinalStatus("EXPIRED", expiresAt, at(30_000))).toBe(false);
    expect(isFinalStatus("EXPIRED", expiresAt, at(LATE_WEBHOOK_GRACE_MS - 1))).toBe(false);
    expect(isFinalStatus("EXPIRED", expiresAt, at(LATE_WEBHOOK_GRACE_MS + 1))).toBe(true);
    expect(isFinalStatus("EXPIRED", undefined, at(0))).toBe(true); // server cũ không có expiresAt
  });

  it("grace dài hơn biên 5 phút của link PayOS; hạn poll = expiresAt + grace", () => {
    expect(LATE_WEBHOOK_GRACE_MS).toBeGreaterThan(5 * 60_000);
    expect(pollDeadline(expiresAt, 123)).toBe(at(LATE_WEBHOOK_GRACE_MS));
    expect(pollDeadline(undefined, 123)).toBe(123);
  });
});

/** Q3 (ADR-154): QR PayOS vẽ TẠI TRÌNH DUYỆT từ chuỗi VietQR — không gửi dữ liệu thanh toán cho bên thứ ba vẽ ảnh. */
describe("paymentQr — chọn cách hiển thị QR", () => {
  it("có qrCode (PayOS) -> vẽ tại chỗ từ chuỗi, kể cả khi server cũ còn gửi qrImageUrl", () => {
    expect(paymentQr({ qrImageUrl: null, qrCode: "000201abc" })).toEqual({ kind: "code", value: "000201abc" });
    expect(paymentQr({ qrImageUrl: "https://api.qrserver.com/x", qrCode: "000201abc" })).toEqual({ kind: "code", value: "000201abc" });
  });

  it("SePay: ảnh VietQR chuẩn của ngân hàng (img.vietqr.io); thiếu cả hai -> null", () => {
    expect(paymentQr({ qrImageUrl: "https://img.vietqr.io/image/x.png" })).toEqual({ kind: "image", url: "https://img.vietqr.io/image/x.png" });
    expect(paymentQr({ qrImageUrl: null })).toBeNull();
  });

  it("không bao giờ dùng ảnh của qrserver", () => {
    expect(paymentQr({ qrImageUrl: "https://api.qrserver.com/v1/create-qr-code/?data=x" })).toBeNull();
  });
});
