import { createT, DICTIONARIES, LOCALES } from "../i18n/dictionary";
import { HEALTH_REASON_KEYS, type ProjectStats, projectHealth, projectHealthLabel } from "./project-health";

/** ADR-235: viền thẻ dự án ở "Tất cả dự án" — đỏ / xanh / xám, kèm lý do đỏ. Hàm thuần, không React. */
const base: ProjectStats = {
  createdAt: "2026-10-01T03:00:00.000Z",
  sources: 2,
  endpoints: 1,
  members: 1,
  events24h: 10,
  failedAttempts24h: 0,
  dlq: 0,
  circuitOpen: 0,
  storageLevel: "OK",
  openAlerts: { critical: 0, warning: 0, info: 0 },
};
const s = (over: Partial<ProjectStats>): ProjectStats => ({ ...base, ...over });
const vi = createT("vi");
const en = createT("en");

describe("projectHealth — màu viền thẻ dự án", () => {
  it("có nguồn/đích, không sự cố -> xanh, không lý do", () => {
    expect(projectHealth(base)).toEqual({ tone: "ok", reasons: [] });
  });

  it("chỉ có nguồn (polling, chưa đích) hoặc chỉ có đích -> vẫn xanh", () => {
    expect(projectHealth(s({ endpoints: 0 })).tone).toBe("ok");
    expect(projectHealth(s({ sources: 0 })).tone).toBe("ok");
  });

  it("chưa có nguồn lẫn đích -> xám (không xanh), kể cả có sự kiện cũ", () => {
    expect(projectHealth(s({ sources: 0, endpoints: 0 }))).toEqual({ tone: "neutral", reasons: [] });
  });

  it("stats null/undefined (chưa có số liệu) -> xám, cờ noData; nhãn khác nhãn 'chưa có nguồn/đích'", () => {
    expect(projectHealth(null)).toEqual({ tone: "neutral", reasons: [], noData: true });
    expect(projectHealth(undefined).tone).toBe("neutral");
    expect(projectHealthLabel(projectHealth(null), vi)).toBe("Chưa có số liệu");
    expect(projectHealthLabel(projectHealth(s({ sources: 0, endpoints: 0 })), vi)).toBe("Chưa có nguồn hay đích nào");
  });

  it.each([
    ["circuit OPEN/HALF_OPEN", s({ circuitOpen: 2 }), [{ kind: "circuit", count: 2 }]],
    ["DLQ > 0", s({ dlq: 3 }), [{ kind: "dlq", count: 3 }]],
    ["LOCKED", s({ storageLevel: "LOCKED" }), [{ kind: "storage", count: 1 }]],
    ["HARD_LOCKED", s({ storageLevel: "HARD_LOCKED" }), [{ kind: "storage", count: 1 }]],
    ["cảnh báo critical", s({ openAlerts: { critical: 1, warning: 0, info: 0 } }), [{ kind: "alerts", count: 1 }]],
    ["cảnh báo warning", s({ openAlerts: { critical: 0, warning: 2, info: 0 } }), [{ kind: "alerts", count: 2 }]],
  ])("%s -> đỏ kèm lý do", (_name, stats, reasons) => {
    expect(projectHealth(stats)).toEqual({ tone: "danger", reasons });
  });

  it("không làm đỏ: cảnh báo info, nấc dung lượng cảnh báo (chưa khoá), lỗi gửi 24h đã retry", () => {
    expect(projectHealth(s({ openAlerts: { critical: 0, warning: 0, info: 4 } })).tone).toBe("ok");
    for (const level of ["WARN_70", "WARN_85", "CRITICAL_95"])
      expect(projectHealth(s({ storageLevel: level })).tone).toBe("ok");
    expect(projectHealth(s({ failedAttempts24h: 50 })).tone).toBe("ok");
  });

  it("đỏ thắng xám: dự án đã lưu trữ hết nguồn/đích nhưng DLQ còn tin -> đỏ", () => {
    expect(projectHealth(s({ sources: 0, endpoints: 0, dlq: 1 })).tone).toBe("danger");
  });

  it("nhiều sự cố -> đủ lý do theo thứ tự cố định (circuit, dlq, storage, alerts)", () => {
    const h = projectHealth(
      s({ dlq: 1, circuitOpen: 1, storageLevel: "LOCKED", openAlerts: { critical: 1, warning: 1, info: 0 } }),
    );
    expect(h.reasons.map((r) => r.kind)).toEqual(["circuit", "dlq", "storage", "alerts"]);
  });
});

describe("projectHealthLabel — nhãn nhỏ trên thẻ (vi/en)", () => {
  it("đỏ: nói lý do, vd '2 tin trong DLQ'", () => {
    expect(projectHealthLabel(projectHealth(s({ dlq: 2 })), vi)).toBe("2 tin trong DLQ");
    expect(projectHealthLabel(projectHealth(s({ dlq: 2 })), en)).toBe("2 messages in DLQ");
  });

  it("nhiều lý do -> nối bằng ' · '", () => {
    expect(projectHealthLabel(projectHealth(s({ dlq: 1, storageLevel: "LOCKED" })), vi)).toBe(
      "1 tin trong DLQ · Dung lượng bị khoá",
    );
  });

  it("xanh / xám có nhãn riêng, không rỗng", () => {
    for (const t of [vi, en]) {
      expect(projectHealthLabel(projectHealth(base), t)).not.toBe("");
      expect(projectHealthLabel(projectHealth(s({ sources: 0, endpoints: 0 })), t)).not.toBe("");
      expect(projectHealthLabel(projectHealth(null), t)).not.toBe("");
    }
  });

  it("mọi khoá lý do/nhãn có ở cả vi và en", () => {
    for (const locale of LOCALES)
      for (const key of HEALTH_REASON_KEYS)
        expect({ locale, key, has: key in DICTIONARIES[locale] }).toEqual({ locale, key, has: true });
  });
});
