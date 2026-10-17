import * as fs from "fs";
import * as path from "path";

/**
 * GridList.template là giá trị CSS `grid-template-columns` (đi vào `style`), KHÔNG phải class Tailwind: truyền
 * "grid-cols-[...]" thì khai báo bị trình duyệt bỏ và cả danh sách dồn một cột (lỗi đã gặp ở trang Sự kiện).
 */
const SRC = path.join(__dirname, "..", "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (p.endsWith(".tsx")) out.push(p);
  }
  return out;
}

describe("GridList template", () => {
  const files = walk(SRC).filter((f) => /<GridList\b/.test(fs.readFileSync(f, "utf8")) && !f.endsWith("grid-list.tsx"));

  it("có nơi dùng GridList để kiểm", () => {
    expect(files.length).toBeGreaterThanOrEqual(2);
  });

  it("template truyền vào không phải class Tailwind (không bắt đầu bằng grid-cols-)", () => {
    for (const f of files) {
      const src = fs.readFileSync(f, "utf8");
      // template="literal" hoặc template={IDENT} -> lấy giá trị hằng cùng file khi là IDENT.
      for (const m of src.matchAll(/template=(?:"([^"]*)"|\{([A-Za-z_][\w]*)\})/g)) {
        let value = m[1];
        if (value === undefined) {
          const decl = new RegExp(`const ${m[2]}\\s*=\\s*"([^"]*)"`).exec(src);
          if (!decl) continue; // hằng tính bằng hàm (vd logGridTemplate()) — kiểm ở test dưới
          value = decl[1];
        }
        expect({ file: path.basename(f), value }).not.toEqual({ file: path.basename(f), value: expect.stringMatching(/grid-cols-|\[|\]/) });
      }
    }
  });

  it("template của ngăn Nhật ký (logGridTemplate) là danh sách track CSS", async () => {
    const { logGridTemplate } = await import("../flow/log-layout");
    expect(logGridTemplate()).not.toMatch(/grid-cols-/);
  });
});
