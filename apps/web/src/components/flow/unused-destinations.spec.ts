import { unusedDestinationIds } from "./unused-destinations";

const dst = (id: string, health = "idle", extra: Record<string, unknown> = {}) => ({
  id,
  kind: "destination",
  health,
  retrying: 0,
  ...extra,
});
const sub = (id: string, destinationId: string, active = true) => ({ id, kind: "subscription", destinationId, active });
const edge = (target: string, count = 0, retrying = 0) => ({ source: "x", target, count, retrying });

describe("unusedDestinationIds — đích không có subscription đang bật", () => {
  it("đích FAILED cũ không subscription -> không dùng (dù health=crashed)", () => {
    const ids = unusedDestinationIds({ nodes: [dst("dst:old", "crashed")], edges: [] });
    expect([...ids]).toEqual(["dst:old"]);
  });

  it("đích có subscription bật -> đang dùng", () => {
    const ids = unusedDestinationIds({ nodes: [dst("dst:a"), sub("sub:1", "a")], edges: [] });
    expect(ids.size).toBe(0);
  });

  it("chỉ có subscription TẮT -> không dùng", () => {
    const ids = unusedDestinationIds({ nodes: [dst("dst:a"), sub("sub:1", "a", false)], edges: [] });
    expect([...ids]).toEqual(["dst:a"]);
  });

  it("không subscription nhưng còn traffic/thử lại trong cửa sổ -> vẫn coi là đang dùng (đang có việc)", () => {
    expect(unusedDestinationIds({ nodes: [dst("dst:a")], edges: [edge("dst:a", 3)] }).size).toBe(0);
    expect(unusedDestinationIds({ nodes: [dst("dst:a", "warning", { retrying: 2 })], edges: [] }).size).toBe(0);
  });

  it("M-B1: còn delivery DEAD trong DLQ (không subscription bật, không traffic) -> đang dùng, giữ badge CRASHED", () => {
    const ids = unusedDestinationIds({
      nodes: [dst("dst:a", "crashed", { dead: 4, circuitState: "CLOSED" }), sub("sub:1", "a", false)],
      edges: [],
    });
    expect(ids.size).toBe(0);
  });

  it("M-B1: circuit OPEN hoặc HALF_OPEN (không subscription bật) -> đang dùng", () => {
    for (const circuitState of ["OPEN", "HALF_OPEN"]) {
      const ids = unusedDestinationIds({ nodes: [dst("dst:a", "crashed", { dead: 0, circuitState })], edges: [] });
      expect(ids.size).toBe(0);
    }
  });

  it("M-B1: dead=0 và circuit CLOSED, không subscription bật -> vẫn không dùng", () => {
    const ids = unusedDestinationIds({ nodes: [dst("dst:a", "idle", { dead: 0, circuitState: "CLOSED" })], edges: [] });
    expect([...ids]).toEqual(["dst:a"]);
  });
});
