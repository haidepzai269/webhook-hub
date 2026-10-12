import {
  ageRange,
  AUDIT_PARAMS,
  clearParams,
  DELIVERY_PARAMS,
  DLQ_PARAMS,
  EVENT_LOG_PARAMS,
  EXECUTION_PARAMS,
  isoToLocalInput,
  localInputToIso,
  readParams,
  toApiQuery,
  withCursor,
  withFilter,
} from "./list-url";

const DEST = "11111111-1111-1111-1111-111111111111";
const CUR = "WyIyMDI2LTEwLTEyVDAzOjAwOjAwLjEyMzQ1NiIsIjEiXQ";

describe("list-url — bộ lọc + cursor trên URL", () => {
  it("readParams: giữ giá trị hợp lệ, BỎ giá trị lạ (link cũ / gõ tay) thay vì gửi lên để nhận 400", () => {
    const sp = new URLSearchParams(`status=DEAD&destination=${DEST}&code=5xx&from=2026-10-01T00:00:00.000Z&before=${CUR}&junk=1`);
    expect(readParams(sp, DELIVERY_PARAMS)).toEqual({ status: "DEAD", destination: DEST, code: "5xx", from: "2026-10-01T00:00:00.000Z", before: CUR });
    const bad = new URLSearchParams("status=LOST&destination=abc&code=99&from=hôm-qua&before=x");
    expect(readParams(bad, DELIVERY_PARAMS)).toEqual({});
    expect(readParams(new URLSearchParams("errorKind=http_4xx&age=24h"), DLQ_PARAMS)).toEqual({ errorKind: "http_4xx", age: "24h" });
    expect(readParams(new URLSearchParams("errorKind=boom&age=99y"), DLQ_PARAMS)).toEqual({});
    // link cũ trước khi đổi tên nhóm lỗi
    expect(readParams(new URLSearchParams("errorKind=http_5xx"), DLQ_PARAMS)).toEqual({ errorKind: "http_other" });
    expect(readParams(new URLSearchParams("action=delivery.&entityType=delivery&actor=admin@x.vn"), AUDIT_PARAMS)).toEqual({
      action: "delivery.",
      entityType: "delivery",
      actor: "admin@x.vn",
    });
    expect(readParams(new URLSearchParams("type=payment.*&q=01JA&status=failed"), EXECUTION_PARAMS)).toEqual({ type: "payment.*", q: "01JA", status: "failed" });
    expect(readParams(new URLSearchParams("logProvider=payos&logProbes=hide&logStatus=nope"), EVENT_LOG_PARAMS)).toEqual({ logProvider: "payos", logProbes: "hide" });
  });

  it("withFilter: đổi lọc -> BỎ cursor (về trang mới nhất), rỗng = xoá khoá, giữ tham số khác", () => {
    const cur = `status=DEAD&before=${CUR}&projectId=p1`;
    expect(withFilter(cur, { status: "RETRYING" })).toBe("?projectId=p1&status=RETRYING");
    expect(withFilter(cur, { status: "" })).toBe("?projectId=p1");
    expect(withFilter("", { status: null })).toBe("");
  });

  it("withCursor: Sau = before, Trước = after (loại trừ nhau), null = trang đầu; bộ lọc giữ nguyên", () => {
    expect(withCursor("status=DEAD", { before: CUR })).toBe(`?before=${CUR}&status=DEAD`);
    expect(withCursor(`status=DEAD&before=${CUR}`, { after: "AAAAAAAAAA" })).toBe("?after=AAAAAAAAAA&status=DEAD");
    expect(withCursor(`status=DEAD&after=${CUR}`, {})).toBe("?status=DEAD");
  });

  it("clearParams: bỏ mọi khoá của trang, giữ khoá lạ", () => {
    expect(clearParams(`status=DEAD&code=500&before=${CUR}&projectId=p1`, DELIVERY_PARAMS)).toBe("?projectId=p1");
  });

  it("toApiQuery: bỏ rỗng, đổi tên khoá URL -> API, thứ tự ổn định (query key ổn định)", () => {
    expect(toApiQuery({ logProvider: "payos", logProbes: "hide", logStatus: undefined }, { logProvider: "provider", logProbes: "probes", logStatus: "status" })).toBe(
      "probes=hide&provider=payos",
    );
  });

  it("ageRange: preset -> from/to tính từ now; lạ -> rỗng", () => {
    const now = Date.parse("2026-10-12T12:00:00.000Z");
    expect(ageRange("24h", now)).toEqual({ from: "2026-10-11T12:00:00.000Z" });
    expect(ageRange("gt7d", now)).toEqual({ to: "2026-10-05T12:00:00.000Z" });
    expect(ageRange("x", now)).toEqual({});
    expect(ageRange(undefined, now)).toEqual({});
  });

  it("datetime-local <-> ISO đi vòng không lệch (theo giờ máy)", () => {
    const iso = localInputToIso("2026-10-12T08:30");
    expect(iso).toMatch(/Z$/);
    expect(isoToLocalInput(iso)).toBe("2026-10-12T08:30");
    expect(localInputToIso("")).toBeUndefined();
    expect(isoToLocalInput("rác")).toBe("");
  });
});
