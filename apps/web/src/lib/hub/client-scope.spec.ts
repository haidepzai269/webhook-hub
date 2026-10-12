import { scopeToProject } from "./client";

/** AU3 (DINH-CHINH-AUTH §3): MỌI query console gửi projectId — gắn ở MỘT chỗ (hubFetch). */
describe("scopeToProject", () => {
  const P = "391110c1-3a81-480a-93ab-e11de0be107a";
  it("gắn ?projectId= cho /api/v1/*; giữ query sẵn có; không gắn cho /api/v1/projects, /auth/*, hay khi đã có", () => {
    expect(scopeToProject("/api/v1/events", P)).toBe(`/api/v1/events?projectId=${P}`);
    expect(scopeToProject("/api/v1/events?limit=5", P)).toBe(`/api/v1/events?limit=5&projectId=${P}`);
    expect(scopeToProject("/api/v1/projects", P)).toBe("/api/v1/projects");
    expect(scopeToProject(`/api/v1/projects/${P}/keys`, P)).toBe(`/api/v1/projects/${P}/keys`);
    expect(scopeToProject("/auth/me", P)).toBe("/auth/me");
    expect(scopeToProject("/api/v1/flow/topology?projectId=x", P)).toBe("/api/v1/flow/topology?projectId=x");
    expect(scopeToProject("/api/v1/events", null)).toBe("/api/v1/events");
    // CB4: cảnh báo xuyên project của operator + tuỳ chọn gắn người — không bị gắn project đang chọn.
    expect(scopeToProject("/api/v1/alerts/summary", P)).toBe("/api/v1/alerts/summary");
    expect(scopeToProject(`/api/v1/alerts?project=${P}&state=OPEN`, P)).toBe(`/api/v1/alerts?project=${P}&state=OPEN`);
    expect(scopeToProject("/api/v1/me/locale", P)).toBe("/api/v1/me/locale");
  });
});
