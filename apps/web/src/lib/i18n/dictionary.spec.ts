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
    expect(pairs.length).toBe(17); // 5 nhóm + 12 mục
    for (const [, id, kind, key] of pairs) {
      expect(key).toBe(`nav.${kind === "labelKey" ? "group" : "item"}.${id}`);
      expect(base).toContain(key);
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
