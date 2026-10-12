import { createT, LOCALES } from "../../lib/i18n/dictionary";
import { projectItemTitle, projectPickerView, roleLabel } from "./project-picker-logic";

const vi = createT("vi");
const en = createT("en");

const p = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id,
  slug: `slug-${id}`,
  name,
  environment: "test",
  ...extra,
});

describe("projectPickerView — nhãn/tooltip của bộ chọn project ở sidebar", () => {
  it("chọn đúng project theo id; tooltip = tên đầy đủ (tên dài bị CSS cắt)", () => {
    const long = "Hải Nguyễn Hoàng's project";
    const v = projectPickerView([p("a", "A"), p("b", long)], "b", vi);
    expect(v.current?.id).toBe("b");
    expect(v.label).toBe(long);
    expect(v.tooltip).toBe(long);
    expect(v.operator).toBe(false);
  });

  it("id không khớp -> project đầu", () => {
    expect(projectPickerView([p("a", "A"), p("b", "B")], "zzz", vi).current?.id).toBe("a");
    expect(projectPickerView([p("a", "A")], null, vi).current?.id).toBe("a");
  });

  it("operator không là thành viên -> cờ operator + tooltip kèm ghi chú (theo ngôn ngữ)", () => {
    const v = projectPickerView([p("a", "Shop", { member: false })], "a", vi);
    expect(v.operator).toBe(true);
    expect(v.tooltip).toBe("Shop — đang xem với quyền vận hành");
    expect(projectPickerView([p("a", "Shop", { member: false })], "a", en).tooltip).toBe(
      "Shop — viewing with operator access",
    );
  });

  it("danh sách rỗng / tên trống -> nhãn mặc định", () => {
    expect(projectPickerView([], "a", vi).label).toBe("Chọn dự án");
    expect(projectPickerView([p("a", "  ")], "a", vi).label).toBe("Chọn dự án");
    expect(projectPickerView([], "a", en).label).toBe("Select project");
  });
});

describe("projectItemTitle — tooltip từng dòng trong danh sách", () => {
  it("tên · vai trò · slug; operator thay vai trò", () => {
    expect(projectItemTitle(p("a", "Cafe", { role: "owner" }), vi)).toBe("Cafe · Chủ sở hữu · slug-a");
    expect(projectItemTitle(p("a", "Cafe", { role: "owner" }), en)).toBe("Cafe · Owner · slug-a");
    expect(projectItemTitle(p("b", "Shop", { member: false, role: "owner" }), vi)).toBe("Shop · vận hành · slug-b");
    expect(projectItemTitle(p("c", "Lẻ"), vi)).toBe("Lẻ · slug-c");
  });

  it("vai trò lạ giữ nguyên mã; vai trò biết trước có nhãn ở mọi ngôn ngữ", () => {
    expect(roleLabel("auditor", vi)).toBe("auditor");
    for (const l of LOCALES) for (const r of ["owner", "developer", "viewer"]) expect(roleLabel(r, createT(l))).not.toBe(r);
  });
});
