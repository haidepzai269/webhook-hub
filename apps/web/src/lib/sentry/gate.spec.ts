import { createGate, eventFingerprintKey } from "./gate";

describe("createGate (dedupe + trần/phút, trong bộ nhớ)", () => {
  it("cùng khoá trong cửa sổ chỉ qua 1 lần; sau cửa sổ qua lại", () => {
    let t = 0;
    const g = createGate({ maxPerMin: 100, dedupeMs: 1000, now: () => t });
    expect(g.allow("a")).toBe(true);
    expect(g.allow("a")).toBe(false);
    t = 1001;
    expect(g.allow("a")).toBe(true);
    expect(g.stats()).toEqual({ sent: 2, deduped: 1, dropped: 0 });
  });
  it("trần maxPerMin: khoá khác nhau vẫn bị chặn quá trần, sang phút mới thì qua", () => {
    let t = 0;
    const g = createGate({ maxPerMin: 2, dedupeMs: 10, now: () => t });
    expect([g.allow("a"), g.allow("b"), g.allow("c")]).toEqual([true, true, false]);
    t = 60_001;
    expect(g.allow("c")).toBe(true);
    expect(g.stats().dropped).toBe(1);
  });
  it("bão 1000 lỗi giống nhau -> đúng 1 event", () => {
    const g = createGate({ maxPerMin: 10, dedupeMs: 300_000 });
    const sent = Array.from({ length: 1000 }, () => g.allow("same")).filter(Boolean).length;
    expect(sent).toBe(1);
  });
});

describe("eventFingerprintKey", () => {
  it("không phụ thuộc message; phụ thuộc loại lỗi + khung stack cuối + cause", () => {
    const mk = (msg: string) => ({ tags: { frontend_cause: "js_exception" }, exception: { values: [{ type: "TypeError", value: msg, stacktrace: { frames: [{ filename: "x.js", lineno: 1 }, { filename: "a.js", lineno: 7 }] } }] } });
    expect(eventFingerprintKey(mk("id 1"))).toBe(eventFingerprintKey(mk("id 2")));
    expect(eventFingerprintKey(mk("x"))).toBe("js_exception|TypeError|a.js:7");
  });
});
