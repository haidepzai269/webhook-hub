import * as fs from "node:fs";
import * as path from "node:path";

import {
  BANNER_RESOLVED_HOLD_MS,
  bannerAck,
  bannerAdd,
  bannerExpire,
  bannerMotion,
  bannerResolve,
  bannerSync,
  bellBadge,
  createFeedMemory,
  emptyBanner,
  groupForBell,
  noteSocketNotice,
  routeArrival,
  selectBanner,
  takeArrivals,
  WARNING_TOAST_MS,
} from "./notify-logic";
import type { AlertSeverity, AlertSummary, AlertView } from "./types";

const P1 = { id: "p1", slug: "cafe", name: "Cafe" };
const P2 = { id: "p2", slug: "bookstore", name: "Bookstore" };

function alert(id: string, severity: AlertSeverity, over: Partial<AlertView> = {}): AlertView {
  return {
    id,
    rule: severity === "critical" ? "destination.auth_rejected" : "destination.failing",
    severity,
    titleKey: "alerts.rules.x.title",
    subjectType: "destination",
    subjectId: "00000000-0000-4000-8000-000000000001",
    state: "OPEN",
    openedAt: "2026-10-12T10:00:00.000Z",
    lastSeenAt: "2026-10-12T10:00:00.000Z",
    resolvedAt: null,
    acknowledgedAt: null,
    acknowledgedBy: null,
    facts: {},
    project: P1,
    ...over,
  };
}

const summary = (unacked: number, critical: number, warning: number, perProject: AlertSummary["perProject"] = []): AlertSummary => ({
  openBySeverity: { critical, warning, info: 0 },
  unacked,
  perProject,
});

describe("chuông: badge từ summary", () => {
  it("0 chưa xem -> không badge; có critical -> đỏ; chỉ warning -> hổ phách; >99 -> 99+", () => {
    expect(bellBadge(undefined)).toBeNull();
    expect(bellBadge(summary(0, 2, 1))).toBeNull();
    expect(bellBadge(summary(3, 1, 2))).toEqual({ count: 3, label: "3", tone: "critical" });
    expect(bellBadge(summary(2, 0, 2))).toEqual({ count: 2, label: "2", tone: "warning" });
    expect(bellBadge(summary(150, 0, 150))?.label).toBe("99+");
  });
});

describe("chuông: nhóm theo project", () => {
  it("critical trước rồi mới nhất trong nhóm; nhóm có critical lên đầu; đếm theo summary; bỏ RESOLVED; cắt perGroup", () => {
    const rows = [
      alert("w-old", "warning", { project: P1, openedAt: "2026-10-12T09:00:00Z" }),
      alert("w-new", "warning", { project: P1, openedAt: "2026-10-12T11:00:00Z" }),
      alert("c1", "critical", { project: P1, openedAt: "2026-10-12T08:00:00Z" }),
      alert("w-p2", "warning", { project: P2, openedAt: "2026-10-12T12:00:00Z" }),
      alert("gone", "critical", { project: P2, state: "RESOLVED" }),
    ];
    const s = summary(4, 1, 3, [
      { project: P1, critical: 1, warning: 4, info: 0, unacked: 3 },
      { project: P2, critical: 0, warning: 1, info: 0, unacked: 1 },
    ]);
    const g = groupForBell(rows, s, 2);
    expect(g.map((x) => x.project.id)).toEqual(["p1", "p2"]);
    expect(g[0].items.map((i) => i.id)).toEqual(["c1", "w-new"]);
    expect(g[0]).toMatchObject({ count: 5, critical: 1, more: 3 });
    expect(g[1].items.map((i) => i.id)).toEqual(["w-p2"]);
    // Không có critical ở đâu -> nhóm có cảnh báo mới nhất lên trước.
    const g2 = groupForBell([alert("a", "warning", { project: P1, openedAt: "2026-10-12T01:00:00Z" }), alert("b", "warning", { project: P2 })]);
    expect(g2.map((x) => x.project.id)).toEqual(["p2", "p1"]);
  });
});

