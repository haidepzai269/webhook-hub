import {
  composeLocal,
  dateToYmd,
  DEFAULT_TIME,
  formatYmd,
  isValidYmd,
  parseDateText,
  parseTimeText,
  splitLocal,
  ymdToDate,
} from "./date-input";
import { isoToLocalInput, localInputToIso, localInputToIsoEnd } from "./list-url";

describe("date-input (ô ngày/giờ gõ tay, ADR-266)", () => {
  it("isValidYmd: chỉ nhận ngày có thật", () => {
    expect(isValidYmd("2026-10-19")).toBe(true);
    expect(isValidYmd("2028-02-29")).toBe(true);
    expect(isValidYmd("2026-02-29")).toBe(false);
    expect(isValidYmd("2026-04-31")).toBe(false);
    expect(isValidYmd("2026-13-01")).toBe(false);
    expect(isValidYmd("19/10/2026")).toBe(false);
    expect(isValidYmd("")).toBe(false);
  });

  it("formatYmd: vi dd/MM/yyyy, en MM/dd/yyyy; sai/rỗng -> rỗng", () => {
    expect(formatYmd("2026-10-05", "vi")).toBe("05/10/2026");
    expect(formatYmd("2026-10-05", "en")).toBe("10/05/2026");
    expect(formatYmd("", "vi")).toBe("");
    expect(formatYmd("rác", "en")).toBe("");
  });

  it("parseDateText: theo khuôn của ngôn ngữ, nhận 1–2 chữ số và dấu / - .", () => {
    expect(parseDateText("05/10/2026", "vi")).toBe("2026-10-05");
    expect(parseDateText("5/1/2026", "vi")).toBe("2026-01-05");
    expect(parseDateText("5-1-2026", "vi")).toBe("2026-01-05");
    expect(parseDateText("5.1.2026", "vi")).toBe("2026-01-05");
    // cùng chữ, khác ngôn ngữ -> khác ngày (en: tháng trước)
    expect(parseDateText("05/10/2026", "en")).toBe("2026-05-10");
    expect(parseDateText("10/25/2026", "en")).toBe("2026-10-25");
    expect(parseDateText("25/10/2026", "en")).toBeNull();
    expect(parseDateText("  ", "vi")).toBe("");
  });

  it("parseDateText: sai khuôn / ngày không có thật -> null", () => {
    for (const bad of ["31/04/2026", "29/02/2026", "00/10/2026", "10/00/2026", "5/1/26", "2026-10-05", "ab/cd/efgh", "5/1"]) {
      expect({ bad, r: parseDateText(bad, "vi") }).toEqual({ bad, r: null });
    }
    expect(parseDateText("29/02/2028", "vi")).toBe("2028-02-29");
  });

  it("parseTimeText: 24 giờ, H:mm / HH:mm / HHmm; sai -> null", () => {
    expect(parseTimeText("09:05")).toBe("09:05");
    expect(parseTimeText("9:05")).toBe("09:05");
    expect(parseTimeText("0905")).toBe("09:05");
    expect(parseTimeText("23:59")).toBe("23:59");
    expect(parseTimeText("")).toBe("");
    for (const bad of ["24:00", "12:60", "9:5", "ab", "12", "1:2:3"]) expect(parseTimeText(bad)).toBeNull();
  });

  it("composeLocal/splitLocal: giờ mặc định theo đầu; đi vòng với isoToLocalInput", () => {
    expect(composeLocal("", "10:30", "start")).toBe("");
    expect(composeLocal("2026-10-19", "", "start")).toBe(`2026-10-19T${DEFAULT_TIME.start}`);
    expect(composeLocal("2026-10-19", "", "end")).toBe(`2026-10-19T${DEFAULT_TIME.end}`);
    expect(composeLocal("2026-10-19", "08:30", "end")).toBe("2026-10-19T08:30");
    expect(splitLocal("2026-10-19T08:30")).toEqual({ ymd: "2026-10-19", hm: "08:30" });
    expect(splitLocal("")).toEqual({ ymd: "", hm: "" });
    expect(splitLocal("rác")).toEqual({ ymd: "", hm: "" });
  });

  it("giữ hợp đồng URL: từ ô mới ra cùng ISO như datetime-local cũ; 'Đến' gồm cả phút (…:59.999)", () => {
    const local = composeLocal("2026-10-12", "08:30", "start");
    const iso = localInputToIso(local);
    expect(isoToLocalInput(iso)).toBe("2026-10-12T08:30");
    const end = localInputToIsoEnd(composeLocal("2026-10-12", "10:30", "end"));
    expect(end && new Date(end).getSeconds()).toBe(59);
    expect(end && new Date(end).getMilliseconds()).toBe(999);
    expect(splitLocal(isoToLocalInput(end))).toEqual({ ymd: "2026-10-12", hm: "10:30" });
  });

  it("dateToYmd/ymdToDate đi vòng theo giờ máy", () => {
    const d = ymdToDate("2026-10-19");
    expect(d && dateToYmd(d)).toBe("2026-10-19");
    expect(ymdToDate("2026-02-30")).toBeUndefined();
  });
});
