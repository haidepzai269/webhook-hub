import { ROLE_SCOPES } from "@hub/common/auth/roles";
import { canScope, effectiveRole, type RoleSubject } from "./effective-role";

const P = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const who = (isOperator: boolean, role?: string): RoleSubject => ({
  user: { isOperator },
  memberships: role ? [{ projectId: P, role }] : [],
});

describe("effectiveRole / canScope — khớp resolveProjectScope của server (viaOperator chỉ khi KHÔNG là thành viên)", () => {
  it.each([
    ["operator không là thành viên", who(true), "owner"],
    ["operator là viewer", who(true, "viewer"), "viewer"],
    ["operator là developer", who(true, "developer"), "developer"],
    ["operator là owner", who(true, "owner"), "owner"],
    ["developer", who(false, "developer"), "developer"],
    ["viewer", who(false, "viewer"), "viewer"],
    ["không phải thành viên, không operator", who(false), null],
    ["role lạ", who(false, "root"), null],
  ])("%s -> %s", (_n, me, role) => {
    expect(effectiveRole(me, P)).toBe(role);
  });

  it("thiếu me / projectId -> null; membership của project KHÁC không tính", () => {
    expect(effectiveRole(null, P)).toBeNull();
    expect(effectiveRole(who(true, "owner"), null)).toBeNull();
    expect(effectiveRole(who(false, "owner"), OTHER)).toBeNull();
    expect(effectiveRole(who(true, "viewer"), OTHER)).toBe("owner"); // operator, không là thành viên của OTHER
  });

  it("ma trận nút: viewer-operator KHÔNG thấy nút ghi (server 403); operator ngoài project thấy hết", () => {
    const archive = (me: RoleSubject) => canScope(me, P, "manage:sources", "manage:endpoints");
    const storageWrite = (me: RoleSubject) => canScope(me, P, "storage:write");
    const storageRead = (me: RoleSubject) => canScope(me, P, "storage:read");
    const traffic = (me: RoleSubject) => canScope(me, P, "traffic:read");
    const rows: [string, RoleSubject, boolean[]][] = [
      // [archive, storage:write, storage:read, traffic:read]
      ["operator không là thành viên", who(true), [true, true, true, true]],
      ["operator là viewer", who(true, "viewer"), [false, false, false, false]],
      ["operator là owner", who(true, "owner"), [true, true, true, true]],
      ["developer", who(false, "developer"), [true, false, true, false]],
      ["viewer", who(false, "viewer"), [false, false, false, false]],
    ];
    for (const [name, me, want] of rows) {
      expect([archive(me), storageWrite(me), storageRead(me), traffic(me)]).toEqual(want);
      expect(name).toBeTruthy();
    }
  });

  it("đọc đúng ROLE_SCOPES của @hub/common: mọi scope của từng role đều true, scope ngoài role đều false", () => {
    for (const role of ["viewer", "developer", "owner"] as const) {
      for (const s of ROLE_SCOPES.owner) expect(canScope(who(false, role), P, s)).toBe((ROLE_SCOPES[role] as readonly string[]).includes(s));
    }
  });
});
