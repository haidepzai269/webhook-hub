import { type MobileCardSpec, planMobileCard } from "./responsive-table-logic";

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
