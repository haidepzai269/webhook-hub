import { isFinalStatus, LATE_WEBHOOK_GRACE_MS, pollDeadline } from "./order-status";

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
