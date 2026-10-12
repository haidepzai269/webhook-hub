import { assignUnroll, createUnrollMemory, isUnrolling, resetUnroll, UNROLL_STAGGER_CAP_MS } from "./unroll";

describe("unroll — chỉ dòng mới mở ra, dòng cũ không bao giờ chạy lại", () => {
  it("lô đầu: trễ 20ms/dòng theo thứ tự, trần 200ms", () => {
    const mem = createUnrollMemory();
    const keys = Array.from({ length: 15 }, (_, i) => `k${i}`);
    const f = assignUnroll(mem, keys, 0);
    expect(keys.map((k) => f.get(k)?.delayMs)).toEqual([0, 20, 40, 60, 80, 100, 120, 140, 160, 180, 200, 200, 200, 200, 200]);
    expect(Math.max(...keys.map((k) => f.get(k)?.delayMs ?? 0))).toBe(UNROLL_STAGGER_CAP_MS);
  });

  it("dòng mới chèn trên đầu (nhật ký trực tiếp): chỉ dòng mới mở, dòng cũ giữ NGUYÊN số phận cũ", () => {
    const mem = createUnrollMemory();
    const first = assignUnroll(mem, ["a", "b", "c"], 0);
    const second = assignUnroll(mem, ["x", "y", "a", "b", "c"], 10_000);
    expect(second.get("x")).toMatchObject({ animate: true, delayMs: 0 });
    expect(second.get("y")).toMatchObject({ animate: true, delayMs: 20 });
    for (const k of ["a", "b", "c"]) expect(second.get(k)).toEqual(first.get(k));
    // ... và lúc 10s, dòng cũ đã qua cửa sổ -> không mang class -> không chạy lại
    for (const k of ["a", "b", "c"]) expect(isUnrolling(second.get(k), 10_000)).toBe(false);
    expect(isUnrolling(second.get("x"), 10_000)).toBe(true);
  });

  it("render lại giữa chừng (socket làm mới): dòng đang mở GIỮ class -> không bị cắt ngang", () => {
    const mem = createUnrollMemory();
    assignUnroll(mem, ["a"], 0);
    const again = assignUnroll(mem, ["a"], 100);
    expect(isUnrolling(again.get("a"), 100)).toBe(true);
    expect(isUnrolling(again.get("a"), 5_000)).toBe(false);
  });

  it("nạp thêm trang cũ (cuộn xuống): lô mới ở cuối mở ra, trễ đếm lại từ 0", () => {
    const mem = createUnrollMemory();
    assignUnroll(mem, ["a", "b"], 0);
    const more = assignUnroll(mem, ["a", "b", "c", "d"], 1_000);
    expect(more.get("c")).toMatchObject({ animate: true, delayMs: 0 });
    expect(more.get("d")).toMatchObject({ animate: true, delayMs: 20 });
  });

  it("animateInitial: false -> lô đầu đứng yên, lô sau mới mở", () => {
    const mem = createUnrollMemory();
    const f = assignUnroll(mem, ["a"], 0, { animateInitial: false });
    expect(f.get("a")?.animate).toBe(false);
    expect(assignUnroll(mem, ["b", "a"], 1, { animateInitial: false }).get("b")?.animate).toBe(true);
  });

  it("danh sách rỗng chưa tính là lô đầu; dòng rời danh sách bị quên; reset = lô mới", () => {
    const mem = createUnrollMemory();
    assignUnroll(mem, [], 0, { animateInitial: false });
    expect(assignUnroll(mem, ["a"], 0, { animateInitial: false }).get("a")?.animate).toBe(false);
    assignUnroll(mem, ["b"], 1);
    expect(mem.fates.has("a")).toBe(false);
    resetUnroll(mem);
    expect(mem.fates.size).toBe(0);
    expect(mem.primed).toBe(false);
  });
});
