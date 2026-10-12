import { OPERATOR_NOTE, projectItemTitle, projectPickerView } from "./project-picker-logic";

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
    const v = projectPickerView([p("a", "A"), p("b", long)], "b");
    expect(v.current?.id).toBe("b");
    expect(v.label).toBe(long);
    expect(v.tooltip).toBe(long);
    expect(v.operator).toBe(false);
  });

  it("id không khớp -> project đầu", () => {
    expect(projectPickerView([p("a", "A"), p("b", "B")], "zzz").current?.id).toBe("a");
    expect(projectPickerView([p("a", "A")], null).current?.id).toBe("a");
  });

  it("operator không là thành viên -> cờ operator + tooltip kèm ghi chú", () => {
    const v = projectPickerView([p("a", "Shop", { member: false })], "a");
    expect(v.operator).toBe(true);
    expect(v.tooltip).toBe(`Shop — ${OPERATOR_NOTE}`);
  });

  it("danh sách rỗng / tên trống -> nhãn mặc định", () => {
    expect(projectPickerView([], "a").label).toBe("Chọn project");
    expect(projectPickerView([p("a", "  ")], "a").label).toBe("Chọn project");
  });
});

describe("projectItemTitle — tooltip từng dòng trong danh sách", () => {
  it("tên · role · slug; operator thay role", () => {
    expect(projectItemTitle(p("a", "Cafe", { role: "owner" }))).toBe("Cafe · owner · slug-a");
    expect(projectItemTitle(p("b", "Shop", { member: false, role: "owner" }))).toBe("Shop · operator · slug-b");
    expect(projectItemTitle(p("c", "Lẻ"))).toBe("Lẻ · slug-c");
  });
});
