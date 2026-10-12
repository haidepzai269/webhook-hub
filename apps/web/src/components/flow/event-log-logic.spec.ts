import { shouldAutoLoadMore, shouldResetHead } from "./event-log-logic";

describe("event-log-logic", () => {
  const base = { visible: true, hasNextPage: true, fetching: false, clientFilter: "" };
  it("tự nạp khi sentinel lọt khung, còn trang, không đang nạp, KHÔNG lọc client", () => {
    expect(shouldAutoLoadMore(base)).toBe(true);
    expect(shouldAutoLoadMore({ ...base, clientFilter: "payos" })).toBe(false); // TB1: tránh nạp mãi
    expect(shouldAutoLoadMore({ ...base, clientFilter: "   " })).toBe(true);
    expect(shouldAutoLoadMore({ ...base, fetching: true })).toBe(false);
    expect(shouldAutoLoadMore({ ...base, hasNextPage: false })).toBe(false);
    expect(shouldAutoLoadMore({ ...base, visible: false })).toBe(false);
  });
  it("nạp lại đầu chỉ ở bước chuyển không-trực-tiếp -> trực tiếp, khi trang đầu đã bị bỏ", () => {
    expect(shouldResetHead({ wasLive: false, live: true, headDropped: true })).toBe(true); // về đỉnh khi đang chạy
    expect(shouldResetHead({ wasLive: true, live: true, headDropped: true })).toBe(false); // đang trực tiếp sẵn
    expect(shouldResetHead({ wasLive: false, live: false, headDropped: true })).toBe(false);
    expect(shouldResetHead({ wasLive: false, live: true, headDropped: false })).toBe(false);
  });
  it("bỏ tạm dừng khi đang ở đỉnh mà trang đầu đã bị bỏ -> nạp lại đầu", () => {
    // tạm dừng, cuộn sâu (bỏ đầu), cuộn về đỉnh (vẫn dừng: live=false), rồi bấm Tiếp tục
    const atTopPaused = { wasLive: false, live: false, headDropped: true };
    expect(shouldResetHead(atTopPaused)).toBe(false);
    expect(shouldResetHead({ wasLive: atTopPaused.live, live: true, headDropped: true })).toBe(true);
  });
});
