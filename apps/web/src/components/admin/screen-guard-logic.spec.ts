import { decideGuard, guardStorageKey } from "./screen-guard-logic";

describe("decideGuard", () => {
  it("chưa đo thì chờ, không kết luận", () => {
    expect(decideGuard(null, 1024, false)).toBe("measuring");
    expect(decideGuard(null, 1024, true)).toBe("measuring");
  });
  it("đủ rộng (kể cả đúng ngưỡng) thì cho vào", () => {
    expect(decideGuard(1024, 1024, false)).toBe("ok");
    expect(decideGuard(1440, 768, false)).toBe("ok");
  });
  it("hẹp hơn ngưỡng thì chặn; xoay ngang đủ rộng thì mở lại", () => {
    expect(decideGuard(390, 768, false)).toBe("blocked");
    expect(decideGuard(1023, 1024, false)).toBe("blocked");
    expect(decideGuard(844, 768, false)).toBe("ok");
  });
  it("Vẫn tiếp tục bỏ qua chặn", () => {
    expect(decideGuard(360, 1024, true)).toBe("ok");
  });
  it("khoá nhớ theo đường dẫn", () => {
    expect(guardStorageKey("/dashboard/flow")).toBe("screen-guard:/dashboard/flow");
  });
});
