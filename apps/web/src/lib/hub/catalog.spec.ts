import { CATALOG } from "@hub/providers/catalog/catalog";
import { identifyLocally } from "./catalog";

/** PK9 (E28): console nhận diện bằng alias `@hub/providers/catalog`, trên dữ liệu `GET /api/v1/catalog`. */
describe("PK9: identifyLocally (web)", () => {
  it("chưa tải danh mục -> null; có danh mục -> cùng kết quả identify", () => {
    expect(identifyLocally({ name: "shopify" }, undefined)).toBeNull();
    expect(identifyLocally({ name: "shopify" }, { entries: [...CATALOG] })?.matches[0]?.id).toBe("shopify");
  });
});
