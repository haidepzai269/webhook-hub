// Kiểm chứng sơ đồ Hành trình sự kiện: nút bấm được (chuột + bàn phím), pan vẫn hoạt động, node cuối không bị cắt.
//   node apps/web/scripts/journey-click-test.mjs     (cần `next dev -p 3000`; API được giả bằng Playwright route, không gọi dịch vụ thật)
import { chromium } from "@playwright/test";

const WEB = process.env.WEB ?? "http://localhost:3000";
const VIEWPORTS = (process.env.VIEWPORTS ?? "768,1024,1280,1440,1920").split(",").map(Number);
const NOW = Date.now();
const iso = (ms) => new Date(NOW + ms).toISOString();
const EVENT_ID = "0190a1b2-c3d4-7e5f-8a9b-000000000400";
const DELIVERY_ID = "0190a1b2-c3d4-7e5f-8a9b-000000000d01";
const PROJECT = { id: "p1", slug: "demo", name: "Demo", environment: "production", role: "owner", member: true };
const ME = { user: { id: "u1", email: "a@example.com", name: "A", emailVerified: true, locale: "vi", isOperator: true }, memberships: [{ projectId: "p1", slug: "demo", name: "Demo", environment: "production", role: "owner" }] };

const st = (key, status, off, title, extra = {}) => ({ id: key, key, status, startedAt: iso(off - 5), endedAt: iso(off), durationMs: 5, offsetMs: off, title, ...extra });
const stages = [
  st("received", "ok", 0, "Nhận từ PayOS"),
  st("verified", "ok", 12, "Chữ ký hợp lệ"),
  st("persisted", "ok", 30, "Đã COMMIT"),
  st("normalized", "ok", 41, "payment.succeeded"),
  st("routed", "ok", 50, "Khớp 1 subscription"),
];
const attempt = { id: `${DELIVERY_ID}:attempt:1`, key: "delivering", status: "failed", startedAt: iso(60), endedAt: iso(806), durationMs: 746, offsetMs: 806, title: "Lần 1", subtitle: "HTTP 404", detail: { attemptNo: 1, httpStatus: 404 } };
const branch = {
  deliveryId: DELIVERY_ID,
  subscription: { id: "s1", name: "Đơn hàng", eventTypes: ["payment.succeeded"] },
  destination: { id: "d1", name: "Shop webhook", type: "webhook" },
  generation: 1,
  status: "failed",
  history: [],
  stages: [
    { id: `${DELIVERY_ID}:delivery`, key: "delivering", status: "failed", startedAt: iso(55), endedAt: iso(806), durationMs: 750, offsetMs: 806, title: "Giao tới Shop webhook", detail: { circuitState: "CLOSED" } },
    attempt,
    { id: `${DELIVERY_ID}:done`, key: "done", status: "failed", startedAt: iso(806), endedAt: iso(810), durationMs: 4, offsetMs: 810, title: "DEAD", reason: { code: "max_attempts", message: "Hết lượt thử" }, actions: ["replay_delivery", "open_dlq"], branchId: DELIVERY_ID },
  ],
};
const flow = {
  id: EVENT_ID, stages, branches: [branch], summary: [], executionStatus: "failed", failedAt: null,
  event: { id: EVENT_ID, type: "payment.succeeded", source: "payos", subject: "DH1", normalized: true, origin: "webhook", correlationId: "c1", occurredAt: iso(0), receivedAt: iso(0), verified: true },
  raw: { id: "r1", status: "ACCEPTED", provider: "payos", providerLabel: "PayOS", sourceId: "src1", sourceName: "PayOS", receivedAt: iso(0), verified: true },
};

const browser = await chromium.launch({ channel: "chrome", headless: true });
const fails = [];
const ok = (cond, msg) => { if (!cond) fails.push(msg); console.log(`${cond ? "OK  " : "FAIL"} ${msg}`); };

