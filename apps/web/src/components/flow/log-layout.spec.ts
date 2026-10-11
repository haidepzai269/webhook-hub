import {
  clampLogHeight,
  LOG_COLUMNS,
  LOG_HEIGHT_DEFAULT_FRAC,
  LOG_HEIGHT_MAX_FRAC,
  LOG_HEIGHT_MIN_FRAC,
  logGridTemplate,
  readLogHeight,
  writeLogHeight,
} from "./log-layout";

describe("log-layout — lưới cột cố định của Nhật ký sự kiện", () => {
  it("5 cột theo thứ tự thời gian | provider | chặng | type | kết quả", () => {
    expect(LOG_COLUMNS.map((c) => c.key)).toEqual(["time", "provider", "stages", "type", "result"]);
  });

  it("mọi cột trừ cột cuối có độ rộng CỐ ĐỊNH (không auto/fr/minmax) -> hàng có '1/1' không đẩy cột sau", () => {
    const tpl = logGridTemplate().split(" ");
    expect(tpl).toHaveLength(5);
    for (const w of tpl.slice(0, -1)) expect(w).toMatch(/^\d+(\.\d+)?rem$/);
    expect(tpl[4]).toBe("minmax(0,1fr)");
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
