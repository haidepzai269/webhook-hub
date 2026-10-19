import { buildJourneyList, isIntentionalStop } from "./journey-list-logic";

type StageView = { id: string; key: string; status: string; offsetMs: number | null; reason?: { code: string } };
type FlowBranch = { deliveryId: string; stages: StageView[] };

const st = (p: Partial<StageView> & Pick<StageView, "id" | "key">): StageView => ({ status: "ok", offsetMs: null, ...p });

describe("buildJourneyList", () => {
  const stages = [
    st({ id: "received", key: "received", offsetMs: 0 }),
    st({ id: "verified", key: "verified", offsetMs: 5 }),
    st({ id: "routed", key: "routed", offsetMs: 40 }),
  ];
  const branch = {
    deliveryId: "d1",
    stages: [
      st({ id: "d1:queued", key: "delivering", offsetMs: 100 }),
      st({ id: "d1:attempt:1", key: "delivering", offsetMs: 160, status: "failed" }),
      st({ id: "d1:done", key: "done", offsetMs: 160, status: "failed" }),
    ],
  } as FlowBranch;

  it("mốc +ms so với chặng trước; nhánh tính từ Định tuyến", () => {
    const r = buildJourneyList(stages, [branch]);
    expect(r.steps.map((s) => s.deltaMs)).toEqual([0, 5, 35]);
    expect(r.branches[0].steps.map((s) => s.deltaMs)).toEqual([60, 60, 0]);
    expect(r.branches[0].attempts).toBe(1);
  });

  it("thiếu offset thì deltaMs null; không nhánh thì danh sách nhánh rỗng", () => {
    const r = buildJourneyList([st({ id: "received", key: "received" })], []);
    expect(r.steps[0].deltaMs).toBeNull();
    expect(r.branches).toEqual([]);
  });

  it("Định tuyến skipped (không phải probe) là dừng chủ đích", () => {
    const stop = st({ id: "routed", key: "routed", status: "skipped" });
    expect(isIntentionalStop(stop)).toBe(true);
    expect(buildJourneyList([stop], []).steps[0].intentionalStop).toBe(true);
    const probe = st({ id: "routed", key: "routed", status: "skipped", reason: { code: "provider_probe" } });
    expect(isIntentionalStop(probe)).toBe(false);
  });
});
