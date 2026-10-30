// Kiểm tra KHÔNG CÓ cuộn ngang ở mọi trang console + overlay (bảng, dialog, sheet) bằng Playwright + Chrome hệ thống.
//   node apps/web/scripts/overflow-audit.mjs            (cần `next dev -p 3000` đang chạy; KHÔNG cần hub-api — API được giả)
// Env: WEB (mặc định http://localhost:3000), VIEWPORTS (360,768,...), PAGES (lọc theo đường dẫn, phân cách dấu phẩy),
//      OVERLAYS=0 để bỏ qua bước mở overlay, SHOTS=<thư mục> để chụp ảnh các ca lỗi.
// Dữ liệu giả CỐ Ý dài (tên, URL, id, ghi chú) để lòi lỗi tràn. Không gọi dịch vụ thật, không dùng secret.
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { chromium } from "@playwright/test";

const WEB = process.env.WEB ?? "http://localhost:3000";
const VIEWPORTS = (process.env.VIEWPORTS ?? "360,768,1024,1280,1440,1920").split(",").map(Number);
const ONLY = process.env.PAGES ? process.env.PAGES.split(",") : null;
const OVERLAYS = process.env.OVERLAYS !== "0";
const SHOTS = process.env.SHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const NOW = Date.now();
const iso = (minAgo) => new Date(NOW - minAgo * 60_000).toISOString();
const uuid = (n) => `0190a1b2-c3d4-7e5f-8a9b-${String(n).padStart(12, "0")}`;
const LONG_URL = "https://hooks.example-very-long-domain-name.internal.corp.example.com/v1/integrations/webhooks/receive/team-payments-eu-west-1/production";

const PROJECT = { id: uuid(1), slug: "cua-hang-ca-phe-trung-nguyen-legend-chi-nhanh-quan-1", name: "Cửa hàng cà phê Trung Nguyên Legend chi nhánh Quận 1", environment: "production", role: "owner", member: true };
const ME = { user: { id: uuid(2), email: "nguoi.dung.co.email.rat.dai@example-company-domain.com", name: "Nguyễn Văn Quản Trị Viên", emailVerified: true, locale: "vi", isOperator: true }, memberships: [{ projectId: PROJECT.id, slug: PROJECT.slug, name: PROJECT.name, environment: "production", role: "owner" }] };

