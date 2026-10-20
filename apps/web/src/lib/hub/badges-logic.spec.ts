import {
  addLive,
  applyServer,
  BADGE_CAP,
  type BadgesResponse,
  badgeTabOfPath,
  claimId,
  emptyBadges,
  formatBadge,
  markSeen,
  rememberIds,
  rememberName,
  resetBadges,
  seenKey,
} from "./badges-logic";

const ev = { type: "payment.received", source: "payos", at: "2026-10-19T03:00:00.000Z" };

describe("badges-logic (ADR-269)", () => {
  it('formatBadge: 0 ẩn, 1..9 hiện số, >9 là "9+"', () => {
    expect(formatBadge(0)).toBeNull();
    expect(formatBadge(-3)).toBeNull();
    expect(formatBadge(1)).toBe("1");
    expect(formatBadge(9)).toBe("9");
    expect(formatBadge(10)).toBe("9+");
    expect(formatBadge(BADGE_CAP)).toBe("9+");
  });

  it("badgeTabOfPath: chỉ ba tab có badge; Flow map và tab khác -> null", () => {
    expect(badgeTabOfPath("/dashboard/events")).toBe("events");
    expect(badgeTabOfPath("/dashboard/deliveries")).toBe("deliveries");
    expect(badgeTabOfPath("/dashboard/dlq")).toBe("dlq");
    expect(badgeTabOfPath("/dashboard/flow")).toBeNull();
    expect(badgeTabOfPath("/dashboard")).toBeNull();
    expect(badgeTabOfPath("/dashboard/eventsX")).toBeNull();
  });

  it("addLive: cộng dồn, kẹp ở 10, giữ bản mới nhất", () => {
    let s = emptyBadges();
    s = addLive(s, "events", 3, ev, null);
    s = addLive(s, "events", 20, { ...ev, type: "repo.push" }, null);
    expect(s.counts.events).toBe(BADGE_CAP);
    expect(s.latest.events?.type).toBe("repo.push");
  });

  it("addLive: đang đứng ở chính tab đó thì không tăng; n<=0 bỏ qua", () => {
    const s = emptyBadges();
    expect(addLive(s, "events", 5, ev, "events")).toBe(s);
    expect(addLive(s, "dlq", 0, { destination: "d", attemptNo: 1, at: "x" }, null)).toBe(s);
    expect(addLive(s, "events", 5, ev, "dlq").counts.events).toBe(5);
  });

  it("applyServer: ghi đè đếm; tab đang mở luôn 0; count 0 -> không giữ latest", () => {
    const r: BadgesResponse = {
      events: { count: 4, ids: [], latest: ev, cursor: "9" },
      deliveries: { count: 0, ids: [], latest: null, cursor: null },
      dlq: { count: 10, ids: [], latest: { destination: "Shop", attemptNo: 5, at: "x" }, cursor: "x" },
    };
    const s = applyServer(
      addLive(emptyBadges(), "deliveries", 2, { destination: "a", status: "SUCCEEDED", at: "x" }, null),
      r,
      "dlq",
    );
    expect(s.counts).toEqual({ events: 4, deliveries: 0, dlq: 0 });
    expect(s.latest.deliveries).toBeNull();
    expect(s.latest.dlq).toBeNull();
    expect(s.latest.events).toEqual(ev);
  });

  it("markSeen: về 0 và bỏ latest của tab đó, tab khác giữ nguyên", () => {
    let s = addLive(emptyBadges(), "events", 2, ev, null);
    s = addLive(s, "dlq", 1, { destination: "d", attemptNo: 2, at: "x" }, null);
    const m = markSeen(s, "events");
    expect(m.counts).toEqual({ events: 0, deliveries: 0, dlq: 1 });
    expect(m.latest.events).toBeNull();
    expect(m.latest.dlq).not.toBeNull();
  });

  it("đổi project: resetBadges sạch hết; khoá mốc tách theo user/project/tab", () => {
    expect(resetBadges()).toEqual(emptyBadges());
    expect(seenKey("u1", "p1", "dlq")).toBe("hub:seen:u1:p1:dlq");
    expect(seenKey("u1", "p2", "dlq")).not.toBe(seenKey("u1", "p1", "dlq"));
    expect(seenKey("u2", "p1", "dlq")).not.toBe(seenKey("u1", "p1", "dlq"));
  });

  it("rememberName: giới hạn kích thước, bỏ cái cũ nhất", () => {
    const m = new Map<string, string>();
    for (let i = 0; i < 5; i++) rememberName(m, `id${i}`, `n${i}`, 3);
    expect([...m.keys()]).toEqual(["id2", "id3", "id4"]);
  });

  it("claimId: id đã được poll đếm thì socket báo lại bị bỏ qua; id mới thì tính một lần", () => {
    const seen = new Set<string>();
    rememberIds(seen, ["d1", "d2"]); // server đã đếm
    expect(claimId(seen, "d1")).toBe(false); // socket báo lại -> không cộng đôi
    expect(claimId(seen, "d3")).toBe(true); // mới
    expect(claimId(seen, "d3")).toBe(false); // lặp lại
  });

  it("claimId/rememberIds: có trần, bỏ id cũ nhất", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 5; i++) claimId(seen, `x${i}`, 3);
    expect([...seen]).toEqual(["x2", "x3", "x4"]);
    rememberIds(seen, ["x2", "y"], 3); // x2 làm mới thành "mới nhất"
    expect([...seen]).toEqual(["x4", "x2", "y"]);
  });
});
