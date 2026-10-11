import { buildSettingsBody, currentHint, emptyForm, parseKeyList, suggestSourceKeys } from "./settings-logic";

/** SK3 (SPEC-shop-ket-noi-project §4.4): trang Cài đặt kết nối của Shop. */
describe("Shop › Cài đặt kết nối (SK3)", () => {
  it("PUT chỉ gửi ô có chữ — ô trống giữ nguyên giá trị đã lưu", () => {
    const f = {
      ...emptyForm(),
      hubConnectionUrl: " hubs://hk_test_x@h/p ",
      payosApiKey: "   ",
      paymentSourceKeys: ["src_a"],
    };
    expect(buildSettingsBody(f)).toEqual({ hubConnectionUrl: "hubs://hk_test_x@h/p", paymentSourceKeys: ["src_a"] });
    expect(buildSettingsBody(emptyForm())).toEqual({});
  });

  it("gợi ý tick sẵn source payos/sepay đang bật; đã lưu nguồn thì giữ lựa chọn cũ", () => {
    const sources = [
      { sourceKey: "src_payos_b", provider: "payos", isActive: true },
      { sourceKey: "src_gh", provider: "github", isActive: true },
      { sourceKey: "src_sepay_off", provider: "sepay", isActive: false },
    ];
    expect(suggestSourceKeys(sources, ["src_payos_main"])).toEqual(["src_payos_b"]);
    expect(suggestSourceKeys(sources, ["src_gh"])).toEqual(["src_gh"]);
    expect(parseKeyList("src_a, src_b  src_c,")).toEqual(["src_a", "src_b", "src_c"]);
  });

  it("dòng 'hiện có' của ô bí mật chỉ có 4 ký tự cuối + nguồn, không bao giờ giá trị", () => {
    expect(currentHint({ source: "db", configured: true, last4: "ab12" })).toBe(
      "Đang dùng …ab12 (đã lưu ở trang này). Để trống = giữ nguyên.",
    );
    expect(currentHint({ source: "none", configured: false })).toBe("Chưa có");
  });
});
