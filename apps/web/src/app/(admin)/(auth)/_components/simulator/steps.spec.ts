import { ALL_STEPS, RETRY_LABELS, SCENARIOS } from "./steps";
import * as fs from "node:fs";
import * as path from "node:path";

/** Chống lệch: mô phỏng trên trang đăng nhập phải khớp code thật — mỗi bước trỏ tới file + đoạn code còn tồn tại. */
describe("mô phỏng webhook — steps khớp code", () => {
  const root = path.resolve(__dirname, "../../../../../../../..");
  const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");
  const sources = ALL_STEPS.flatMap((s) => [s.source, ...(s.also ?? [])].map((src) => [s.id, src.file, src.symbol]));
  const okOrder = SCENARIOS.find((s) => s.id === "ok")?.frames.map((f) => f.id) ?? [];
  const before = (...ids: string[]) =>
    ids.map((id) => okOrder.indexOf(id)).every((v, i, a) => v >= 0 && (i === 0 || v > a[i - 1]));

  it.each(sources)("%s → %s chứa %s", (_id, file, symbol) => {
    expect(fs.existsSync(path.join(root, file))).toBe(true);
    expect(read(file)).toContain(symbol);
  });

  it("BB-3: kịch bản ok — SET NX sau COMMIT, ACK sau cả hai", () => {
    expect(before("tx-raw-outbox", "redis-set-nx", "ack-provider")).toBe(true);
  });

  it("delivery: findDeliveryForSend → getState → claimForSend, cả trong code lẫn trong kịch bản", () => {
    const src = read("apps/hub-worker/src/consumers/delivery.consumer.ts");
    // BP2 (ADR-196): message có gợi ý thì gate (getState) chạy TRƯỚC khi nạp; đường đầy đủ vẫn có getState sau
    // findDeliveryForSend và trước claimForSend (message cũ / gợi ý lệch) -> tìm tuần tự từ vị trí trước đó.
    let pos = -1;
    const at = ["repo.findDeliveryForSend(", "this.circuitBreaker.getState(", "repo.claimForSend("].map((x) => (pos = src.indexOf(x, pos + 1)));
    expect(at.every((v, i) => v >= 0 && (i === 0 || v > at[i - 1]))).toBe(true);
    expect(before("load-delivery", "circuit-check", "sign-send")).toBe(true);
  });

  it("mỗi tầng retry mô phỏng có thật trong topology", () => {
    const topology = read("libs/messaging/src/topology.ts");
    for (const tier of RETRY_LABELS) expect(topology).toContain(`'q.delivery.retry.${tier}'`);
  });
});
