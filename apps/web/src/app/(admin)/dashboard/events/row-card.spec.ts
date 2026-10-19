import * as fs from "fs";
import * as path from "path";

/**
 * ROW_CARD (page.tsx) xếp ô thẻ mobile bằng nth-child(1..7) — khoá số ô + thứ tự để ai đổi cột GridList phải sửa cả hai (ADR-261).
 * Thứ tự con: 1 thời gian, 2 nhà cung cấp, 3 kiểu·đối tượng, 4 pipeline, 5 trạng thái, 6 hỏng ở, 7 xem nhanh.
 */
const src = fs.readFileSync(path.join(__dirname, "page.tsx"), "utf8");

describe("events page ROW_CARD", () => {
  it("lưới 7 cột, tiêu đề 7 mục, ROW_CARD nhắc đúng nth-child 1..7", () => {
    const cols = /const GRID_COLS = "([^"]+)"/.exec(src)?.[1] ?? "";
    expect(cols.split(/\s+(?![^(]*\))/)).toHaveLength(7);
    const headers = src.slice(src.indexOf("headers={["), src.indexOf("]}", src.indexOf("headers={[")));
    expect(headers.split("\n").filter((l) => /^\s+(t\(|null)/.test(l))).toHaveLength(7);
    const card = /const ROW_CARD =\s*"([^"]+)"/.exec(src)?.[1] ?? "";
    const idx = [...new Set([...card.matchAll(/nth-child\((\d)\)/g)].map((m) => Number(m[1])))].sort();
    expect(idx).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("thứ tự ô trong GridListRow khớp chú thích", () => {
    const order = [...src.matchAll(/\{\/\* (Thời gian|Nhà cung cấp|Kiểu · đối tượng|Đường ống|Trạng thái|Hỏng ở|Xem nhanh) \*\/\}/g)].map((m) => m[1]);
    expect(order).toEqual(["Thời gian", "Nhà cung cấp", "Kiểu · đối tượng", "Đường ống", "Trạng thái", "Hỏng ở", "Xem nhanh"]);
  });
});
