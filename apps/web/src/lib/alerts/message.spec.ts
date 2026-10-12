import { createT, LOCALES, type Locale } from "../i18n/dictionary";
import { factRows } from "./facts";
import { alertActions, primaryHref } from "./links";
import { buildAlertText, failingFixKey, formatDuration, ruleKey, ruleName, subjectLabel } from "./message";
import { ALERT_RULE_CODES, type AlertSubjectType } from "./types";

/** CB4: câu cảnh báo dựng phía client từ rule + facts (SPEC §4, §7) — đủ vi/en, không bao giờ in "undefined"/JSON. */
const NOW = Date.parse("2026-10-12T14:30:00Z");
const DEST = "3fa2c1d0-0000-4000-8000-000000000001";
const ctx = (locale: Locale, subjectName: string | null = "bookstore-orders") => ({ locale, now: NOW, subjectName });
const mk = (rule: string, facts: Record<string, unknown>, subjectType: AlertSubjectType = "destination") => ({ rule, facts, subjectType, subjectId: DEST });

const SAMPLE_FACTS: Record<string, Record<string, unknown>> = {
  "destination.auth_rejected": { count: 12, httpStatus: 401, sinceAt: "2026-10-12T14:02:00Z", dead: 12 },
  "destination.client_error": { count: 3, httpStatus: 422, sinceAt: "2026-10-12T14:02:00Z" },
  "destination.failing": { total: 20, failed: 14, pct: 70, byClass: { server_error: 4, no_response: 0, throttled: 10, unexpected: 0 } },
  "destination.circuit_open": { circuitState: "OPEN", halfOpenAt: "2026-10-12T14:35:00Z" },
  "delivery.dead_spike": { count: 14, windowFrom: "2026-10-12T13:30:00Z" },
  "source.signature_failing": { total: 10, failed: 8, pct: 80 },
  "source.connection_broken": { status: "DRIFTED", providerLabel: "payos", lastError: null, lastFix: null },
  "source.silent": { lastEventAt: "2026-10-12T11:30:00Z", silentMs: 10_800_000, medianGapMs: 600_000, thresholdMs: 21_600_000, baseline: 300 },
  "normalize.backlog": { count: 4 },
};

const SUBJECT_OF: Record<string, AlertSubjectType> = { source: "source", destination: "destination" };

