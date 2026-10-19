import {
  bucketLabelFor,
  eventsHref,
  floorBucket,
  formatSelection,
  moveIndex,
  overlayIndexes,
  parseSelection,
  selectionFromLabels,
} from "./chart-selection";

// Bucket server (giờ VN): 7d = 17:00Z hôm trước; 24h = chẵn giờ.
const D = (n: number) => `2026-10-${String(n).padStart(2, "0")}T17:00:00.000Z`; // 00:00 VN ngày n+1
const H = (h: number) => `2026-10-15T${String(h).padStart(2, "0")}:00:00.000Z`;

describe("chart-selection", () => {
  it("floorBucket 7d cắt ở 00:00 GMT+7 (17:00Z), kể cả sát mép", () => {
    expect(new Date(floorBucket(Date.parse("2026-10-15T16:59:59.999Z"), "7d")).toISOString()).toBe("2026-10-14T17:00:00.000Z");
    expect(new Date(floorBucket(Date.parse("2026-10-15T17:00:00.000Z"), "7d")).toISOString()).toBe("2026-10-15T17:00:00.000Z");
  });

  it("bấm = trọn bucket: 24h là 1 giờ, 7d là 1 ngày VN", () => {
    expect(selectionFromLabels(H(3), H(3), "24h")).toEqual({ from: "2026-10-15T03:00:00.000Z", to: "2026-10-15T03:59:59.999Z" });
    expect(selectionFromLabels(D(13), D(13), "7d")).toEqual({ from: "2026-10-13T17:00:00.000Z", to: "2026-10-14T16:59:59.999Z" });
  });

  it("kéo ngược được chuẩn hoá, kéo xuôi cho cùng kết quả", () => {
    const fwd = selectionFromLabels(D(13), D(15), "7d");
    expect(selectionFromLabels(D(15), D(13), "7d")).toEqual(fwd);
    expect(fwd).toEqual({ from: "2026-10-13T17:00:00.000Z", to: "2026-10-16T16:59:59.999Z" });
  });

  it("nhãn lệch phút vẫn snap về mép bucket; nhãn rác -> null", () => {
    expect(selectionFromLabels("2026-10-15T03:25:00Z", "2026-10-15T03:40:00Z", "24h")?.from).toBe("2026-10-15T03:00:00.000Z");
    expect(selectionFromLabels("x", H(1), "24h")).toBeNull();
  });

  it("parseSelection yêu cầu đủ hai đầu và from <= to", () => {
    expect(parseSelection(undefined, "2026-10-15T00:00:00Z")).toBeNull();
    expect(parseSelection("2026-10-16T00:00:00Z", "2026-10-15T00:00:00Z")).toBeNull();
    expect(parseSelection("2026-10-15T00:00:00Z", "2026-10-16T00:00:00Z")).toEqual({
      from: "2026-10-15T00:00:00Z",
      to: "2026-10-16T00:00:00Z",
    });
  });

  it("overlayIndexes kẹp vào trục, ngoài trục -> null", () => {
    const axis = [D(10), D(11), D(12), D(13), D(14)];
    expect(overlayIndexes(axis, selectionFromLabels(D(11), D(12), "7d"))).toEqual({ i1: 1, i2: 2 });
    expect(overlayIndexes(axis, { from: "2026-10-01T00:00:00Z", to: "2026-10-11T17:00:00.000Z" })).toEqual({ i1: 0, i2: 1 });
    expect(overlayIndexes(axis, { from: "2026-10-12T00:00:00Z", to: "2026-10-30T00:00:00Z" })).toEqual({ i1: 2, i2: 4 });
    expect(overlayIndexes(axis, { from: "2026-09-01T00:00:00Z", to: "2026-09-02T00:00:00Z" })).toBeNull();
    expect(overlayIndexes(axis, { from: "2026-11-01T00:00:00Z", to: "2026-11-02T00:00:00Z" })).toBeNull();
    expect(overlayIndexes([], { from: "2026-10-01T00:00:00Z", to: "2026-10-02T00:00:00Z" })).toBeNull();
    expect(overlayIndexes(axis, null)).toBeNull();
  });

  it("bucketLabelFor tìm bucket chứa mốc (mép ngày VN)", () => {
    const axis = [D(13), D(14)];
    expect(bucketLabelFor(axis, "2026-10-14T16:59:59Z", "7d")).toBe(D(13));
    expect(bucketLabelFor(axis, "2026-10-14T17:00:00Z", "7d")).toBe(D(14));
    expect(bucketLabelFor(axis, "2026-10-01T00:00:00Z", "7d")).toBeNull();
  });

  it("moveIndex kẹp biên, bắt đầu từ bucket cuối", () => {
    expect(moveIndex(null, -1, 24)).toBe(22);
    expect(moveIndex(0, -1, 24)).toBe(0);
    expect(moveIndex(23, 1, 24)).toBe(23);
  });

  it("nhãn hiển thị theo GMT+7 và link sang trang Sự kiện", () => {
    const s = selectionFromLabels(D(13), D(15), "7d");
    if (!s) throw new Error("null");
    expect(formatSelection(s)).toBe("14-10 00:00 → 16-10 23:59");
    expect(eventsHref(s)).toBe(`/dashboard/events?from=${encodeURIComponent(s.from)}&to=${encodeURIComponent(s.to)}`);
  });
});