const sources = Array.from({ length: 8 }, (_, i) => ({
  id: uuid(100 + i),
  provider: ["github", "payos", "stripe", "sepay", "generic"][i % 5],
  name: i % 2 ? `Nguồn thanh toán PayOS cho cửa hàng chi nhánh số ${i} (production)` : `src-${i}`,
  sourceKey: `sk_live_${"abcdef0123456789".repeat(3)}${i}`,
  isActive: i !== 3,
  createdAt: iso(1000 * (i + 1)),
  webhookUrl: `/hooks/payos/${"abcdef0123456789".repeat(2)}${i}`,
  ingestUrl: `https://hub-api-singapore-production.onrender.com/hooks/payos/${"abcdef0123456789".repeat(2)}${i}`,
  secretVersions: 2,
  keepLonger: i === 1,
  verificationConfig: { scheme: i === 4 ? "unverified" : "hmac" },
}));
const destinations = Array.from({ length: 6 }, (_, i) => ({
  id: uuid(200 + i),
  name: i % 2 ? `Đích nhận webhook của dịch vụ kế toán nội bộ số ${i} ${LONG_URL}` : `dst-${i}`,
  type: ["webhook", "telegram", "discord"][i % 3],
  rateLimitRps: 10 * (i + 1),
  circuitState: ["CLOSED", "OPEN", "HALF_OPEN"][i % 3],
  hasSigningSecret: true,
  verification: ["VERIFIED", "PENDING", "FAILED"][i % 3],
  verificationError: i % 3 === 2 ? "Máy chủ đích trả về 404 khi gửi challenge tới " + LONG_URL : null,
  verificationFix: null,
  verifiedAt: iso(500),
  managedByService: i === 0,
  createdAt: iso(2000 + i),
}));
const subscriptions = Array.from({ length: 6 }, (_, i) => ({
  id: uuid(300 + i),
  destinationId: destinations[i].id,
  name: `Đăng ký nhận sự kiện thanh toán và kho hàng cho đích số ${i} với tên rất dài`,
  eventTypes: ["payment.succeeded", "payment.failed", "repo.push", "repo.pull_request.opened", "payment.refunded", "*"].slice(0, 2 + (i % 4)),
  template: i % 2 ? "{{ data.summary }} — {{ data.customer.name }} đã thanh toán {{ data.amount }} {{ data.currency }}" : null,
  isActive: i !== 2,
  acceptUnverified: i === 1,
  createdAt: iso(3000 + i),
  destination: destinations[i],
  sourceIds: [sources[0].id],
}));
const events = Array.from({ length: 12 }, (_, i) => ({
  id: uuid(400 + i),
  type: i % 2 ? "payment.succeeded" : "repo.pull_request.opened",
  source: `payos-${i}`,
  subject: `ORDER-${"9".repeat(24)}-${i}`,
  data: { amount: 120000, note: "x".repeat(80) },
  origin: "webhook",
  correlationId: uuid(500 + i),
  occurredAt: iso(i * 5),
  receivedAt: iso(i * 5),
  verified: true,
}));
const dead = Array.from({ length: 8 }, (_, i) => ({
  id: uuid(600 + i),
  eventId: events[i].id,
  subscriptionId: subscriptions[i % 6].id,
  attemptGeneration: 1,
  status: "DEAD",
  attemptCount: 6,
  nextAttemptAt: null,
  lastError: `connect ECONNREFUSED 10.0.0.${i}:443 — ${LONG_URL} không phản hồi sau 6 lần thử, đã bỏ vào hàng đợi lỗi`,
  createdAt: iso(60 + i),
  updatedAt: iso(30 + i),
  event: events[i],
  subscription: { ...subscriptions[i % 6] },
  attempts: [{ id: uuid(700 + i), attemptNo: 1, responseStatus: 500, durationMs: 1200, error: "timeout", createdAt: iso(50) }],
}));
const execs = Array.from({ length: 10 }, (_, i) => ({
  id: uuid(800 + i),
  eventId: events[i % 12].id,
  rawEventId: uuid(900 + i),
  receivedAt: iso(i * 3),
  provider: "payos",
  providerLabel: "PayOS",
  sourceId: sources[1].id,
  sourceName: sources[1].name,
  type: "payment.succeeded",
  subject: `ORDER-${"9".repeat(24)}-${i}`,
  probe: false,
  verified: true,
  status: ["delivered", "failed", "pending", "rejected"][i % 4],
  summary: [],
  failedAt: null,
}));
const audit = Array.from({ length: 10 }, (_, i) => ({
  id: uuid(1000 + i),
  action: "destination.update",
  entityType: "destination",
  entityId: uuid(200 + i),
  actor: "nguoi.dung.co.email.rat.dai@example-company-domain.com",
  reason: "Đổi URL đích sang " + LONG_URL + " theo yêu cầu của đội vận hành " + "rất dài ".repeat(8),
  metadata: { from: LONG_URL, to: LONG_URL + "/v2" },
  createdAt: iso(i * 20),
}));
const apiKeys = Array.from({ length: 5 }, (_, i) => ({
  id: uuid(1100 + i),
  serviceName: `dich-vu-thanh-toan-noi-bo-rat-dai-${i}`,
  keyPrefix: "whk_live_ab12cd34",
  scopes: ["events:publish", "events:read", "endpoints:manage", "keys:manage"].slice(0, 1 + (i % 4)),
  lastUsedAt: iso(10),
  revokedAt: i === 4 ? iso(5) : null,
  createdAt: iso(5000),
}));
const alerts = Array.from({ length: 5 }, (_, i) => ({
  id: uuid(1200 + i),
  rule: "dlq.growth",
  severity: ["critical", "warning", "info"][i % 3],
  titleKey: "alerts.rule.dlq",
  subjectType: "project",
  subjectId: PROJECT.id,
  state: "OPEN",
  openedAt: iso(30),
  lastSeenAt: iso(1),
  resolvedAt: null,
  acknowledgedAt: null,
  acknowledgedBy: null,
  facts: { count: 12 },
  project: { id: PROJECT.id, slug: PROJECT.slug, name: PROJECT.name },
}));
const stats = { createdAt: iso(9000), sources: 8, endpoints: 6, members: 3, events24h: 1200, failedAttempts24h: 14, dlq: 8, circuitOpen: 1, storageLevel: "OK", openAlerts: { critical: 1, warning: 2, info: 0 } };

