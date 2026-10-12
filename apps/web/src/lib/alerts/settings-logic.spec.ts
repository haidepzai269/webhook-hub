import { createT, DICTIONARIES, LOCALES } from "../i18n/dictionary";
import { ruleName } from "./message";
import {
  activePreset,
  emailSwitchState,
  presetRules,
  ruleDescriptionKey,
  ruleRows,
  toggleMuted,
  toggleRule,
  MUTE_LIST_COLLAPSED,
  muteListView,
} from "./settings-logic";
import { ALERT_RULE_CODES } from "./types";

/** CB5 (§8.5): mục "Cảnh báo" của trang Cài đặt — bảng phân loại, preset, khoá công tắc, tắt tiếng theo project. */
const CATALOG = [
  { code: "destination.auth_rejected", severity: "critical" as const },
  { code: "destination.failing", severity: "warning" as const },
  { code: "delivery.dead_spike", severity: "critical" as const },
  { code: "source.silent", severity: "warning" as const },
];

describe("trang Cài đặt — cảnh báo qua email", () => {
  it("bảng phân loại: mỗi luật một dòng, nghiêm trọng trước (giữ thứ tự danh mục), checkbox theo email_rules", () => {
    expect(ruleRows(CATALOG, ["delivery.dead_spike", "source.silent"])).toEqual([
      { code: "destination.auth_rejected", severity: "critical", checked: false },
      { code: "delivery.dead_spike", severity: "critical", checked: true },
      { code: "destination.failing", severity: "warning", checked: false },
      { code: "source.silent", severity: "warning", checked: true },
    ]);
  });

  it('"Chỉ nghiêm trọng" = mọi luật critical (mặc định), "Tất cả" = mọi luật; nút tô theo lựa chọn hiện tại', () => {
    expect(presetRules(CATALOG, "critical")).toEqual(["destination.auth_rejected", "delivery.dead_spike"]);
    expect(presetRules(CATALOG, "all")).toEqual(CATALOG.map((r) => r.code));
    expect(activePreset(CATALOG, ["delivery.dead_spike", "destination.auth_rejected"])).toBe("critical");
    expect(activePreset(CATALOG, presetRules(CATALOG, "all"))).toBe("all");
    expect(activePreset(CATALOG, ["source.silent"])).toBeNull();
  });

  it("bật/tắt một luật giữ thứ tự danh mục, không trùng; tắt tiếng project bật/tắt không trùng", () => {
    expect(toggleRule(CATALOG, ["delivery.dead_spike"], "destination.auth_rejected", true)).toEqual([
      "destination.auth_rejected",
      "delivery.dead_spike",
    ]);
    expect(toggleRule(CATALOG, ["delivery.dead_spike"], "delivery.dead_spike", true)).toEqual(["delivery.dead_spike"]);
    expect(toggleRule(CATALOG, ["delivery.dead_spike"], "delivery.dead_spike", false)).toEqual([]);
    expect(toggleMuted(["a"], "b", true)).toEqual(["a", "b"]);
    expect(toggleMuted(["a", "b"], "a", true)).toEqual(["b", "a"]);
    expect(toggleMuted(["a", "b"], "a", false)).toEqual(["b"]);
  });

  it("công tắc email: khoá + lý do khi email chưa xác minh / không có email; đang bật thì vẫn cho tắt", () => {
    expect(emailSwitchState({ email: "op@hub.vn", emailVerified: true, emailEnabled: false })).toEqual({
      disabled: false,
      reasonKey: null,
    });
    expect(emailSwitchState({ email: "op@hub.vn", emailVerified: false, emailEnabled: false })).toEqual({
      disabled: true,
      reasonKey: "page.settings.alerts.locked.unverified",
    });
    expect(emailSwitchState({ email: null, emailVerified: false, emailEnabled: false })).toEqual({
      disabled: true,
      reasonKey: "page.settings.alerts.locked.no-email",
    });
    expect(emailSwitchState({ email: "op@hub.vn", emailVerified: false, emailEnabled: true }).disabled).toBe(false);
  });

  it.each(LOCALES)("%s: mọi luật có tên + mô tả một câu trong từ điển", (locale) => {
    const t = createT(locale);
    for (const code of ALERT_RULE_CODES) {
      expect(ruleName(code, t)).not.toBe(code);
      expect(DICTIONARIES[locale][ruleDescriptionKey(code)]).toBeTruthy();
    }
  });
});

describe("trang Cài đặt — danh sách tắt email theo dự án (xem trên trình duyệt thật: ~120 dòng)", () => {
  const projects = Array.from({ length: 20 }, (_, i) => ({ id: `p${i}`, name: `Dự án ${i}`, slug: `slug-${i}` }));
  projects[5] = { id: "p5", name: "Cà phê Sáng", slug: "cafe-sang-very-long-slug" };

  it("thu gọn còn 8 dòng, dự án đang tắt lên đầu (giữ thứ tự gốc), phần còn lại đếm vào 'Hiện thêm'", () => {
    const v = muteListView(projects, ["p12", "p3"]);
    expect(MUTE_LIST_COLLAPSED).toBe(8);
    expect(v.rows.map((r) => r.id)).toEqual(["p3", "p12", "p0", "p1", "p2", "p4", "p5", "p6"]);
    expect(v.rows.slice(0, 2).every((r) => r.muted)).toBe(true);
    expect(v).toMatchObject({ matched: 20, hidden: 12 });
    expect(muteListView(projects, [], { expanded: true })).toMatchObject({ hidden: 0, matched: 20 });
  });

  it("tìm theo tên hoặc slug, không phân biệt hoa thường / dấu; đang tìm thì hiện mọi kết quả", () => {
    expect(muteListView(projects, [], { query: "  CA PHE " }).rows.map((r) => r.id)).toEqual(["p5"]);
    expect(muteListView(projects, [], { query: "very-long" }).rows.map((r) => r.id)).toEqual(["p5"]);
    const many = muteListView(projects, [], { query: "dự án" });
    expect(many).toMatchObject({ matched: 19, hidden: 0 });
    expect(muteListView(projects, [], { query: "zzz" })).toMatchObject({ rows: [], matched: 0, hidden: 0 });
  });
});
