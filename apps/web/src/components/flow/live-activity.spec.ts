import {
  emptyLive,
  FAIL_HOLD_MS,
  IN_FLIGHT_TTL_MS,
  liveEnd,
  livePrune,
  liveStart,
  liveView,
  MAX_TOKENS_PER_HOP,
  SUCCESS_SETTLE_MS,
} from "./live-activity";

/** Trạng thái sống của cạnh/node kiểu n8n: chỉ chạy khi CÓ sự kiện đang bay, TTL để burst không quay mãi. */
describe("live-activity — reducer trạng thái chặng theo sự kiện realtime", () => {
  it("không có gì đang bay -> idle (không animation)", () => {
    expect(liveView(emptyLive(), "e:gate", 0)).toBe("idle");
  });

  it("start -> running; end ok -> ok trong SUCCESS_SETTLE_MS rồi về idle", () => {
    let s = liveStart(emptyLive(), ["e:gate"], "raw-1", 1000);
    expect(liveView(s, "e:gate", 1000)).toBe("running");
    s = liveEnd(s, ["e:gate"], "raw-1", "ok", 1500);
    expect(liveView(s, "e:gate", 1500)).toBe("ok");
    expect(liveView(s, "e:gate", 1500 + SUCCESS_SETTLE_MS - 1)).toBe("ok");
    expect(liveView(s, "e:gate", 1500 + SUCCESS_SETTLE_MS)).toBe("idle");
  });

  it("end fail -> fail giữ lâu hơn (FAIL_HOLD_MS > SUCCESS_SETTLE_MS)", () => {
    let s = liveStart(emptyLive(), ["e:fold:d1"], "dl-1", 0);
    s = liveEnd(s, ["e:fold:d1"], "dl-1", "fail", 100);
    expect(FAIL_HOLD_MS).toBeGreaterThan(SUCCESS_SETTLE_MS);
    expect(liveView(s, "e:fold:d1", 100 + SUCCESS_SETTLE_MS + 1)).toBe("fail");
    expect(liveView(s, "e:fold:d1", 100 + FAIL_HOLD_MS)).toBe("idle");
  });

  it("warn (RETRYING) -> warn, không còn running", () => {
    let s = liveStart(emptyLive(), ["dst:d1"], "dl-1", 0);
    s = liveEnd(s, ["dst:d1"], "dl-1", "warn", 10);
    expect(liveView(s, "dst:d1", 20)).toBe("warn");
  });

  it("còn token khác đang bay -> vẫn running dù một token đã xong", () => {
    let s = liveStart(emptyLive(), ["e:gate"], "a", 0);
    s = liveStart(s, ["e:gate"], "b", 0);
    s = liveEnd(s, ["e:gate"], "a", "ok", 10);
    expect(liveView(s, "e:gate", 10)).toBe("running");
    s = liveEnd(s, ["e:gate"], "b", "ok", 20);
    expect(liveView(s, "e:gate", 20)).toBe("ok");
  });

  it("TTL: token không bao giờ kết thúc (normalize chết, mất socket) -> hết running sau IN_FLIGHT_TTL_MS", () => {
    const s = liveStart(emptyLive(), ["e:gate"], "lost", 0);
    expect(liveView(s, "e:gate", IN_FLIGHT_TTL_MS - 1)).toBe("running");
    expect(liveView(s, "e:gate", IN_FLIGHT_TTL_MS)).toBe("idle");
  });

  it("end không có start (trace tới sau khi ingest đã COMMIT) -> chỉ đặt kết quả", () => {
    const s = liveEnd(emptyLive(), ["e:src:x", "src:x"], "c1", "ok", 0);
    expect(liveView(s, "e:src:x", 1)).toBe("ok");
    expect(liveView(s, "src:x", 1)).toBe("ok");
  });

  it("burst: số token mỗi chặng bị chặn trần (bộ nhớ không phình)", () => {
    let s = emptyLive();
    for (let i = 0; i < MAX_TOKENS_PER_HOP * 3; i++) s = liveStart(s, ["e:gate"], `t${i}`, i);
    expect(Object.keys(s.hops["e:gate"].inflight).length).toBeLessThanOrEqual(MAX_TOKENS_PER_HOP);
  });

  it("prune bỏ token hết hạn + kết quả cũ, báo mốc thức dậy kế tiếp", () => {
    let s = liveStart(emptyLive(), ["e:gate"], "a", 0);
    s = liveEnd(s, ["e:x"], "b", "ok", 0);
    const p1 = livePrune(s, 10);
    expect(p1.nextWakeAt).toBe(SUCCESS_SETTLE_MS); // kết quả ok hết hạn trước token TTL
    const p2 = livePrune(s, IN_FLIGHT_TTL_MS + 1);
    expect(p2.state.hops).toEqual({});
    expect(p2.nextWakeAt).toBeNull();
  });

  it("bất biến: start/end trả state mới, không sửa state cũ", () => {
    const s0 = emptyLive();
    const s1 = liveStart(s0, ["e:gate"], "a", 0);
    expect(s0.hops).toEqual({});
    liveEnd(s1, ["e:gate"], "a", "ok", 1);
    expect(liveView(s1, "e:gate", 1)).toBe("running");
  });
});
