import { clearProjectSelection, currentProjectId, ensureProject, useProjectStore } from "./project-store";

/**
 * Lỗi production "stale project" (2026-10-12): user A chọn project P, đăng xuất; operator đăng nhập trên cùng trình duyệt
 * thì rơi vào P (operator thấy mọi project) và thấy trang Nguồn rỗng thay vì `default`.
 */
class MemStorage {
  m = new Map<string, string>();
  getItem = (k: string) => this.m.get(k) ?? null;
  setItem = (k: string, v: string) => void this.m.set(k, v);
  removeItem = (k: string) => void this.m.delete(k);
}

describe("project đang chọn — theo user, xoá khi đăng xuất", () => {
  let ls: MemStorage;
  beforeEach(() => {
    ls = new MemStorage();
    (globalThis as { localStorage?: unknown }).localStorage = ls;
    useProjectStore.setState({ userId: null, projectId: null });
  });
  afterAll(() => delete (globalThis as { localStorage?: unknown }).localStorage);

  // Operator thấy MỌI project (member=false ở project người khác); default là project operator là thành viên.
  const opList = [
    { id: "DEFAULT", member: true },
    { id: "P", member: false },
  ];

  it("A chọn P -> đăng xuất -> operator đăng nhập: scope ≠ P, là default", () => {
    expect(ensureProject([{ id: "P", member: true }], "user-a")).toBe("P");
    clearProjectSelection(); // logout()
    expect(currentProjectId()).toBeNull();
    expect(ensureProject(opList, "operator")).toBe("DEFAULT");
  });

  it("kể cả khi KHÔNG đăng xuất đúng cách (tab đóng) — lựa chọn của A không sang operator; khoá chung cũ bị bỏ", () => {
    ls.setItem("hub:projectId", "P"); // bản cũ: một khoá cho mọi user
    ensureProject([{ id: "P", member: true }], "user-a");
    expect(ensureProject(opList, "operator")).toBe("DEFAULT");
    expect(ls.getItem("hub:projectId")).toBeNull();
  });

  it("operator chủ động chọn P thì được nhớ cho CHÍNH operator; A quay lại vẫn thấy P của mình", () => {
    ensureProject(opList, "operator");
    useProjectStore.getState().setProjectId("P");
    useProjectStore.setState({ userId: null, projectId: null }); // tải lại trang
    expect(ensureProject(opList, "operator")).toBe("P");
    expect(
      ensureProject(
        [
          { id: "P", member: true },
          { id: "Q", member: true },
        ],
        "user-a",
      ),
    ).toBe("P");
  });

  it("operator không là thành viên project nào -> cái đầu danh sách (default tạo sớm nhất)", () => {
    expect(
      ensureProject(
        [
          { id: "DEFAULT", member: false },
          { id: "P", member: false },
        ],
        "op2",
      ),
    ).toBe("DEFAULT");
  });
});
