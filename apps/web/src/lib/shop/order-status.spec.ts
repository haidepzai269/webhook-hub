import {
  canTopUp,
  cartSignature,
  isFinalStatus,
  LATE_WEBHOOK_GRACE_MS,
  orderCodeFromSearch,
  parseSavedOrder,
  paymentQr,
  pollDeadline,
  shouldStartNewOrder,
} from "./order-status";

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
    expect(paymentQr({ qrImageUrl: "https://api.qrserver.com/x", qrCode: "000201abc" })).toEqual({
      kind: "code",
      value: "000201abc",
    });
  });

  it("SePay: ảnh VietQR chuẩn của ngân hàng (img.vietqr.io); thiếu cả hai -> null", () => {
    expect(paymentQr({ qrImageUrl: "https://img.vietqr.io/image/x.png" })).toEqual({
      kind: "image",
      url: "https://img.vietqr.io/image/x.png",
    });
    expect(paymentQr({ qrImageUrl: null })).toBeNull();
  });

  it("không bao giờ dùng ảnh của qrserver", () => {
    expect(paymentQr({ qrImageUrl: "https://api.qrserver.com/v1/create-qr-code/?data=x" })).toBeNull();
  });
});

describe("checkout Shop — SK4 (M-1, M-2) + QR đơn cũ", () => {
  it("[SK:U7] (phần a) M-1: đơn PayOS không bao giờ được bảo 'chuyển thêm cùng nội dung' (chỉ hotline); SePay thì được", () => {
    expect(canTopUp("payos")).toBe(false);
    expect(canTopUp("sepay")).toBe(true);
  });

  it("[SK:U7] (phần b) M-2: đọc ?order= của returnUrl PayOS (đúng khuôn), đơn lưu trong tab đọc lại an toàn", () => {
    expect(orderCodeFromSearch("?order=DH1234567")).toBe("DH1234567");
    expect(orderCodeFromSearch("?order=DH1234567&cancel=1")).toBe("DH1234567");
    expect(orderCodeFromSearch("?order=<script>")).toBeNull();
    expect(orderCodeFromSearch("")).toBeNull();
    expect(parseSavedOrder('{"orderCode":"DH1234567","amount":5000}')).toMatchObject({ amount: 5000 });
    expect(parseSavedOrder("{rác")).toBeNull();
    expect(parseSavedOrder('{"orderCode":"x"}')).toBeNull();
  });

  it("giỏ đổi so với lúc tạo đơn -> tạo đơn mới (không dùng lại QR cũ); giỏ y nguyên -> giữ đơn", () => {
    const sig = cartSignature([
      { id: "m7", qty: 1 },
      { id: "m1", qty: 2 },
    ]);
    expect(sig).toBe(
      cartSignature([
        { id: "m1", qty: 2 },
        { id: "m7", qty: 1 },
      ]),
    ); // thứ tự không quan trọng
    const order = { cartSig: sig };
    expect(shouldStartNewOrder(order, sig)).toBe(false);
    expect(shouldStartNewOrder(order, cartSignature([{ id: "m7", qty: 1 }]))).toBe(true);
    expect(shouldStartNewOrder(order, cartSignature([]))).toBe(true); // đã trả xong, giỏ bị xoá
    expect(shouldStartNewOrder(null, sig)).toBe(false);
    expect(shouldStartNewOrder({}, sig)).toBe(false); // đơn mở từ ?order= (không biết giỏ) -> giữ để xem trạng thái
  });
});