describe("buildAlertText — mỗi luật, cả vi lẫn en", () => {
  it.each(LOCALES)("%s: mọi luật có title + fix, không lọt khoá thô / undefined / NaN / JSON", (locale) => {
    const t = createT(locale);
    for (const rule of ALERT_RULE_CODES) {
      const subjectType = SUBJECT_OF[rule.split(".")[0]] ?? "project";
      const x = buildAlertText(mk(rule, SAMPLE_FACTS[rule], subjectType), t, ctx(locale));
      for (const s of [x.title, x.message, x.fix, x.headline]) {
        expect({ rule, s, bad: /alerts\.|undefined|NaN|\{|\}/.test(s) }).toMatchObject({ bad: false });
      }
      expect({ rule, title: x.title.length > 0, fix: x.fix.length > 0 }).toEqual({ rule, title: true, fix: true });
      expect(ruleName(rule, t)).not.toBe(rule);
    }
  });

  it("destination.auth_rejected: câu như SPEC §2 — mã, số lần, từ lúc, số DEAD, nguyên nhân thường gặp", () => {
    const vi = buildAlertText(mk("destination.auth_rejected", SAMPLE_FACTS["destination.auth_rejected"]), createT("vi"), ctx("vi"));
    expect(vi.title).toBe("Bên nhận từ chối xác thực (401)");
    expect(vi.headline).toBe("bookstore-orders: Bên nhận từ chối xác thực (401)");
    expect(vi.message).toMatch(/^12 lần thử liên tiếp bị từ chối kể từ \d{2}:\d{2}\. 12 sự kiện đã DEAD/);
    expect(vi.fix).toMatch(/secret phía nhận đã đổi/);
    const en = buildAlertText(mk("destination.auth_rejected", SAMPLE_FACTS["destination.auth_rejected"]), createT("en"), ctx("en"));
    expect(en.title).toBe("Receiver rejected authentication (401)");
    expect(en.message).toMatch(/^12 attempts in a row rejected since .+\. 12 events went DEAD/);
  });

  it("destination.failing: tách theo loại — 429 trội -> 'bảo chậm lại' + hạ RPS; 3xx trội -> kiểm tra URL; luôn nói hub vẫn retry", () => {
    const vi = buildAlertText(mk("destination.failing", SAMPLE_FACTS["destination.failing"]), createT("vi"), ctx("vi"));
    expect(vi.title).toBe("Bên nhận lỗi hoặc chậm: 70% thất bại");
    expect(vi.message).toBe("14/20 lần thử trong 15 phút gần nhất thất bại: 10 lần bị bảo chậm lại, 4 lỗi 5xx. Hub vẫn đang tự thử lại giúp bạn.");
    expect(vi.fix).toMatch(/bảo chậm lại.*RPS/);
    const en = buildAlertText(mk("destination.failing", { ...SAMPLE_FACTS["destination.failing"], byClass: { unexpected: 9, server_error: 1 } }), createT("en"), ctx("en"));
    expect(en.fix).toMatch(/3xx: check the destination URL/);
    expect(failingFixKey({ no_response: 3, server_error: 3 })).toBe("alerts.rule.destination.failing.fix.server-error"); // hoà -> thứ tự cố định
    expect(failingFixKey(undefined)).toBe("alerts.rule.destination.failing.fix.server-error");
  });

  it("source.connection_broken: tên nhà cung cấp lấy từ facts (D5), không viết cứng; lastError/lastFix của server chỉ là dữ liệu thô (review L8)", () => {
    const t = createT("vi");
    const drifted = buildAlertText(mk("source.connection_broken", { status: "DRIFTED", providerLabel: "payos" }, "source"), t, ctx("vi"));
    expect(drifted.title).toBe("Webhook phía PayOS đã bị đổi hoặc gỡ");
    const other = buildAlertText(mk("source.connection_broken", { status: "FAILED", providerLabel: "acme", lastError: "HTTP 500", lastFix: "Kiểm tra khoá" }, "source"), t, ctx("vi"));
    expect(other.title).toBe("Kết nối Acme bị lỗi");
    expect(other.message).toBe("Hub không đăng ký được webhook với Acme.");
    expect(other.fix).toBe("Mở trang Nguồn và bấm Kết nối lại.");
    const enFailed = buildAlertText(mk("source.connection_broken", { status: "FAILED", providerLabel: "acme", lastError: "Lỗi xác thực", lastFix: "Kiểm tra khoá" }, "source"), createT("en"), ctx("en"));
    expect(`${enFailed.message} ${enFailed.fix}`).toBe("The hub could not register its webhook with Acme. Open Sources and click Reconnect.");
    // …nhưng vẫn hiện nguyên văn ở bảng số liệu.
    const raw = factRows({ lastError: "Lỗi xác thực", lastFix: "Kiểm tra khoá" }, createT("en"), { locale: "en", now: NOW });
    expect(raw.map((r) => [r.label, r.value])).toEqual([
      ["Last error", "Lỗi xác thực"],
      ["Suggested fix", "Kiểm tra khoá"],
    ]);
    const en = buildAlertText(mk("source.connection_broken", { status: "DRIFTED", providerLabel: "github" }, "source"), createT("en"), ctx("en"));
    expect(en.title).toBe("The webhook on GitHub's side was changed or removed");
  });

  it("source.silent: thời lượng tính theo `now`, nhịp bình thường từ baseline", () => {
    const vi = buildAlertText(mk("source.silent", SAMPLE_FACTS["source.silent"], "source"), createT("vi"), ctx("vi"));
    expect(vi.title).toBe("Nguồn im lặng 3 giờ");
    expect(vi.message).toMatch(/^Bình thường khoảng 10 phút có một sự kiện\. Sự kiện cuối lúc /);
    expect(buildAlertText(mk("source.silent", SAMPLE_FACTS["source.silent"], "source"), createT("en"), ctx("en")).title).toBe("Source silent for 3 h");
  });

  it("thiếu số liệu -> câu gọn, không 'undefined'; lý do đóng được dịch; luật lạ không vỡ", () => {
    const t = createT("vi");
    const bare = buildAlertText(mk("destination.auth_rejected", {}), t, ctx("vi", null));
    expect(bare.title).toBe("Bên nhận từ chối xác thực (401/403)");
    expect(bare.message).toBe("");
    expect(bare.subjectLabel).toBe("Đích 3fa2c1d0");
    const closed = buildAlertText(mk("destination.circuit_open", { reason: "archived" }), t, ctx("vi"));
    expect(closed.message).toMatch(/Đóng vì đối tượng đã bị lưu trữ hoặc xoá\.$/);
    expect(buildAlertText(mk("x.new_rule", {}), t, ctx("vi")).title).toBe("Cảnh báo x.new_rule");
    expect(ruleName("x.new_rule", t)).toBe("x.new_rule");
  });

  it("khoá theo luật: mã có '.' và '_' -> đoạn khoá chữ thường + '-'", () => {
    expect(ruleKey("destination.auth_rejected", "title")).toBe("alerts.rule.destination.auth-rejected.title");
    expect(subjectLabel({ subjectType: "project", subjectId: DEST }, createT("en"))).toBe("Whole project");
    expect(formatDuration(45_000, createT("en"))).toBe("45 s");
    expect(formatDuration(3 * 86_400_000, createT("vi"))).toBe("3 ngày");
  });

  it("BB-1: không câu nào (mọi luật, mọi ngôn ngữ) nói tới đơn hàng hay số tiền", () => {
    for (const locale of LOCALES) {
      for (const rule of ALERT_RULE_CODES) {
        const x = buildAlertText(mk(rule, SAMPLE_FACTS[rule]), createT(locale), ctx(locale));
        expect(`${x.title} ${x.message} ${x.fix}`).not.toMatch(/đơn hàng|\border|số tiền|amount|tiền về/i);
      }
    }
  });
});

