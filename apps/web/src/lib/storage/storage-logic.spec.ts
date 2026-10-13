import {
  barPct,
  canReadStorage,
  cleanBodyFor,
  confirmKeys,
  formatBytes,
  levelTone,
  parseAge,
  parseQuotaInput,
  sourceCountVars,
  storageBannerFor,
  suggestionActions,
} from "./storage-logic";

/** QT7 (SPEC-han-muc-dung-luong §3, §5.1, §9 + E1/E5): logic thuần của trang Dung lượng + banner theo nấc. */
describe("QT7 trang Dung lượng — logic thuần", () => {
  it("[QT:T30] (phần g) banner theo nấc: 70/85 vàng ẩn được (85 có toast), 95 đỏ không tắt, LOCKED/HARD_LOCKED 2 nút; cờ khoá tắt -> câu nói thật; không bao giờ có 'Nâng cấp'", () => {
    expect(storageBannerFor("OK", true)).toBeNull();
    expect(storageBannerFor("WARN_70", true)).toMatchObject({ tone: "warning", dismissible: true, toastOnOpen: false, actions: ["open"] });
    expect(storageBannerFor("WARN_85", true)).toMatchObject({ tone: "warning", dismissible: true, toastOnOpen: true });
    expect(storageBannerFor("CRITICAL_95", true)).toMatchObject({ tone: "danger", dismissible: false, actions: ["clean"] });
    expect(storageBannerFor("LOCKED", true)).toMatchObject({ messageKey: "page.storage.banner.locked", dismissible: false, actions: ["clean", "contact"] });
    expect(storageBannerFor("HARD_LOCKED", true)?.messageKey).toBe("page.storage.banner.hard-locked");
    expect(storageBannerFor("LOCKED", false)?.messageKey).toBe("page.storage.banner.lock-off");
    expect(storageBannerFor("HARD_LOCKED", false)?.messageKey).toBe("page.storage.banner.lock-off");
    for (const l of ["WARN_70", "WARN_85", "CRITICAL_95", "LOCKED", "HARD_LOCKED"] as const) {
      expect(JSON.stringify(storageBannerFor(l, true))).not.toMatch(/upgrade|nang-cap/i);
    }
  });

  it("hộp xác nhận nói đánh đổi: Dọn giữ chống trùng, Xoá hẳn mất chống trùng, mức Cao có câu riêng; Rác chỉ có Xoá hẳn", () => {
    expect(confirmKeys("trim", ["low"]).bodyKeys).toEqual(["page.storage.confirm.trim"]);
    expect(confirmKeys("delete", ["low", "high"]).bodyKeys).toEqual(["page.storage.confirm.delete", "page.storage.confirm.high"]);
    expect(suggestionActions({ importance: ["junk"] })).toEqual(["delete"]);
    expect(suggestionActions({ importance: ["low"] })).toEqual(["trim", "delete"]);
    expect(cleanBodyFor({ importance: ["high"], olderThan: "5d", sourceId: "s-1" }, "trim")).toEqual({
      action: "trim",
      importance: ["high"],
      olderThan: "5d",
      sourceId: "s-1",
      confirmHigh: true,
    });
    expect(cleanBodyFor({ importance: ["low"], olderThan: "3d", sourceId: null }, "delete")).toEqual({ action: "delete", importance: ["low"], olderThan: "3d" });
  });

  it("định dạng + ô ghi đè hạn mức + N/20 nguồn", () => {
    expect(formatBytes(512 * 1024)).toBe("512 KB");
    expect(formatBytes(52 * 1048576)).toBe("52.0 MB");
    expect(levelTone("OK")).toBe("ok");
    expect(levelTone("WARN_85")).toBe("warning");
    expect(levelTone("HARD_LOCKED")).toBe("danger");
    expect(barPct(112)).toBe(100);
    expect(parseAge("3d")).toEqual({ n: 3, unit: "d" });
    expect(parseAge("x")).toBeNull();
    expect(parseQuotaInput("")).toBeNull();
    expect(parseQuotaInput(" 200 ")).toBe(200);
    expect(parseQuotaInput("0")).toBeUndefined();
    expect(parseQuotaInput("1.5")).toBeUndefined();
    expect(parseQuotaInput("102401")).toBeUndefined();
    expect(sourceCountVars({ sources: { count: 3, limit: 20 } })).toEqual({ count: 3, limit: 20 });
    expect(sourceCountVars(undefined)).toBeNull();
  });

  it("review QT-S3 L9: banner chỉ gọi GET storage khi có storage:read — owner/developer/operator; viewer / không thành viên thì không", () => {
    expect(canReadStorage("owner", false)).toBe(true);
    expect(canReadStorage("developer", false)).toBe(true);
    expect(canReadStorage(undefined, true)).toBe(true);
    expect(canReadStorage("viewer", true)).toBe(true);
    expect(canReadStorage("viewer", false)).toBe(false);
    expect(canReadStorage(undefined, false)).toBe(false);
  });
});