function mock(method, path) {
  const p = path.split("?")[0];
  if (p === "/auth/me") return ME;
  if (p === "/api/v1/projects") return [{ ...PROJECT, stats, usage: { estimated: true, usedBytes: 5e8, quotaBytes: 1e9, usedPct: 50, level: "OK", quotaOverrideMb: null } }, ...Array.from({ length: 4 }, (_, i) => ({ ...PROJECT, id: uuid(20 + i), slug: `du-an-${i}-${"dai".repeat(10)}`, name: `Dự án số ${i} có tên rất rất dài ${"để thử tràn ".repeat(4)}`, stats }))];
  if (p.startsWith("/api/v1/projects/") && p.endsWith("/storage")) {
    return { estimated: true, usedBytes: 5e8, quotaBytes: 1e9, usedPct: 50, level: "OK", measuredAt: iso(5), calibratedAt: null, bloatFactor: 1.2, bySource: sources.map((s) => ({ sourceId: s.id, name: s.name, keepLonger: false, bytes: 5e7 })), byImportance: { junk: { events: 10, bytes: 1e6 }, low: { events: 10, bytes: 1e6 }, medium: { events: 10, bytes: 1e6 }, high: { events: 10, bytes: 1e6 } }, growthPerDay: 1e7, forecastHours: 400, suggestions: [], suggestionsAt: iso(5), lockEnabled: true, autoCleanEnabled: true, recentCleanJobs: Array.from({ length: 4 }, (_, i) => ({ id: uuid(1300 + i), status: "DONE", importance: "junk", action: "trim", afterDays: 7, events: 100, freedBytes: 1e6, requestedBy: "nguoi.dung.co.email.rat.dai@example-company-domain.com", createdAt: iso(100), finishedAt: iso(99) })), sources: { count: 8, limit: 50 } };
  }
  if (p.endsWith("/storage/policies")) return { policies: ["junk", "low", "medium"].map((importance) => ({ importance, action: "trim", afterDays: 7, trigger: "always", updatedBy: "x", updatedAt: iso(5) })), autoCleanEnabled: true, status: "running", message: "ok", lastRun: null };
  if (p.endsWith("/storage/email")) return { member: true, warnEmail: true, criticalEmail: true, lockedEmail: true };
  if (p === "/api/v1/sources") return sources;
  if (p === "/api/v1/destinations") return destinations;
  if (p === "/api/v1/subscriptions") return subscriptions;
  if (p === "/api/v1/dlq") return { items: dead, next: null, prev: null };
  if (p === "/api/v1/deliveries") return { items: dead, next: null, prev: null };
  if (p === "/api/v1/events") return { events, nextCursor: null };
  if (p === "/api/v1/flow/executions") return { items: execs, nextCursor: null };
  if (p === "/api/v1/audit-logs") return { items: audit, next: null, prev: null, nextBefore: null };
  if (p === "/api/v1/audit-logs/facets") return { actions: ["destination.update"], entityTypes: ["destination"], actors: [audit[0].actor] };
  if (p.endsWith("/api-keys") || p.endsWith("/keys")) return apiKeys;
  if (p === "/api/v1/alerts") return { items: alerts, next: null, prev: null, asOf: iso(0) };
  if (p === "/api/v1/alerts/summary") return { openBySeverity: { critical: 1, warning: 2, info: 1 }, unacked: 3, perProject: [] };
  if (p === "/api/v1/overview") return { totalSources: 8, totalDestinations: 6, totalEvents: 1200, totalDeliveries: 3000, deadDeliveries: 8, successRate: 0.98 };
  if (p === "/api/v1/stats/timeseries") return Array.from({ length: 24 }, (_, i) => ({ bucket: iso((24 - i) * 60), events: 10 + i, succeeded: 9 + i, retrying: 1, dead: 0 }));
  if (p === "/api/v1/badges") return { events: 0, deliveries: 0, dlq: 0 };
  if (p === "/api/v1/catalog/event-types") return { wildcards: ["*"], types: ["payment.succeeded", "payment.failed", "repo.push"] };
  if (p === "/api/v1/connectors") return [];
  if (p === "/api/v1/me/alert-preferences") return { email: true, telegram: false };
  if (p === "/api/v1/raw-events/orphans") return { items: [], total: 0 };
  if (p.endsWith("/inspect")) return [];
  if (p.startsWith("/api/v1/insights") || p.includes("/insights")) return [];
  if (p.includes("/traffic")) return { range: "24h", bucketSeconds: 3600, buckets: [], topIps: [], insight: { level: "ok", code: "ok", facts: {} }, blockedNow: [] };
  if (p === "/auth/socket-ticket") return { ticket: "t" };
  if (p.startsWith("/api/v1/events/")) return { ...events[0], rawEvent: null };
  if (method !== "GET") return {};
  return null; // chưa giả → báo ra để bổ sung
}

