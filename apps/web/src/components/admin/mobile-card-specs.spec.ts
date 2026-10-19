import * as fs from "fs";
import * as path from "path";

import {
  AUDIT_MOBILE_CARD,
  DESTINATION_MOBILE_CARD,
  PROJECT_MOBILE_CARD,
  SOURCE_MOBILE_CARD,
  SUBSCRIPTION_MOBILE_CARD,
} from "./mobile-card-specs";
import { type MobileCardSpec, planMobileCard } from "./responsive-table-logic";

/** Id cột khai báo thật trong trang (`id: "…"` ở cấp cột) — thẻ mobile chọn cột theo id nên lệch tên là thẻ mất ô, không báo lỗi. */
const columnIds = (rel: string) => {
  const src = fs.readFileSync(path.join(__dirname, "../..", rel), "utf8");
  return new Set([...src.matchAll(/^\s{4,16}id: "(\w+)",\n\s+header:/gm)].map((m) => m[1]));
};

const CASES: [string, MobileCardSpec, string][] = [
  ["Nguồn", SOURCE_MOBILE_CARD, "app/(admin)/dashboard/sources/page.tsx"],
  ["Đích", DESTINATION_MOBILE_CARD, "app/(admin)/dashboard/destinations/page.tsx"],
  ["Đăng ký", SUBSCRIPTION_MOBILE_CARD, "app/(admin)/dashboard/subscriptions/page.tsx"],
  ["Nhật ký", AUDIT_MOBILE_CARD, "app/(admin)/dashboard/audit/page.tsx"],
  ["Dự án", PROJECT_MOBILE_CARD, "app/(admin)/dashboard/projects/page.tsx"],
];

describe("Thẻ mobile tầng B (ADR-261 pha 2)", () => {
  it.each(CASES)("%s: mọi id trong spec là cột có thật", (_n, spec, file) => {
    const ids = columnIds(file);
    const used = [spec.title, spec.badge, spec.actions, ...(spec.meta ?? []), ...(spec.wide ?? [])].filter(Boolean) as string[];
    for (const id of used) expect(ids).toContain(id);
  });

  it.each(CASES)("%s: ô wide nằm trong meta, không trùng ô khác", (_n, spec) => {
    for (const w of spec.wide ?? []) expect(spec.meta).toContain(w);
    const all = [spec.title, spec.badge, spec.actions, ...(spec.meta ?? [])].filter(Boolean);
    expect(new Set(all).size).toBe(all.length);
  });

  it("Nguồn: ẩn cột thao tác thì thẻ không còn hàng nút; cột bí mật không lên thẻ", () => {
    const plan = planMobileCard(SOURCE_MOBILE_CARD, ["name", "provider", "secret", "isActive", "createdAt"]);
    expect(plan.actions).toBeNull();
    expect(plan.meta.map((m) => m.id)).not.toContain("secret");
  });

  it("Nhật ký: không có huy hiệu, hành động làm tiêu đề", () => {
    const plan = planMobileCard(AUDIT_MOBILE_CARD, ["createdAt", "actor", "action", "entity", "reason"]);
    expect(plan.title).toBe("action");
    expect(plan.badge).toBeNull();
    expect(plan.meta.filter((m) => m.wide).map((m) => m.id)).toEqual(["entity", "reason"]);
  });

  it("Dự án: cột usage/quota chỉ có với người vận hành — thiếu thì bị bỏ, không lỗi", () => {
    const plan = planMobileCard(PROJECT_MOBILE_CARD, ["name", "slug", "environment", "role", "actions"]);
    expect(plan.meta.map((m) => m.id)).toEqual(["slug", "role"]);
    expect(plan.actions).toBe("actions");
  });
});
