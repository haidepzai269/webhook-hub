import { createT } from "../i18n/dictionary";
import {
  envLine,
  KEY_SCOPES,
  keyStatus,
  prefixTail,
  projectCreateError,
  SHOP_DEFAULT_SCOPES,
  slugFromName,
  toSummary,
} from "./keys-logic";
import { currentProjectId, ensureProject } from "./project-store";

/** SK1 (SPEC-shop-ket-noi-project §3): trang Project + API key của console. */
describe("console Project + API key (SK1)", () => {
  const created = {
    id: "k1",
    serviceName: "shop",
    keyPrefix: "hk_test_ab12",
    scopes: SHOP_DEFAULT_SCOPES,
    lastUsedAt: null,
    revokedAt: null,
    createdAt: "2026-10-12T00:00:00Z",
    key: "hk_test_ab12SECRETSECRETSECRETSECRETSECRETSECRET1",
    connectionString: "hubs://hk_test_ab12SECRETSECRETSECRETSECRETSECRETSECRET1@hub.example/cafe",
  };

  it("[SK:U6] (phần a) connection string chỉ có ở response tạo key: dòng HUB_URL= dựng từ nó; bản giữ trong danh sách KHÔNG còn key", () => {
    expect(envLine(created.connectionString)).toBe(`HUB_URL=${created.connectionString}`);
    const s = toSummary(created);
    expect(JSON.stringify(s)).not.toContain("SECRET");
    expect(s).not.toHaveProperty("key");
    expect(s).not.toHaveProperty("connectionString");
    expect(prefixTail(s.keyPrefix)).toBe("ab12");
  });

  it("scope mặc định cho Shop = manage:endpoints + read:events; không scope của người", () => {
    expect(SHOP_DEFAULT_SCOPES).toEqual(["manage:endpoints", "read:events"]);
    expect(KEY_SCOPES.map((s) => s.scope)).not.toContain("manage:keys");
  });

  it("slug gợi ý bỏ dấu tiếng Việt; 409 slug trùng -> câu tiếng Việt", () => {
    expect(slugFromName("Cửa hàng Đồ ăn của tôi!")).toBe("cua-hang-do-an-cua-toi");
    const vi = createT("vi");
    const en = createT("en");
    expect(projectCreateError(409, { error: "slug_taken" }, "x", vi)).toMatch(/đã có dự án khác/);
    expect(projectCreateError(422, {}, "x", vi)).toMatch(/Mã định danh chỉ gồm/);
    expect(projectCreateError(409, { error: "slug_taken" }, "x", en)).toMatch(/already used/);
    expect(projectCreateError(500, {}, "", en)).toBe("Error 500");
    expect(projectCreateError(403, { error: "project_limit" }, "server says", vi)).toBe("server says");
    expect(vi(keyStatus({ revokedAt: "2026-01-01" }))).toBe("Đã thu hồi");
    expect(en(keyStatus({ revokedAt: null }))).toBe("Active");
  });

  it("người mới: project tự tạo lúc đăng ký được chọn sẵn -> trang API key dùng ngay, không cần bước tạo project", () => {
    expect(ensureProject([{ id: "auto-project-id", member: true }], "u1")).toBe("auto-project-id");
    expect(currentProjectId()).toBe("auto-project-id");
    expect(ensureProject([{ id: "other" }, { id: "auto-project-id" }], "u1")).toBe("auto-project-id"); // giữ lựa chọn còn hợp lệ
  });
});