describe("[CB:T15] banner/toast chỉ cho cảnh báo MỚI trong phiên", () => {
  it("lần tải đầu là mốc: cảnh báo cũ lúc tải trang không bật banner hay toast (kể cả critical)", () => {
    const mem = createFeedMemory();
    const old = [alert("c-old", "critical"), alert("w-old", "warning")];
    expect(takeArrivals(mem, old)).toEqual([]);
    // Tải lại cùng dữ liệu (poll 30s) -> vẫn không có gì mới.
    expect(takeArrivals(mem, old)).toEqual([]);
  });

  it("critical mới có alert.changed trong phiên -> banner; critical chỉ thấy qua poll (project khác) -> toast dính; warning -> toast 6s; info/đã xem -> không", () => {
    const mem = createFeedMemory();
    takeArrivals(mem, [alert("c-old", "critical")]);
    noteSocketNotice(mem, { id: "c-new", state: "OPEN" });
    const fresh = takeArrivals(mem, [
      alert("c-old", "critical"),
      alert("c-new", "critical"),
      alert("c-other", "critical", { project: P2 }),
      alert("w-new", "warning"),
      alert("i-new", "info"),
      alert("c-acked", "critical", { acknowledgedAt: "2026-10-12T10:01:00Z" }),
    ]);
    expect(fresh.map((a) => a.id)).toEqual(["c-new", "c-other", "w-new", "i-new"]);
    const routes = Object.fromEntries(fresh.map((a) => [a.id, routeArrival(a, mem)]));
    expect(routes["c-new"]).toEqual({ kind: "banner" });
    expect(routes["c-other"]).toEqual({ kind: "toast", durationMs: Number.POSITIVE_INFINITY });
    expect(routes["w-new"]).toEqual({ kind: "toast", durationMs: WARNING_TOAST_MS });
    expect(routes["i-new"]).toEqual({ kind: "none" });
    // Đã báo một lần thì không báo lại.
    expect(takeArrivals(mem, fresh)).toEqual([]);
  });

  it("alert.changed RESOLVED không bao giờ ra toast và không mở banner", () => {
    const mem = createFeedMemory();
    noteSocketNotice(mem, { id: "x", state: "RESOLVED" });
    expect(mem.socketOpened.has("x")).toBe(false);
    expect(routeArrival(alert("x", "warning", { state: "RESOLVED" }), mem)).toEqual({ kind: "none" });
  });

  it("nhiều critical -> MỘT banner (mới nhất) + '+k'; ack bỏ khỏi banner; cái trong +k đóng thì bỏ luôn", () => {
    let b = emptyBanner();
    b = bannerAdd(b, alert("c1", "critical"));
    b = bannerAdd(b, alert("c2", "critical"));
    b = bannerAdd(b, alert("c3", "critical"));
    b = bannerAdd(b, alert("c3", "critical")); // trùng -> bỏ qua
    expect(selectBanner(b).primary?.alert.id).toBe("c3");
    expect(selectBanner(b).more).toBe(2);
    b = bannerResolve(b, "c1", 0);
    expect(selectBanner(b)).toMatchObject({ more: 1 });
    expect(b.entries.map((e) => e.alert.id)).toEqual(["c3", "c2"]);
    b = bannerAck(b, "c3");
    expect(selectBanner(b).primary?.alert.id).toBe("c2");
    expect(selectBanner(b).more).toBe(0);
  });

  it("RESOLVED của banner đang hiện -> xanh 'đã ổn' giữ 4s rồi thu lại; +k không tính banner xanh", () => {
    let b = bannerAdd(bannerAdd(emptyBanner(), alert("c1", "critical")), alert("c2", "critical"));
    b = bannerResolve(b, "c2", 1_000);
    expect(selectBanner(b).primary).toMatchObject({ phase: "resolved", resolvedAt: 1_000 });
    expect(selectBanner(b).more).toBe(1);
    expect(bannerExpire(b, 1_000 + BANNER_RESOLVED_HOLD_MS - 1)).toBe(b);
    b = bannerExpire(b, 1_000 + BANNER_RESOLVED_HOLD_MS);
    expect(selectBanner(b).primary?.alert.id).toBe("c1");
    expect(selectBanner(b).primary?.phase).toBe("open");
    b = bannerExpire(bannerResolve(b, "c1", 9_000), 9_000 + BANNER_RESOLVED_HOLD_MS);
    expect(selectBanner(b)).toEqual({ primary: null, more: 0 });
  });

  it("đối chiếu danh sách OPEN: đã xem ở nơi khác -> bỏ; vắng mặt khi danh sách ĐẦY ĐỦ -> đã ổn; bị cắt thì không đoán", () => {
    const b = bannerAdd(bannerAdd(emptyBanner(), alert("c1", "critical")), alert("c2", "critical"));
    const acked = bannerSync(b, [alert("c1", "critical"), alert("c2", "critical", { acknowledgedAt: "2026-10-12T10:05:00Z" })], true, 5);
    expect(acked.entries.map((e) => e.alert.id)).toEqual(["c1"]);
    const vanished = bannerSync(b, [alert("c1", "critical")], true, 5);
    expect(selectBanner(vanished).primary).toMatchObject({ phase: "resolved", resolvedAt: 5 });
    expect(bannerSync(b, [alert("c1", "critical")], false, 5)).toBe(b);
    // Poll không đổi gì -> cùng state (không vẽ lại banner).
    expect(bannerSync(b, [alert("c1", "critical"), alert("c2", "critical")], true, 5)).toBe(b);
    // Còn OPEN -> số liệu mới được cập nhật vào banner.
    const fresh = bannerSync(b, [alert("c1", "critical"), alert("c2", "critical", { facts: { count: 9 }, lastSeenAt: "2026-10-12T10:01:00.000Z" })], true, 5);
    expect(fresh.entries[0].alert.facts).toEqual({ count: 9 });
  });

  it("prefers-reduced-motion: chỉ mờ dần, không trượt (keyframes fade không có transform)", () => {
    expect(bannerMotion(false)).toEqual({ enter: "alert-slide-in", exit: "alert-slide-out", durationMs: 200 });
    const reduced = bannerMotion(true);
    expect(reduced).toEqual({ enter: "alert-fade-in", exit: "alert-fade-out", durationMs: 200 });
    const css = fs.readFileSync(path.join(__dirname, "../../styles/alerts.css"), "utf8");
    for (const name of [reduced.enter, reduced.exit]) {
      const block = css.match(new RegExp(`@keyframes ${name} \\{([\\s\\S]*?)\\n\\}`))?.[1];
      expect(block).toBeDefined();
      expect(block).toMatch(/opacity/);
      expect(block).not.toMatch(/transform/);
    }
    expect(css).toMatch(/@keyframes alert-slide-in \{[\s\S]*?translateY/);
  });
});