const PAGES = [
  "/dashboard", "/dashboard/sources", "/dashboard/destinations", "/dashboard/subscriptions", "/dashboard/events",
  "/dashboard/deliveries", "/dashboard/dlq", "/dashboard/audit", "/dashboard/api-keys", "/dashboard/projects",
  "/dashboard/storage", "/dashboard/alerts", "/dashboard/flow", "/dashboard/settings", "/dashboard/playground",
  `/dashboard/events/${events[0].id}`, "/alerts", "/settings", "/projects", "/dashboard/ui-kit", "/shop", "/shop/settings",
].filter((p) => !ONLY || ONLY.some((o) => p.includes(o)));

/** Chạy trong trang: liệt kê mọi chỗ tràn ngang. Ngoại lệ có chủ đích gắn `data-hscroll-ok` (khối code/JSON/log/canvas). */
function measure() {
  const out = [];
  const de = document.documentElement;
  // Đo cuộn ngang THẬT (kéo thử), không chỉ scrollWidth: storefront đặt body{overflow-x:hidden} nên scrollWidth lớn hơn vẫn không cuộn được.
  scrollTo(100000, 0);
  const canScrollX = scrollX > 0;
  scrollTo(0, 0);
  if (canScrollX) {
    out.push(`PAGE scrollWidth ${de.scrollWidth} > ${innerWidth}`);
    const wide = [...document.body.querySelectorAll("*")].filter((e) => e.getBoundingClientRect().right > innerWidth + 1 && getComputedStyle(e).position !== "fixed").slice(0, 4);
    for (const e of wide) out.push(`  wide: ${e.tagName.toLowerCase()}.${String(e.className).split(/\s+/).slice(0, 4).join(".")} right=${Math.round(e.getBoundingClientRect().right)}`);
  }
  const descr = (el) => `${el.tagName.toLowerCase()}${el.getAttribute("data-slot") ? `[${el.getAttribute("data-slot")}]` : ""}${typeof el.className === "string" && el.className ? `.${el.className.split(/\s+/).slice(0, 3).join(".")}` : ""}`;
  for (const el of document.querySelectorAll("*")) {
    if (el.closest("[data-hscroll-ok],.react-flow,nextjs-portal,pre,code,[data-sonner-toaster]")) continue;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0) continue;
    const scrolls = /(auto|scroll)/.test(cs.overflowX) && el.scrollWidth > el.clientWidth + 1;
    if (scrolls) out.push(`SCROLL ${descr(el)} sw=${el.scrollWidth} cw=${el.clientWidth}`);
    const tag = el.tagName;
    if (tag === "TABLE" || el.getAttribute("role") === "dialog" || el.getAttribute("data-slot") === "sheet-content") {
      if (r.right > innerWidth + 1 || r.left < -1) out.push(`CLIP ${descr(el)} rect=${Math.round(r.left)}..${Math.round(r.right)} vw=${innerWidth}`);
      if (el.scrollWidth > el.clientWidth + 1 && tag !== "TABLE") out.push(`OVERLAY-SW ${descr(el)} sw=${el.scrollWidth} cw=${el.clientWidth}`);
    }
    if (tag === "TABLE") {
      const wrap = el.parentElement;
      if (wrap && el.getBoundingClientRect().width > wrap.clientWidth + 1) out.push(`TABLE-WIDER ${Math.round(r.width)} > wrap ${wrap.clientWidth} cols=[${[...el.querySelectorAll("th")].map((h) => h.innerText.trim().slice(0, 14) + ":" + Math.round(h.getBoundingClientRect().width)).join(" | ")}]`);
    }
  }
  // Phần tử vượt mép phải của overlay (thân modal chỉ cuộn dọc nên phần vượt sẽ bị cắt im lặng).
  for (const root of document.querySelectorAll('[role=dialog],[role=alertdialog],[data-slot=sheet-content]')) {
    const rr = root.getBoundingClientRect();
    let n = 0;
    for (const el of root.querySelectorAll("*")) {
      if (n >= 3) break;
      if (el.closest("[data-hscroll-ok],pre,code,svg,[aria-hidden=true]")) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.right > rr.right + 1 || r.left < rr.left - 1) {
        out.push(`OUT-OF-OVERLAY ${descr(el)} right=${Math.round(r.right)} overlayRight=${Math.round(rr.right)} text="${(el.innerText || "").trim().slice(0, 30)}"`);
        n++;
      }
    }
  }
  return out;
}

const opened = {};
const browser = await chromium.launch({ channel: "chrome", headless: true });
const unknown = new Set();
const problems = [];
let checked = 0;

