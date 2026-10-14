import { createScrollLock, type ScrollLockTarget } from "./scroll-lock";

function target(over: Partial<ScrollLockTarget> = {}): ScrollLockTarget {
  return {
    clientWidth: 1185,
    innerWidth: 1200,
    style: { overflow: "", paddingRight: "" },
    computedPaddingRight: 0,
    ...over,
  };
}

describe("scroll-lock — khoá cuộn nền của overlay tự viết", () => {
  it("khoá: overflow hidden + bù đúng bề rộng thanh cuộn (không giật layout)", () => {
    const t = target();
    const l = createScrollLock(() => t);
    l.lock();
    expect(t.style).toEqual({ overflow: "hidden", paddingRight: "15px" });
  });

  it("cộng thêm padding-right sẵn có của body", () => {
    const t = target({ computedPaddingRight: 8 });
    createScrollLock(() => t).lock();
    expect(t.style.paddingRight).toBe("23px");
  });

  it("không có thanh cuộn (mobile/overlay scrollbar): không đụng padding", () => {
    const t = target({ clientWidth: 1200 });
    createScrollLock(() => t).lock();
    expect(t.style).toEqual({ overflow: "hidden", paddingRight: "" });
  });

  it("đếm tham chiếu: hai overlay chồng nhau, đóng một cái vẫn còn khoá; đóng cả hai trả lại style cũ", () => {
    const t = target({ style: { overflow: "clip", paddingRight: "4px" } });
    const l = createScrollLock(() => t);
    l.lock();
    l.lock();
    l.unlock();
    expect(t.style.overflow).toBe("hidden");
    l.unlock();
    expect(t.style).toEqual({ overflow: "clip", paddingRight: "4px" });
    expect(l.count).toBe(0);
  });

  it("unlock thừa không làm âm bộ đếm", () => {
    const t = target();
    const l = createScrollLock(() => t);
    l.unlock();
    l.lock();
    expect(t.style.overflow).toBe("hidden");
  });

  it("không có DOM (SSR): không ném lỗi", () => {
    const l = createScrollLock(() => null);
    expect(() => {
      l.lock();
      l.unlock();
    }).not.toThrow();
  });
});
