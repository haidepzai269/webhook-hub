import { avatarBackground, hueOf, initials, planProviderIcon } from "./brand-fallback";
import { BRAND_LOGOS, brandLogo, contrast, monoFill } from "./brand-logos";

/** Logo thương hiệu (ADR-236): dữ liệu đã làm sạch + quyết định icon của nguồn. */
describe("brand-logos — dữ liệu SVG đã làm sạch", () => {
  const PATH_D = /^[MmLlHhVvCcSsQqTtAaZz0-9eE.,\s+-]+$/;
  const NUM = String.raw`-?[0-9.]+(?:e-?\d+)?`;
  const MATRIX = new RegExp(`^matrix\\(${NUM}( ${NUM}){5}\\)$`);

  it.each(Object.entries(BRAND_LOGOS))("%s chỉ chứa d/fill/fillRule/transform hợp lệ", (_id, logo) => {
    expect(logo.viewBox).toMatch(/^-?[0-9.]+ -?[0-9.]+ [0-9.]+ [0-9.]+$/);
    expect(logo.paths.length).toBeGreaterThan(0);
    if (logo.hex) expect(logo.hex).toMatch(/^#[0-9A-F]{6}$/);
    expect(logo.source).not.toMatch(/^javascript:/i);
    for (const p of logo.paths) {
      expect(Object.keys(p).every((k) => ["d", "fill", "fillRule", "transform"].includes(k))).toBe(true);
      expect(p.d).toMatch(PATH_D);
      if (p.fill !== undefined) expect(p.fill).toMatch(/^#[0-9A-F]{6}$/);
      if (p.fillRule !== undefined) expect(p.fillRule).toBe("evenodd");
      if (p.transform !== undefined) expect(p.transform).toMatch(MATRIX);
      // Logo đơn sắc tô theo theme — path không được mang fill riêng.
      if (logo.hex) expect(p.fill).toBeUndefined();
    }
  });

  it("có logo cho mọi nguồn có adapter + đích có thương hiệu", () => {
    for (const id of ["payos", "sepay", "github", "stripe", "discord", "telegram"])
      expect(brandLogo(id)).not.toBeNull();
  });

  it("tra không phân biệt hoa thường; lạ/rỗng -> null", () => {
    expect(brandLogo("GitHub")?.title).toBe("GitHub");
    expect(brandLogo("acme-pay")).toBeNull();
    expect(brandLogo("")).toBeNull();
    expect(brandLogo(undefined)).toBeNull();
    expect(brandLogo("generic")).toBeNull();
    expect(brandLogo("api")).toBeNull();
  });

  it("logo đơn sắc tối (GitHub) -> màu chữ ở dark, giữ màu thương hiệu ở light; logo sáng (Paddle) ngược lại", () => {
    expect(monoFill("#181717")).toEqual({ light: "#181717", dark: "var(--foreground)" });
    expect(monoFill("#FDDD35")).toEqual({ light: "var(--foreground)", dark: "#FDDD35" });
    expect(monoFill("#5865F2").light).toBe("#5865F2");
    // Ngưỡng 2:1: Telegram/GitLab giữ màu thương hiệu ở nền sáng.
    expect(monoFill("#26A5E4").light).toBe("#26A5E4");
    expect(monoFill("#FC6D26").light).toBe("#FC6D26");
    expect(contrast("#FFFFFF", "#000000")).toBeCloseTo(21, 0);
  });
});

describe("planProviderIcon — fallback khi không có logo", () => {
  it("provider có logo -> logo (bỏ qua name)", () => {
    const plan = planProviderIcon("stripe", "Cửa hàng A");
    expect(plan.kind).toBe("logo");
  });

  it("provider lạ + name -> chữ tắt đúng, màu ổn định theo name", () => {
    const a = planProviderIcon("generic", "Cafe Order");
    const b = planProviderIcon("acme", "Cafe Order");
    expect(a).toMatchObject({ kind: "initials", text: "CO", name: "Cafe Order" });
    expect(b.kind === "initials" && a.kind === "initials" && b.background === a.background).toBe(true);
    expect(planProviderIcon("api", "bookstore")).toMatchObject({ kind: "initials", text: "BO" });
    expect(planProviderIcon("api", "  ")).toEqual({ kind: "generic" });
    // Tên khác -> (thường) màu khác; cùng tên luôn cùng màu.
    expect(hueOf("cafe")).toBe(hueOf("cafe"));
    expect(hueOf("cafe")).not.toBe(hueOf("bookstore"));
    expect(avatarBackground("cafe")).toBe(avatarBackground("cafe"));
  });

  it("provider lạ không name -> icon chung", () => {
    expect(planProviderIcon("acme")).toEqual({ kind: "generic" });
    expect(planProviderIcon("generic", undefined)).toEqual({ kind: "generic" });
    expect(planProviderIcon("", null)).toEqual({ kind: "generic" });
  });

  it("initials: hai từ -> chữ đầu mỗi từ; ký tự đặc biệt bị bỏ; tiếng Việt giữ dấu", () => {
    expect(initials("shop-đơn hàng")).toBe("SĐ");
    expect(initials("x")).toBe("X");
    expect(initials("!!!")).toBe("?");
  });
});