for (const vw of VIEWPORTS) {
  const ctx = await browser.newContext({ viewport: { width: vw, height: 950 } });
  const replayCalls = [];
  await ctx.route(/\/(api|auth)\//, async (route) => {
    const u = new URL(route.request().url());
    const p = u.pathname;
    const send = (b) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(b) });
    if (p === "/auth/me") return send(ME);
    if (p === "/api/v1/projects") return send([PROJECT]);
    if (p === "/api/v1/alerts") return send({ items: [], next: null, prev: null });
    if (p === "/api/v1/alerts/summary") return send({ openBySeverity: { critical: 0, warning: 0, info: 0 }, unacked: 0, perProject: [] });
    if (p === `/api/v1/flow/events/${EVENT_ID}`) return send(flow);
    if (p.endsWith("/replay") && route.request().method() === "POST") { replayCalls.push(p); await new Promise((r) => setTimeout(r, 300)); return send({ success: true, generation: 2 }); }
    return send(p.endsWith("s") ? [] : {});
  });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("pageerror:", String(e).slice(0, 300)));
  page.on("console", (m) => m.type() === "error" && console.log("console.error:", m.text().slice(0, 300)));
  await page.goto(`${WEB}/dashboard/events/${EVENT_ID}`, { waitUntil: "domcontentloaded", timeout: 180_000 });
  await page.waitForSelector(".react-flow__node", { timeout: 40_000 }).catch(async () => { console.log("BODY:", (await page.locator("body").innerText()).slice(0, 600)); throw new Error("không có node"); });
  await page.waitForTimeout(1200);
  const tag = `${vw}px`;

  // 1) Fit: mọi node nằm trọn trong khung canvas.
  const fit = await page.evaluate(() => {
    const box = document.querySelector(".react-flow").getBoundingClientRect();
    return [...document.querySelectorAll(".react-flow__node")].map((n) => n.getBoundingClientRect()).filter((r) => r.left < box.left - 1 || r.right > box.right + 1).length;
  });
  ok(fit === 0, `${tag} mọi node nằm trong khung (node bị cắt: ${fit})`);

  // 2) Nút "Phát lại" trong sơ đồ: pointer-events khác none, bấm → POST replay đúng 1 lần.
  const btn = page.locator(".react-flow__node button", { hasText: /Phát lại|Replay/ }).first();
  const pe = await btn.evaluate((e) => getComputedStyle(e).pointerEvents);
  ok(pe !== "none", `${tag} pointer-events của nút Phát lại = ${pe}`);
  await btn.click();
  await page.waitForTimeout(400);
  ok(replayCalls.length === 1, `${tag} bấm chuột "Phát lại" → ${replayCalls.length} lần POST replay`);

  // 3) Bàn phím: Tab tới nút rồi Enter → thêm 1 lần replay, và KHÔNG mở panel chọn node (Enter không nổi bọt lên thẻ).
  await btn.focus();
  await page.keyboard.press("Enter");
  await page.waitForTimeout(400);
  ok(replayCalls.length === 2, `${tag} Enter trên nút → ${replayCalls.length} lần POST replay (cần 2)`);

  await page.waitForTimeout(600); // chờ lượt Enter xong (mock trả sau 300ms) → nút bật lại

  // 3b) Bấm đôi nhanh: chỉ MỘT POST (khoá đồng bộ ở doReplay), và nút bị khoá trong lúc chờ.
  await btn.dblclick();
  const disabledWhileBusy = await btn.isDisabled();
  await page.waitForTimeout(700);
  ok(replayCalls.length === 3, `${tag} bấm đôi "Phát lại" → ${replayCalls.length - 2} POST (cần đúng 1)`);
  ok(disabledWhileBusy, `${tag} nút Phát lại bị disabled trong lúc đang gửi`);

  // 4) "Mở hàng đợi lỗi" điều hướng sang /dashboard/dlq.
  const dlq = page.locator(".react-flow__node button", { hasText: /hàng đợi lỗi|dead-letter|DLQ|Dead/i }).first();
  if (await dlq.count()) {
    await dlq.click();
    await page.waitForURL(/\/dashboard\/dlq/, { timeout: 15_000 }).then(() => ok(true, `${tag} "Mở hàng đợi lỗi" → /dashboard/dlq`)).catch(() => ok(false, `${tag} "Mở hàng đợi lỗi" không điều hướng`));
    await page.goBack();
    await page.waitForSelector(".react-flow__node");
    await page.waitForTimeout(800);
  } else ok(false, `${tag} không thấy nút Mở hàng đợi lỗi`);

  // 5) Chip lần thử bấm được (mở panel chi tiết attempt).
  const chip = page.locator(".react-flow__node button", { hasText: /#1/ }).first();
  await chip.click();
  await page.waitForTimeout(500);
  ok((await page.locator("[role=dialog], [data-slot=sheet-content]").count()) > 0 || (await page.getByText(/HTTP 404|404/).count()) > 1, `${tag} bấm chip #1 mở chi tiết lần thử`);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(800);

  // 6) Kéo vùng trống vẫn pan (viewport transform đổi).
  const before = await page.evaluate(() => getComputedStyle(document.querySelector(".react-flow__viewport")).transform);
  const box = await page.locator(".react-flow__pane").boundingBox();
  await page.mouse.move(box.x + 8, box.y + box.height - 8);
  await page.mouse.down();
  await page.mouse.move(box.x + 60, box.y + box.height - 40, { steps: 6 });
  await page.mouse.up();
  const after = await page.evaluate(() => getComputedStyle(document.querySelector(".react-flow__viewport")).transform);
  ok(before !== after, `${tag} kéo vùng trống vẫn pan (${before} -> ${after}; phần tử tại điểm kéo: ${await page.evaluate(([x, y]) => { const e = document.elementFromPoint(x, y); return e ? e.className : "none"; }, [box.x + 8, box.y + box.height - 8])})`);
  await ctx.close();
}
await browser.close();
console.log(fails.length ? `\n${fails.length} LỖI` : "\nĐẠT toàn bộ");
process.exit(fails.length ? 1 : 0);