for (const vw of VIEWPORTS) {
  const ctx = await browser.newContext({ viewport: { width: vw, height: 950 }, colorScheme: "light" });
  await ctx.addInitScript(() => {
    const s = document.createElement("style");
    s.textContent = "nextjs-portal{display:none!important}";
    document.addEventListener("DOMContentLoaded", () => document.head.appendChild(s));
  });
  await ctx.route(/\/(api|auth)\//, (route) => {
    const u = new URL(route.request().url());
    const body = mock(route.request().method(), u.pathname + u.search);
    if (body === null) {
      unknown.add(`${route.request().method()} ${u.pathname}`);
      return route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
    }
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e).slice(0, 160)));
  for (const path of PAGES) {
    await page.goto(`${WEB}${path}`, { waitUntil: "domcontentloaded", timeout: 180_000 });
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
    await page.waitForTimeout(600);
    const tag = `${vw}px ${path}`;
    const found = await page.evaluate(measure);
    checked++;
    for (const f of found) problems.push(`${tag} :: ${f}`);
    if ((found.length || process.env.SHOTS_ALL) && SHOTS) await page.screenshot({ path: join(SHOTS, `${vw}-${path.replace(/\W+/g, "_")}.png`) });

    if (OVERLAYS) {
      // Mở lần lượt các nút ngoài bảng (Tạo…, Kết nối…, hàng thao tác) → nếu hiện dialog/sheet thì đo rồi đóng.
      const SEL = path === "/dashboard" ? "header button:visible, main button:visible" : "main button:visible, [data-slot=table-body] button:visible";
      const n = await page.locator(SEL).count();
      for (let i = 0; i < Math.min(n, 18); i++) {
        const btn = page.locator(SEL).nth(i);
        const label = ((await btn.innerText().catch(() => "")) || (await btn.getAttribute("aria-label").catch(() => "")) || `#${i}`).trim().slice(0, 30);
        await btn.click({ timeout: 1500, trial: false }).catch(() => {});
        const overlay = page.locator("[role=dialog]:visible, [data-slot=sheet-content]:visible").first();
        if (await overlay.count()) {
          await page.waitForTimeout(450);
          opened[path] = (opened[path] ?? 0) + 1;
          const o = await page.evaluate(measure);
          checked++;
          for (const f of o) problems.push(`${tag} [overlay "${label}"] :: ${f}`);
          if (o.length && SHOTS) await page.screenshot({ path: join(SHOTS, `${vw}-${path.replace(/\W+/g, "_")}-ov${i}.png`) });
          await page.keyboard.press("Escape");
          await page.waitForTimeout(250);
        } else if (page.url() !== `${WEB}${path}`) {
          await page.goto(`${WEB}${path}`, { waitUntil: "domcontentloaded", timeout: 180_000 });
          await page.waitForTimeout(500);
        }
      }
      // Bấm thân hàng đầu tiên (mở sheet chi tiết sự kiện / cảnh báo…).
      const row = page.locator("[data-slot=table-body] [data-slot=table-row]").first();
      if (await row.count()) {
        await row.click({ position: { x: 20, y: 10 }, timeout: 1500 }).catch(() => {});
        if (await page.locator("[role=dialog]:visible, [data-slot=sheet-content]:visible").count()) {
          await page.waitForTimeout(600);
          opened[path] = (opened[path] ?? 0) + 1;
          const o = await page.evaluate(measure);
          checked++;
          for (const f of o) problems.push(`${tag} [overlay "hàng đầu"] :: ${f}`);
          if (o.length && SHOTS) await page.screenshot({ path: join(SHOTS, `${vw}-${path.replace(/W+/g, "_")}-row.png`) });
          await page.keyboard.press("Escape");
        }
      }
    }
  }
  if (errs.length) problems.push(`${vw}px pageerror: ${[...new Set(errs)].slice(0, 5).join(" | ")}`);
  await ctx.close();
}
await browser.close();
if (unknown.size) console.log("API chưa giả (trả []):", [...unknown].join(", "));
console.log("Overlay đã mở được (tổng các viewport):", JSON.stringify(opened));
console.log(`Đã đo ${checked} lượt (trang + overlay) × viewport ${VIEWPORTS.join("/")}`);
const uniq = [...new Set(problems)];
console.log(uniq.length ? `LỖI ${uniq.length}:\n${uniq.join("\n")}` : "ĐẠT: không có cuộn ngang / tràn.");
process.exit(uniq.length ? 1 : 0);
