import * as fs from "node:fs";
import * as path from "node:path";

import {
  ackAllIds,
  BANNER_RESOLVED_HOLD_MS,
  bannerAnnounceKey,
  bannerNextExpiry,
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
  resolveSubjectName,
  TOAST_NAME_TIMEOUT_MS,
  toastsToDismiss,
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
  unackedBySeverity: { critical: Math.min(critical, unacked), warning: Math.max(0, unacked - critical), info: 0 },
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

  it("review L1: màu theo mức CHƯA XEM — critical đã 'Đã xem' không tô đỏ; server cũ (thiếu unackedBySeverity) rơi về openBySeverity", () => {
    const s: AlertSummary = { openBySeverity: { critical: 1, warning: 2, info: 0 }, unacked: 2, unackedBySeverity: { critical: 0, warning: 2, info: 0 }, perProject: [] };
    expect(bellBadge(s)?.tone).toBe("warning");
    expect(bellBadge({ ...s, unackedBySeverity: undefined })?.tone).toBe("critical");
  });

  it("re-review CB4: 'đã xem tất cả' gửi đúng id CHƯA XEM đang hiện trong chuông (không theo mốc thời gian)", () => {
    const groups = groupForBell([alert("a", "warning"), alert("b", "critical", { acknowledgedAt: "2026-10-12T10:01:00Z" }), alert("c", "warning", { project: P2 })]);
    expect(ackAllIds(groups).sort()).toEqual(["a", "c"]);
    expect(ackAllIds([])).toEqual([]);
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
    // Mốc tường minh trước openedAt của fixture (10:00Z) — không dùng Date.now() (test hẹn giờ).
    takeArrivals(mem, [alert("c-old", "critical")], Date.parse("2026-10-12T09:59:00Z"));
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

  it("review L3: id lạ mở TRƯỚC mốc (lần đầu bị cắt ở 100 dòng) không phải 'vừa đến' — trừ khi có alert.changed của nó", () => {
    const mem = createFeedMemory();
    takeArrivals(mem, [alert("seen", "warning")], Date.parse("2026-10-12T12:00:00Z"));
    noteSocketNotice(mem, { id: "old-but-socket", state: "OPEN" });
    const fresh = takeArrivals(mem, [
      alert("old-truncated", "warning", { openedAt: "2026-10-12T09:00:00Z" }),
      alert("old-but-socket", "critical", { openedAt: "2026-10-12T09:00:00Z" }),
      alert("new", "warning", { openedAt: "2026-10-12T12:00:05Z" }),
    ]);
    expect(fresh.map((a) => a.id)).toEqual(["old-but-socket", "new"]);
  });

  it("review L4: toast gỡ khi cảnh báo được 'Đã xem' hoặc rời danh sách OPEN đầy đủ; danh sách bị cắt chỉ gỡ theo 'Đã xem'", () => {
    const mem = createFeedMemory();
    mem.toasted = new Set(["acked", "gone", "still"]);
    const rows = [alert("acked", "critical", { acknowledgedAt: "2026-10-12T10:01:00Z" }), alert("still", "critical")];
    expect(toastsToDismiss(mem, rows, false)).toEqual(["acked"]);
    expect(toastsToDismiss(mem, rows, true)).toEqual(["gone"]);
    expect([...mem.toasted]).toEqual(["still"]);
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

  it("review TB2: A đóng -> C đến rồi đóng: mỗi banner xanh thu đúng hạn của nó, không cái nào treo mãi", () => {
    let b = bannerAdd(emptyBanner(), alert("A", "critical"));
    b = bannerResolve(b, "A", 0);
    expect(bannerNextExpiry(b)).toBe(BANNER_RESOLVED_HOLD_MS);
    b = bannerAdd(b, alert("C", "critical")); // C đè lên banner xanh của A
    b = bannerResolve(b, "C", 1_000);
    expect(b.entries.map((e) => [e.alert.id, e.phase])).toEqual([
      ["C", "resolved"],
      ["A", "resolved"],
    ]);
    // Hẹn theo hạn sớm nhất (A), thu xong thì hạn mới là của C — hẹn lại.
    expect(bannerNextExpiry(b)).toBe(BANNER_RESOLVED_HOLD_MS);
    b = bannerExpire(b, BANNER_RESOLVED_HOLD_MS);
    expect(b.entries.map((e) => e.alert.id)).toEqual(["C"]);
    expect(bannerNextExpiry(b)).toBe(1_000 + BANNER_RESOLVED_HOLD_MS);
    b = bannerExpire(b, 1_000 + BANNER_RESOLVED_HOLD_MS);
    expect(selectBanner(b)).toEqual({ primary: null, more: 0 });
    expect(bannerNextExpiry(b)).toBeNull();
  });

  it("review TB3: khoá thông báo đọc màn hình chỉ đổi khi cảnh báo mới hiện hoặc khi đã ổn — poll cập nhật số liệu không đổi khoá", () => {
    const b = bannerAdd(emptyBanner(), alert("c1", "critical"));
    const k1 = bannerAnnounceKey(selectBanner(b).primary);
    const polled = bannerSync(b, [alert("c1", "critical", { facts: { count: 9 }, lastSeenAt: "2026-10-12T10:02:00Z" })], true, 5);
    expect(bannerAnnounceKey(selectBanner(polled).primary)).toBe(k1);
    expect(bannerAnnounceKey(selectBanner(bannerResolve(b, "c1", 5)).primary)).toBe("c1:resolved");
    expect(bannerAnnounceKey(null)).toBeNull();
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

describe("toast: tên đích của project khác có trước khi hiện (xem trên trình duyệt thật)", () => {
  const dest = { subjectType: "destination" as const, subjectId: "1cc4de59-cb00-4d9d-b250-c8407144e551" };
  const none = () => null;

  it("đã biết -> trả ngay, không tải; cấp dự án -> null, không tải", async () => {
    const load = jest.fn();
    await expect(resolveSubjectName(dest, () => "bookstore-endpoint", load)).resolves.toBe("bookstore-endpoint");
    await expect(resolveSubjectName({ subjectType: "project", subjectId: "p" }, none, load)).resolves.toBeNull();
    expect(load).not.toHaveBeenCalled();
  });

  it("chưa biết -> tải tên của project đó rồi tra; thiếu trong project -> null", async () => {
    const load = jest.fn(async () => (id: string) => (id === dest.subjectId ? "bookstore-endpoint" : null));
    await expect(resolveSubjectName(dest, none, load)).resolves.toBe("bookstore-endpoint");
    expect(load).toHaveBeenCalledTimes(1);
    await expect(resolveSubjectName({ ...dest, subjectId: "khac" }, none, load)).resolves.toBeNull();
  });

  it("tải lỗi hoặc quá hạn -> null (nhãn rơi về id ngắn), không treo toast", async () => {
    await expect(resolveSubjectName(dest, none, () => Promise.reject(new Error("401")))).resolves.toBeNull();
    const never = () => new Promise<(id: string) => string | null>(() => {});
    const t0 = Date.now();
    await expect(resolveSubjectName(dest, none, never, 20)).resolves.toBeNull();
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(TOAST_NAME_TIMEOUT_MS).toBeLessThanOrEqual(2000);
  });
});
