import * as fs from "fs";
import * as path from "path";

import {
  AUDIT_KEY,
  countdownTicker,
  describeDeleteConflict,
  errorMessageOf,
  emptyToastCursor,
  keysAfterAudited,
  stepToasts,
  TOAST_WINDOW_MS,
} from "./ui-logic";

/** Review SPEC-2 #8 + #1c (ADR-054): logic UI thuần — chạy bằng jest gốc của repo (web không có runner riêng). */
type T = { receivedAt: number; outcome: string; id: string };
const tr = (id: string, receivedAt: number, outcome = "REJECTED"): T => ({ id, receivedAt, outcome });

describe("stepToasts — mốc toast trong store + gộp khi bị dội", () => {
  it("mount lại với cùng danh sách trace (cursor giữ ở store) -> KHÔNG toast lại", () => {
    const traces = [tr("b", 2000), tr("a", 1000)];
    const first = stepToasts(traces, emptyToastCursor<T>(), 10_000);
    expect(first.toast?.trace.id).toBe("b");
    const remount = stepToasts(traces, first.cursor, 10_500);
    expect(remount.toast).toBeNull();
    expect(remount.flushInMs).toBeNull();
  });

  it("bị dội 50 trace REJECTED -> 1 toast kèm +49", () => {
    const traces = Array.from({ length: 50 }, (_, i) => tr(`t${i}`, 50 - i));
    const s = stepToasts(traces, emptyToastCursor<T>(), 10_000);
    expect(s.toast).toEqual({ trace: traces[0], more: 49 });
  });

  it("tối đa 1 toast / 2s: trace tới trong cửa sổ bị dồn, xả khi hết cửa sổ với +N", () => {
    const s1 = stepToasts([tr("a", 1)], emptyToastCursor<T>(), 10_000);
    expect(s1.toast?.trace.id).toBe("a");
    const s2 = stepToasts([tr("c", 3), tr("b", 2), tr("a", 1)], s1.cursor, 10_500);
    expect(s2.toast).toBeNull();
    expect(s2.flushInMs).toBe(TOAST_WINDOW_MS - 500);
    const s3 = stepToasts([tr("c", 3), tr("b", 2), tr("a", 1)], s2.cursor, 12_000);
    expect(s3.toast).toEqual({ trace: expect.objectContaining({ id: "c" }), more: 1 });
    expect(s3.cursor.pending).toBe(0);
  });

  it("ACCEPTED không toast nhưng vẫn đẩy mốc", () => {
    const s = stepToasts([tr("ok", 5, "ACCEPTED")], emptyToastCursor<T>(), 10_000);
    expect(s.toast).toBeNull();
    expect(s.cursor.watermark).toBe(5);
  });
});

describe("countdownTicker — tự clearInterval khi về 0", () => {
  it("dừng đúng lúc tới giờ, không tick tiếp", () => {
    jest.useFakeTimers();
    let now = 0;
    const seen: number[] = [];
    const id = setInterval(
      countdownTicker(3000, (n) => seen.push(n), () => clearInterval(id), () => now),
      1000,
    );
    for (let i = 0; i < 10; i++) {
      now += 1000;
      jest.advanceTimersByTime(1000);
    }
    expect(seen).toEqual([1000, 2000, 3000]);
    expect(jest.getTimerCount()).toBe(0);
    jest.useRealTimers();
  });
});

describe("invalidate ['audit'] sau mọi mutation có audit", () => {
  it("keysAfterAudited luôn thêm ['audit']", () => {
    expect(keysAfterAudited(["sources"])).toEqual([["sources"], AUDIT_KEY]);
  });

  it("queries.ts: mọi useMutation đều làm mới audit qua invalidateAudited (không invalidate tay)", () => {
    const src = fs.readFileSync(path.join(__dirname, "queries.ts"), "utf8");
    const mutations = src.split("useMutation({").slice(1);
    expect(mutations.length).toBeGreaterThanOrEqual(9);
    for (const m of mutations) {
      const body = m.slice(0, m.indexOf("\n  });"));
      expect(body).toMatch(/invalidateAudited\(qc/);
    }
  });
});

describe("describeDeleteConflict — thông báo 409 dễ hiểu", () => {
  it("subscription còn delivery -> gợi ý Tắt", () => {
    expect(describeDeleteConflict({ status: 409, body: { deliveryCount: 4 }, message: "x" })).toMatch(/4 delivery.*Tắt/);
  });
  it("đích còn subscription -> nêu số subscription", () => {
    expect(describeDeleteConflict({ status: 409, body: { subscriptionCount: 2, deliveryCount: 9 } })).toMatch(/2 subscription/);
  });
  it("không phải 409 -> null", () => {
    expect(describeDeleteConflict({ status: 500 })).toBeNull();
    expect(describeDeleteConflict(new Error("x"))).toBeNull();
  });
});

describe("errorMessageOf — DX1: console giữ câu tiếng Việt (ADR-136)", () => {
  it("ưu tiên detail; thiếu detail -> câu Việt theo mã; mã lạ -> message; 5xx kèm requestId", () => {
    expect(errorMessageOf({ error: "bad_request", message: "The request is invalid.", detail: "range phải là '24h' hoặc '7d'" })).toBe(
      "range phải là '24h' hoặc '7d'",
    );
    expect(errorMessageOf({ error: "not_found", message: "The resource was not found." })).toMatch(/Không tìm thấy/);
    expect(errorMessageOf({ error: "internal_error", message: "Internal error.", requestId: "r-123" })).toMatch(/r-123/);
    expect(errorMessageOf({ error: "zzz", message: "Plain" })).toBe("Plain");
    expect(errorMessageOf({ message: ["a", "b"] })).toBe("a, b");
    expect(errorMessageOf(null)).toBe("");
  });
});
