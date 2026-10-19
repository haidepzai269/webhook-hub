import {
  ACCOUNT_ROUTES,
  accountMenuItems,
  accountNavEntries,
  backToProjectLink,
  brandHref,
  legacyAccountRedirect,
} from "./account-routes";

/** ADR-237: Cảnh báo + Cài đặt ở tầng TÀI KHOẢN (menu tài khoản), không trong sidebar dự án. */
describe("account-routes", () => {
  const me = (isOperator: boolean, roles: string[] = []) => ({
    user: { isOperator },
    memberships: roles.map((role) => ({ role })),
  });
  const ids = (m: Parameters<typeof accountMenuItems>[0]) => accountMenuItems(m).map((i) => i.id);

  it("đường tầng tài khoản không nằm dưới /dashboard (không sidebar dự án)", () => {
    expect(ACCOUNT_ROUTES).toEqual({ projects: "/projects", alerts: "/alerts", settings: "/settings" });
  });

  it("operator: Cảnh báo + Cài đặt", () => {
    expect(ids(me(true))).toEqual(["alerts", "settings"]);
    expect(ids(me(true, ["developer"]))).toEqual(["alerts", "settings"]);
  });

  it("owner của ít nhất một dự án (không operator): chỉ Cảnh báo (ADR-190 — cảnh báo dung lượng dự án mình)", () => {
    expect(ids(me(false, ["developer", "owner"]))).toEqual(["alerts"]);
  });

  it("developer/viewer hoặc chưa nạp /auth/me: không mục nào", () => {
    expect(ids(me(false, ["developer", "viewer"]))).toEqual([]);
    expect(ids(me(false))).toEqual([]);
    expect(ids(null)).toEqual([]);
  });

  it("mỗi mục có khoá dịch nav.item.<id> và url tầng tài khoản", () => {
    for (const i of accountMenuItems(me(true))) {
      expect(i.titleKey).toBe(`nav.item.${i.id}`);
      expect(i.url).toBe(ACCOUNT_ROUTES[i.id]);
    }
  });

  it("đường cũ /dashboard/alerts|settings chuyển sang đường mới, GIỮ query (link email/chuông cũ)", () => {
    expect(legacyAccountRedirect("alerts", {})).toBe("/alerts");
    expect(legacyAccountRedirect("settings", {})).toBe("/settings");
    expect(legacyAccountRedirect("alerts", { project: "p1", rule: "destination.auth_rejected", x: undefined })).toBe(
      "/alerts?project=p1&rule=destination.auth_rejected",
    );
    expect(legacyAccountRedirect("alerts", { severity: ["critical", "warning"] })).toBe(
      "/alerts?severity=critical&severity=warning",
    );
    // giá trị lạ được mã hoá, không ghép thô vào URL
    expect(legacyAccountRedirect("alerts", { q: "a&b=c" })).toBe("/alerts?q=a%26b%3Dc");
  });
});

/** ADR-268: đường quay về + điều hướng gọn của tầng tài khoản (bổ sung ADR-237, vẫn không sidebar dự án). */
describe("account-routes: đường quay về & điều hướng tầng tài khoản", () => {
  const me = {
    user: { isOperator: true },
    memberships: [{ projectId: "p1", name: "Cafe", role: "owner" }],
  };

  it("có dự án đang chọn (là thành viên): về /dashboard kèm tên dự án", () => {
    expect(backToProjectLink("p1", me)).toEqual({ href: "/dashboard", projectName: "Cafe" });
  });

  it("dự án đang chọn không nằm trong memberships (operator): vẫn về /dashboard, không tên", () => {
    expect(backToProjectLink("px", me)).toEqual({ href: "/dashboard", projectName: null });
  });

  it("chưa chọn dự án: về /projects", () => {
    expect(backToProjectLink(null, me)).toEqual({ href: "/projects", projectName: null });
  });

  it("logo: /dashboard khi có dự án, /projects khi chưa", () => {
    expect(brandHref("p1")).toBe("/dashboard");
    expect(brandHref(null)).toBe("/projects");
  });

  it("điều hướng tầng tài khoản: Tất cả dự án luôn có; Cảnh báo/Cài đặt theo vai trò; đánh dấu active", () => {
    const nav = accountNavEntries(me, "/alerts");
    expect(nav.map((i) => [i.id, i.active])).toEqual([
      ["projects", false],
      ["alerts", true],
      ["settings", false],
    ]);
    expect(
      accountNavEntries({ user: { isOperator: false }, memberships: [{ role: "developer" }] }, "/projects").map(
        (i) => i.id,
      ),
    ).toEqual(["projects"]);
    expect(accountNavEntries(null, "/projects").map((i) => i.id)).toEqual(["projects"]);
  });
});
