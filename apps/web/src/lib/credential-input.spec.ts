import { credentialError, credentialInputAttrs } from "./credential-input";

/** Lỗi production: trình duyệt tự điền đăng nhập operator vào form credential của provider. */
describe("ô credential — chống trình duyệt tự điền đăng nhập", () => {
  it("ô bí mật dùng new-password + tên riêng, không bao giờ username/email/password", () => {
    const a = credentialInputAttrs("payos", "apiKey", true);
    expect(a).toMatchObject({
      type: "password",
      autoComplete: "new-password",
      name: "payos-api-key",
      id: "payos-api-key",
    });
    const b = credentialInputAttrs("payos", "clientId", false);
    expect(b).toMatchObject({ type: "text", autoComplete: "off", name: "payos-client-id" });
    for (const x of [a, b]) expect(["username", "email", "password"]).not.toContain(x.name);
  });

  it("giá trị có '@' bị từ chối kèm câu tiếng Việt; UUID/hex thì qua", () => {
    expect(credentialError("Client ID", "admin@shop.vn")).toBe("Đây có vẻ là email, không phải Client ID");
    expect(credentialError("Client ID", "3f2b6c1e-8a4d-4f1b-9a7e-2c5d8e9f0a1b")).toBeNull();
    expect(credentialError("Api Key", "a1b2c3d4e5f6")).toBeNull();
  });
});
