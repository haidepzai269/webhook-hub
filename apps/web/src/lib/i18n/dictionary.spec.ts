import * as fs from "fs";
import * as path from "path";

import { createT, DEFAULT_LOCALE, DICTIONARIES, isLocale, LOCALES, nextLocale, translate } from "./dictionary";

/** Từ điển admin (sidebar vi/en): đủ khoá ở mọi locale, nhãn một ngôn ngữ, khớp id trong sidebar-items. */
describe("i18n dictionary", () => {
  const base = Object.keys(DICTIONARIES[DEFAULT_LOCALE]).sort();

  it.each(LOCALES)("locale %s có đúng bộ khoá của vi, không chuỗi rỗng", (locale) => {
    const dict = DICTIONARIES[locale];
    expect(Object.keys(dict).sort()).toEqual(base);
    for (const [key, value] of Object.entries(dict)) {
      expect({ key, empty: value.trim() === "" }).toEqual({ key, empty: false });
    }
  });

  it("mọi khoá có dạng <namespace>.<tên> (chữ thường, '.', '-')", () => {
    for (const key of base) expect(key).toMatch(/^[a-z][a-z0-9-]*(\.[a-z0-9-]+)+$/);
  });

  it("biến {x} ở vi và en giống nhau từng khoá", () => {
    const vars = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const key of base) {
      const k = key as keyof (typeof DICTIONARIES)["vi"];
      expect({ key, vars: vars(DICTIONARIES.en[k]) }).toEqual({ key, vars: vars(DICTIONARIES.vi[k]) });
    }
  });

  it("nhãn điều hướng không kèm ngôn ngữ kia trong ngoặc", () => {
    for (const locale of LOCALES) {
      for (const [key, value] of Object.entries(DICTIONARIES[locale])) {
        if (key.startsWith("nav.")) expect({ key, value, paren: /[()]/.test(value) }).toMatchObject({ paren: false });
      }
    }
  });

  it("mọi id nhóm/mục trong sidebar-items.ts có khoá nav.group.<id> / nav.item.<id>", () => {
    const src = fs.readFileSync(path.join(__dirname, "../../components/admin/sidebar-items.ts"), "utf8");
    const pairs = [...src.matchAll(/id: "([\w-]+)",\s*(labelKey|titleKey): "([\w.-]+)"/g)];
    expect(pairs.length).toBe(19); // 5 nhóm + 14 mục (CB4: + Cảnh báo, CB5: + Cài đặt — chỉ operator; QT7: + Dung lượng; ADR-234: − Dự án)
    for (const [, id, kind, key] of pairs) {
      expect(key).toBe(`nav.${kind === "labelKey" ? "group" : "item"}.${id}`);
      expect(base).toContain(key);
    }
  });

  it("en không chứa dấu tiếng Việt (trừ tên ngôn ngữ viết bằng chính nó)", () => {
    const allow = new Set<string>(["common.language.vi"]);
    for (const [key, value] of Object.entries(DICTIONARIES.en)) {
      if (allow.has(key)) continue;
      expect({ key, value, vi: /[à-ỹđ]/i.test(value) }).toMatchObject({ vi: false });
    }
  });

  it("vi không lẫn từ giao diện tiếng Anh (trừ định danh kỹ thuật: kiểu sự kiện, scope, MÃ_HOA, `code`)", () => {
    const DENY = [
      "source",
      "sources",
      "destination",
      "destinations",
      "endpoint",
      "endpoints",
      "subscription",
      "subscriptions",
      "provider",
      "providers",
      "replay",
      "retry",
      "delivery",
      "deliveries",
      "event",
      "events",
      "payload",
      "project",
      "projects",
      "dashboard",
      "playground",
      "normalize",
      "ingest",
      "routing",
      "status",
      "success",
      "failed",
      "error",
      "loading",
      "filter",
      "realtime",
      "operator",
      "toggle",
      "sidebar",
    ];
    // Khoá được phép giữ từ tiếng Anh (định danh kỹ thuật đứng một mình) — giữ danh sách này ngắn.
    const allow = new Set<string>([]);
    const stripTechnical = (s: string) =>
      s
        .replace(/`[^`]*`/g, " ") // `mã`
        .replace(/\{\w+\}/g, " ") // {biến}
        .replace(/\S*[\w-]+[.:_/][\w./:*-]+\S*/g, " ") // payment.succeeded, read:events, /v1/p/…, HUB_URL, URL
        .replace(/\b[A-Z][A-Z0-9_-]+\b/g, " "); // PENDING, DEAD, HMAC…
    for (const [key, value] of Object.entries(DICTIONARIES.vi)) {
      if (allow.has(key)) continue;
      const words = stripTechnical(value).toLowerCase().match(/[a-z-]+/g) ?? [];
      const hits = words.filter((w) => DENY.includes(w) || w === "fan-out");
      expect({ key, value, hits }).toEqual({ key, value, hits: [] });
    }
  });

  it("BB-1: không giá trị nào (mọi locale) nói tới đơn hàng — hub không biết nghiệp vụ của Shop", () => {
    for (const locale of LOCALES) {
      for (const [key, value] of Object.entries(DICTIONARIES[locale])) {
        const hit = /đơn hàng|\borders?\b|\border[-_.]?(code|id)\b/i.test(value);
        expect({ locale, key, value, hit }).toMatchObject({ hit: false });
      }
    }
  });

  it("translate thay {biến}, giữ nguyên biến lạ; nextLocale xoay vòng vi ⇄ en", () => {
    expect(translate("en", "header.theme.aria", { mode: "Dark" })).toBe("Theme: Dark. Click to change");
    expect(translate("vi", "header.theme.aria")).toBe("Giao diện: {mode}. Bấm để đổi");
    expect(createT("en")("nav.item.dlq")).toBe("Dead-letter queue");
    expect(nextLocale("vi")).toBe("en");
    expect(nextLocale("en")).toBe("vi");
    expect(isLocale("en")).toBe(true);
    expect(isLocale("fr")).toBe(false);
  });
});
