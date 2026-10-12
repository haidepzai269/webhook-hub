import {
  clampLogHeight,
  LOG_COLUMNS,
  LOG_HEIGHT_DEFAULT_FRAC,
  LOG_HEIGHT_MAX_FRAC,
  LOG_HEIGHT_MIN_FRAC,
  logGridTemplate,
  logHeightAria,
  logMinWidth,
  readLogHeight,
  stepLogHeight,
  writeLogHeight,
} from "./log-layout";
import { createT } from "../../lib/i18n/dictionary";

describe("log-layout — lưới cột cố định của Nhật ký sự kiện", () => {
  it("6 cột theo thứ tự thời gian | provider | chặng | type | kết quả | ghi chú", () => {
    expect(LOG_COLUMNS.map((c) => c.key)).toEqual(["time", "provider", "stages", "type", "result", "note"]);
  });

  it("tiêu đề cột là khoá i18n, có chữ ở cả vi và en", () => {
    expect(LOG_COLUMNS.map((c) => createT("vi")(c.labelKey))).toEqual(["Thời gian", "Nhà cung cấp", "Chặng", "Kiểu", "Kết quả", "Ghi chú"]);
    expect(LOG_COLUMNS.map((c) => createT("en")(c.labelKey))).toEqual(["Time", "Provider", "Stages", "Type", "Outcome", "Note"]);
  });

  it("mọi cột trừ cột cuối KHÔNG phụ thuộc nội dung (rem hoặc minmax(rem,rem), không auto/fr) -> hàng có '1/1' không đẩy cột sau", () => {
    const tpl = logGridTemplate().split(" ");
    expect(tpl).toHaveLength(6);
    const rem = "\\d+(\\.\\d+)?rem";
    for (const w of tpl.slice(0, -1)) expect(w).toMatch(new RegExp(`^(${rem}|minmax\\(${rem},${rem}\\))$`));
    expect(tpl[5]).toMatch(/^minmax\(\d+(\.\d+)?rem,1fr\)$/);
  });

  it("chặng giữ bề rộng cố định (6 chấm + '2/3' không bị co); min-width = tổng min cột + khe + đệm", () => {
    expect(LOG_COLUMNS.find((c) => c.key === "stages")?.width).toBe("11rem");
    const mins = LOG_COLUMNS.reduce((n, c) => n + c.min, 0);
    expect(logMinWidth()).toBe(`${mins + 0.75 * 5 + 1.625}rem`);
  });

  it("cột Kết quả đủ rộng cho 'Giao → <tên đích> · HTTP 401' (≥ 15rem khi ngăn đủ chỗ); tổng tối đa các cột cố định chừa ≥ 10rem cho Ghi chú ở ngăn 1440px", () => {
    const maxRem = (w: string) => Number((w.match(/(\d+(?:\.\d+)?)rem\)?$/) ?? [])[1]);
    const result = LOG_COLUMNS.find((c) => c.key === "result");
    expect(maxRem(result?.width ?? "")).toBeGreaterThanOrEqual(15);
    const fixedMax = LOG_COLUMNS.slice(0, -1).reduce((n, c) => n + maxRem(c.width), 0);
    // Ngăn nhật ký ở 1440px ≈ 1440 - 256 (sidebar) - 2×16 (lề) ≈ 72rem; trừ khe + đệm.
    expect(72 - fixedMax - 0.75 * 5 - 1.625).toBeGreaterThanOrEqual(10);
  });

  it("clampLogHeight giữ trong [25%, 85%] viewport", () => {
    expect(LOG_HEIGHT_MIN_FRAC).toBe(0.25);
    expect(LOG_HEIGHT_MAX_FRAC).toBe(0.85);
    expect(clampLogHeight(10, 1000)).toBe(250);
    expect(clampLogHeight(2000, 1000)).toBe(850);
    expect(clampLogHeight(400, 1000)).toBe(400);
  });

  it("readLogHeight: không có / rác / storage ném lỗi -> mặc định; có giá trị -> clamp", () => {
    const store = (v: string | null) => ({ getItem: () => v, setItem: () => {} });
    expect(readLogHeight(store(null), 1000)).toBe(1000 * LOG_HEIGHT_DEFAULT_FRAC);
    expect(readLogHeight(store("abc"), 1000)).toBe(1000 * LOG_HEIGHT_DEFAULT_FRAC);
    expect(readLogHeight(store("5000"), 1000)).toBe(850);
    expect(readLogHeight(store("500"), 1000)).toBe(500);
    const throwing = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {},
    };
    expect(readLogHeight(throwing, 1000)).toBe(1000 * LOG_HEIGHT_DEFAULT_FRAC);
    expect(readLogHeight(null, 1000)).toBe(1000 * LOG_HEIGHT_DEFAULT_FRAC);
  });

  it("writeLogHeight nuốt lỗi storage", () => {
    const saved: Record<string, string> = {};
    writeLogHeight({ getItem: () => null, setItem: (k, v) => (saved[k] = v) }, 321.6);
    expect(Object.values(saved)).toEqual(["322"]);
    expect(() =>
      writeLogHeight(
        {
          getItem: () => null,
          setItem: () => {
            throw new Error("quota");
          },
        },
        300,
      ),
    ).not.toThrow();
  });
});

describe("log-layout — tay kéo bằng bàn phím (L-B3)", () => {
  const vh = 1000;
  it("ArrowUp cao thêm 5% viewport, ArrowDown thấp đi 5%, kẹp trong 25–85%", () => {
    expect(stepLogHeight(400, "ArrowUp", vh)).toBe(450);
    expect(stepLogHeight(400, "ArrowDown", vh)).toBe(350);
    expect(stepLogHeight(840, "ArrowUp", vh)).toBe(850);
    expect(stepLogHeight(260, "ArrowDown", vh)).toBe(250);
  });
  it("Home/End nhảy về min/max; phím khác -> null (không xử lý)", () => {
    expect(stepLogHeight(400, "Home", vh)).toBe(250);
    expect(stepLogHeight(400, "End", vh)).toBe(850);
    expect(stepLogHeight(400, "Enter", vh)).toBeNull();
  });
  it("aria-valuenow/min/max theo % viewport (số nguyên)", () => {
    expect(logHeightAria(333, vh)).toEqual({ now: 33, min: 25, max: 85 });
  });
});