describe("facts -> bảng đọc được", () => {
  it("nhãn đã dịch, giá trị định dạng; byClass tách thành dòng con; khoá lạ phẳng — không bao giờ JSON thô", () => {
    const t = createT("vi");
    const rows = factRows({ ...SAMPLE_FACTS["destination.failing"], reason: "inactive", extra: { a: 1, b: { c: 2 } } }, t, { locale: "vi", now: NOW });
    expect(rows.find((r) => r.key === "pct")).toMatchObject({ label: "Tỉ lệ thất bại", value: "70%" });
    expect(rows.filter((r) => r.nested).map((r) => [r.label, r.value])).toEqual([
      ["Lỗi 5xx", "4"],
      ["Bị bảo chậm lại (408/429)", "10"],
    ]);
    expect(rows.find((r) => r.key === "reason")?.value).toBe("Đóng vì đối tượng đã bị ngắt.");
    expect(rows.find((r) => r.key === "extra")).toMatchObject({ label: "extra", value: "a: 1; b: …" });
    for (const r of rows) expect(r.value).not.toMatch(/[{}"]/);
    const silent = factRows(SAMPLE_FACTS["source.silent"], createT("en"), { locale: "en", now: NOW });
    expect(silent.find((r) => r.key === "medianGapMs")).toMatchObject({ label: "Normal rhythm", value: "10 min" });
  });
});

describe("deep link theo luật", () => {
  it("lọc đúng đích/nguồn trên URL; mã HTTP từ facts; id lạ không ghép vào URL", () => {
    expect(alertActions(mk("destination.auth_rejected", { httpStatus: 401 }))[0].href).toBe(`/dashboard/deliveries?code=401&destination=${DEST}`);
    expect(alertActions(mk("destination.auth_rejected", {}))[2].href).toBe(`/dashboard/dlq?destination=${DEST}&errorKind=http_4xx`);
    expect(alertActions(mk("source.signature_failing", {}, "source"))[0].href).toBe(`/dashboard/events?source=${DEST}&status=rejected`);
    expect(alertActions(mk("delivery.dead_spike", {}, "project"))[0].href).toBe("/dashboard/dlq?age=1h");
    expect(alertActions({ rule: "destination.failing", subjectId: "x'><script>", facts: {} })[0].href).toBe("/dashboard/deliveries?status=RETRYING");
    expect(primaryHref({ rule: "x.new", subjectId: DEST, project: { id: "p1" } })).toBe("/dashboard/alerts?project=p1");
  });
});
