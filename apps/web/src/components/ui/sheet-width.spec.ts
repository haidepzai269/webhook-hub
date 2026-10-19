import * as fs from "fs";
import * as path from "path";

import { cn } from "cn";

/**
 * Review UI-MS N1 — chặn hồi quy: sidebar admin trên mobile (Sheet trái) phủ kín màn và không đóng được vì bề rộng mặc
 * định của SheetContent viết dưới variant `data-[side=*]:w-*` (độ ưu tiên 0,2,0) thắng `w-(--sidebar-width)` của nơi
 * dùng, và cn/tailwind-merge không gộp được hai class khác variant.
 */
const read = (f: string) => fs.readFileSync(path.join(__dirname, f), "utf8");

describe("SheetContent — bề rộng ghi đè được từ nơi dùng", () => {
  it("sheet.tsx không đặt bề rộng dưới variant data-[side=left|right] (nơi dùng không đè được)", () => {
    expect(read("sheet.tsx")).not.toMatch(/data-\[side=(left|right)\]:(?:[a-z]+:)*w-/);
  });

  it("sidebar mobile vẫn truyền w-(--sidebar-width) cho SheetContent", () => {
    const src = read("sidebar.tsx");
    const block = src.slice(src.indexOf("<SheetContent"), src.indexOf("</SheetContent>"));
    expect(block).toContain("w-(--sidebar-width)");
  });

  it("cn gộp: w-(--sidebar-width) của nơi dùng thay w-full mặc định", () => {
    const merged = cn("fixed", ["w-full", "sm:max-w-lg"], "w-(--sidebar-width) bg-sidebar p-0").split(/\s+/);
    expect(merged).toContain("w-(--sidebar-width)");
    expect(merged).not.toContain("w-full");
  });

  // ADR-261: mobile — sheet chiếm hết bề ngang (không vượt 100vw), hộp thoại luôn chừa lề và không cao quá khung nhìn.
  it("mobile: SheetContent mặc định w-full; DialogContent chừa lề 2rem + giới hạn 90dvh", () => {
    expect(read("sheet.tsx")).toMatch(/\["w-full", SHEET_SIZE\[size\]\]/);
    expect(read("dialog.tsx")).toContain("w-[calc(100%-2rem)]");
    expect(read("overlay-size.ts")).not.toMatch(/(?<!sm:)max-w-(sm|lg|2xl)/);
    expect(read("overlay-size.ts")).toContain("90dvh");
  });
});
