import { FIT_INITIAL, type FitColumn, fitStep, hideCandidates, type MobileCardSpec, planMobileCard } from "./responsive-table-logic";

const spec: MobileCardSpec = {
  title: "destination",
  badge: "status",
  meta: ["eventType", "http", "lastError", "ghost"],
  wide: ["lastError"],
  actions: "actions",
};

describe("planMobileCard", () => {
  it("giữ thứ tự khai báo, bỏ cột không tồn tại, đánh dấu cột cần cả hàng", () => {
    const p = planMobileCard(spec, ["status", "destination", "eventType", "http", "lastError", "actions", "ms"]);
    expect(p.title).toBe("destination");
    expect(p.badge).toBe("status");
    expect(p.actions).toBe("actions");
    expect(p.meta).toEqual([
      { id: "eventType", wide: false },
      { id: "http", wide: false },
      { id: "lastError", wide: true },
    ]);
  });

  it("cột người dùng đã ẩn thì không lên thẻ", () => {
    const p = planMobileCard(spec, ["status", "destination", "http"]);
    expect(p.meta.map((m) => m.id)).toEqual(["http"]);
    expect(p.actions).toBeNull();
  });

  it("không có cột tiêu đề / trùng vai thì không lặp cột", () => {
    const p = planMobileCard({ title: "x", badge: "x", meta: ["x", "y", "y"] }, ["x", "y"]);
    expect(p.title).toBe("x");
    expect(p.meta.map((m) => m.id)).toEqual(["y"]);
    expect(planMobileCard({ title: "zzz" }, ["a"]).title).toBeNull();
  });
});

describe("fitStep", () => {
  it("vừa khung thì đứng yên (trả đúng đối tượng cũ)", () => {
    expect(fitStep(FIT_INITIAL, false, 3)).toBe(FIT_INITIAL);
  });
  it("tràn: ẩn từng cột, hết cột thì bóp, rồi dừng", () => {
    let s = FIT_INITIAL;
    s = fitStep(s, true, 2);
    expect(s).toEqual({ hidden: 1, crush: false });
    s = fitStep(s, true, 2);
    s = fitStep(s, true, 2);
    expect(s).toEqual({ hidden: 2, crush: true });
    expect(fitStep(s, true, 2)).toBe(s);
  });
  it("không có ứng viên thì bóp ngay", () => {
    expect(fitStep(FIT_INITIAL, true, 0)).toEqual({ hidden: 0, crush: true });
  });
});

describe("hideCandidates", () => {
  const col = (id: string, o: Partial<FitColumn> = {}): FitColumn => ({ id, canHide: true, userVisible: true, pinned: false, ...o });
  it("ẩn phải → trái, giữ cột đầu, cột cuối và cột keep", () => {
    const cols = [col("a"), col("b"), col("c"), col("d"), col("e"), col("act")];
    expect(hideCandidates(cols, ["c"])).toEqual(["e", "d", "b"]);
  });
  it("bỏ qua cột người dùng tắt sẵn, cột ghim và cột không ẩn được", () => {
    const cols = [col("a"), col("b", { userVisible: false }), col("c", { pinned: true }), col("d", { canHide: false }), col("e"), col("f")];
    expect(hideCandidates(cols)).toEqual(["e"]);
  });
  it("cột cuối tính trên các cột đang hiện (cột cuối bị tắt thì cột liền trước là cột cuối)", () => {
    const cols = [col("a"), col("b"), col("c"), col("d", { userVisible: false })];
    expect(hideCandidates(cols)).toEqual(["b"]);
  });
});
