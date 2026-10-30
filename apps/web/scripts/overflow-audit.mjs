// Kiểm tra KHÔNG CÓ cuộn ngang ở mọi trang console + overlay (bảng, dialog, sheet) bằng Playwright + Chrome hệ thống.
//   node apps/web/scripts/overflow-audit.mjs            (cần `next dev -p 3000` đang chạy; KHÔNG cần hub-api — API được giả)
// Env: WEB (mặc định http://localhost:3000), VIEWPORTS (360,768,...), PAGES (lọc theo đường dẫn, phân cách dấu phẩy),
//      OVERLAYS=0 để bỏ qua bước mở overlay, SHOTS=<thư mục> để chụp ảnh các ca lỗi.
// Dữ liệu giả CỐ Ý dài (tên, URL, id, ghi chú) để lòi lỗi tràn. Không gọi dịch vụ thật, không dùng secret.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { chromium } from "@playwright/test";

const WEB = process.env.WEB ?? "http://localhost:3000";
const VIEWPORTS = (process.env.VIEWPORTS ?? "360,768,1024,1280,1440,1920").split(",").map(Number);
const ONLY = process.env.PAGES ? process.env.PAGES.split(",") : null;
const OVERLAYS = process.env.OVERLAYS !== "0";
const SHOTS = process.env.SHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

// RESUME=<file.json>: ghi kết quả từng (viewport, trang) ra file; chạy lại thì bỏ qua cặp đã đo (máy sập giữa chừng vẫn đi tiếp được).
const RESUME = process.env.RESUME;
const state = RESUME && existsSync(RESUME) ? JSON.parse(readFileSync(RESUME, "utf8")) : {};
const saveState = () => RESUME && writeFileSync(RESUME, JSON.stringify(state, null, 1));

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
  if (p.endsWith("/inspect")) return Array.from({ length: 6 }, (_, i) => ({ id: uuid(1400 + i), receivedAt: iso(i * 3), status: i % 2 ? "REJECTED" : "ACCEPTED", diagnosis: { ok: i % 2 === 0, reason: i % 2 ? "signature_mismatch" : undefined, expectedHeader: "x-very-long-signature-header-name-for-this-provider-v2", candidateHeaders: ["x-hub-signature-256", "x-signature", "x-webhook-signature-timestamp"], expectedQueryParam: "token_" + "x".repeat(40) } }));
  if (p.endsWith("/connection")) return { sourceId: sources[1].id, provider: "payos", status: "CONNECTED", display: "Webhook " + LONG_URL, ingestUrl: sources[1].ingestUrl, lastError: "Không gọi được PayOS: " + LONG_URL + " trả 503 sau 3 lần thử", fix: "Kiểm tra lại khoá API tại " + LONG_URL, hasCredentials: true, credentialHints: { clientId: "ab12…ef90", apiKey: "••••" + "x".repeat(30), checksumKey: "••••" }, manualDisconnect: null };
  if (p.startsWith("/api/v1/insights") || p.includes("/insights")) return [];
  if (p.includes("/traffic")) return { range: "24h", bucketSeconds: 3600, buckets: Array.from({ length: 12 }, (_, i) => ({ t: iso((12 - i) * 60), ACCEPTED: 10 + i, DUPLICATE: 1, REJECTED: i % 3, RATE_LIMITED: 0, BLOCKED: 0, STORAGE_FULL: 0 })), topIps: Array.from({ length: 6 }, (_, i) => ({ ip: "2001:0db8:85a3:0000:0000:8a2e:0370:733" + i, count: 100 - i, rejected: i, lastSeen: iso(i) })), blockedNow: [{ ip: "2001:0db8:85a3:0000:0000:8a2e:0370:7334", remainingSec: 300 }], insight: { code: "I-traffic", level: "warning", facts: { range: "24h", state: "elevated", total: 100, rejectedPct: 12, dominantIp: "2001:0db8:85a3::8a2e:0370:7334" } } };
  if (false) return { range: "24h", bucketSeconds: 3600, buckets: [], topIps: [], insight: { level: "ok", code: "ok", facts: {} }, blockedNow: [] };
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
  // ---- Nội dung bị CẮT im lặng (overflow-x hidden/clip giấu nội dung mà không có thanh cuộn) ----
  // (B) LỖI: nút/link/ô nhập bị một tổ tiên hidden/clip cắt mất.  (A) cố ý: td/span có text-overflow: ellipsis (kèm title).
  // (C) chữ khác bị cắt không có dấu … → liệt kê để xem.
  const scopeRoots = [...document.querySelectorAll("table,[role=dialog],[role=alertdialog],[data-slot=sheet-content],[data-slot=popover-content]")];
  const CTRL = "button,a[href],input,select,textarea,[role=button],[role=switch],[role=checkbox],[role=tab],[role=menuitem]";
  const seenCtl = new Set();
  for (const root of scopeRoots) {
    for (const c of root.querySelectorAll(CTRL)) {
      if (seenCtl.has(c)) continue;
      seenCtl.add(c);
      if (c.closest(".react-flow,[aria-hidden=true],nextjs-portal,.sr-only,[data-hscroll-ok]")) continue;
      const r = c.getBoundingClientRect();
      if (r.width < 2 || r.height < 2 || getComputedStyle(c).visibility === "hidden") continue;
      for (let a = c.parentElement; a && a !== document.body; a = a.parentElement) {
        const cs = getComputedStyle(a);
        if (!/(hidden|clip)/.test(cs.overflowX)) continue;
        const ar = a.getBoundingClientRect();
        if (r.right > ar.right + 1 || r.left < ar.left - 1) {
          out.push(`CLIPPED-CONTROL ${descr(c)} "${(c.innerText || c.getAttribute("aria-label") || "").trim().slice(0, 24)}" right=${Math.round(r.right)} bởi ${descr(a)} right=${Math.round(ar.right)}`);
          break;
        }
      }
    }
  }
  const seenEl = new Set();
  for (const root of scopeRoots) {
    for (const el of [root, ...root.querySelectorAll("*")]) {
      if (seenEl.has(el)) continue;
      seenEl.add(el);
      if (el.closest(".react-flow,nextjs-portal,pre,code,[data-hscroll-ok],.sr-only") || el.classList.contains("sr-only")) continue;
      const cs = getComputedStyle(el);
      if (!/(hidden|clip)/.test(cs.overflowX) || el.scrollWidth <= el.clientWidth + 1) continue;
      if (cs.textOverflow === "ellipsis") out.push(`NOTE-A ellipsis ${el.tagName.toLowerCase()}`);
      else out.push(`NOTE-C bị cắt không có … ${descr(el)} text="${(el.innerText || "").trim().replace(/\s+/g, " ").slice(0, 50)}"`);
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
const notes = new Map(); // NOTE-A (cố ý) / NOTE-C (xem lại): đếm theo nội dung, không tính là lỗi
const rawLog = []; // mọi thông điệp theo thứ tự — RESUME lưu cái này
const route = (m, print) => {
  const i = m.indexOf(":: NOTE-");
  if (i >= 0) {
    const key = m.slice(i + 3).replace(/\d+/g, "#");
    notes.set(key, (notes.get(key) ?? 0) + 1);
    return;
  }
  if (print && !problems.includes(m)) console.log("  ! " + m.slice(0, 300));
  problems.push(m);
};
const report = (m) => {
  rawLog.push(m);
  route(m, true);
};
/** goto có thử lại — chuyển trang giữa chừng (điều hướng client) hay làm goto bị huỷ. */
const go = async (page, url) => {
  for (let k = 0; k < 4; k++) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 180_000 });
      return;
    } catch (e) {
      if (k === 3) throw e;
      await page.waitForTimeout(1500);
    }
  }
};
let checked = 0;

/**
 * CONVERGE=1: bảng tự co phải HỘI TỤ, không dao động. Dựng chiều cao viewport SÁT chiều cao trang (± vài chục px) ở nhiều bề rộng
 * quanh ngưỡng ẩn cột — ẩn cột làm trang ngắn lại, thanh cuộn dọc biến mất, khung rộng thêm vài px — rồi đếm số lần số cột
 * hiện (th) đổi trong 2,5 giây sau khi tải xong. Hội tụ = ≤ 3 lần đổi và 1 giây cuối không đổi nữa.
 */
async function converge() {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.route(/\/(api|auth)\//, (route) => {
    const u = new URL(route.request().url());
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(mock(route.request().method(), u.pathname + u.search) ?? []) });
  });
  // Ghi số cột (th) mỗi lần đổi, từ lúc tài liệu bắt đầu dựng — bắt cả dao động ngay sau lần vẽ đầu.
  await ctx.addInitScript(() => {
    window.__ths = [];
    const t0 = performance.now();
    const th = () => document.querySelectorAll("[data-slot=table-container] th").length;
    const start = () => new MutationObserver(() => {
      const n = th();
      const last = window.__ths[window.__ths.length - 1];
      if (n > 0 && (!last || last[1] !== n)) window.__ths.push([Math.round(performance.now() - t0), n]);
    }).observe(document.documentElement, { subtree: true, childList: true });
    document.addEventListener("DOMContentLoaded", start);
  });
  const page = await ctx.newPage();
  const target = process.env.PAGES ? `/${process.env.PAGES.split(",")[0]}` : "/dashboard/sources";
  const widths = (process.env.CONVERGE_WIDTHS ?? "1000,1100,1180,1260,1340,1440").split(",").map(Number);
  let worst = 0;
  let bad = 0;
  let runs = 0;
  for (const w of widths) {
    await page.setViewportSize({ width: w, height: 900 });
    await go(page, `${WEB}${target}`);
    await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});
    await page.waitForTimeout(1200);
    // Chiều cao NỘI DUNG thật (đáy phần tử thấp nhất trong main + lề dưới), không phải scrollHeight (≥ viewport nên che mất ca "sát").
    const h = await page.evaluate(() => Math.round(Math.max(...[...document.querySelectorAll("main *")].map((e) => e.getBoundingClientRect().bottom)) + scrollY + 32));
    for (const d of [-40, -20, -8, 0, 8, 20, 40]) {
      await page.setViewportSize({ width: w, height: Math.max(300, h + d) });
      await go(page, `${WEB}${target}`);
      await page.waitForSelector("[data-slot=table-container] th", { timeout: 30_000 }).catch(() => {});
      await page.waitForTimeout(2500);
      const seq = await page.evaluate(() => window.__ths);
      const changes = Math.max(0, seq.length - 1);
      const lastChange = seq.length > 1 ? seq[seq.length - 1][0] - seq[0][0] : 0;
      runs++;
      worst = Math.max(worst, changes);
      const ok = seq.length > 0 && changes <= 3 && lastChange < 1500;
      if (!ok) bad++;
      if (!ok || process.env.VERBOSE) console.log(`  ${ok ? "ok " : "LẶP"} w=${w} h=${h + d} (trang cao ${h}) số lần đổi cột=${changes} chuỗi=${JSON.stringify(seq)}`);
    }
  }
  console.log(`CONVERGE ${target}: ${runs} ca (rộng × cao sát trang), đổi số cột nhiều nhất = ${worst}, ca không hội tụ = ${bad}`);
  await ctx.close();
  await browser.close();
  process.exit(bad ? 1 : 0);
}
if (process.env.CONVERGE) await converge();

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
  // Hydration mismatch do dữ liệu giả có mốc thời gian tương đối (server/client lệch giờ) — không liên quan bố cục, bỏ qua.
  page.on("pageerror", (e) => !/Hydration/.test(String(e)) && errs.push(String(e).slice(0, 160)));
  for (const path of PAGES) {
    const key = `${vw} ${path}`;
    if (state[key]) {
      for (const m of state[key].log) {
        rawLog.push(m);
        route(m, false);
      }
      checked += state[key].checked;
      continue;
    }
    const before = rawLog.length;
    const checkedBefore = checked;
    await go(page, `${WEB}${path}`);
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
    // Ổn định: bảng không được vẽ lại liên tục (vòng lặp co cột chạy mãi sẽ lộ ra ở đây).
    await page.evaluate(() => { window.__mut = 0; const t = document.querySelector("[data-slot=table-container]"); if (t) new MutationObserver((m) => { window.__mut += m.length; }).observe(t, { subtree: true, childList: true, attributes: true }); });
    await page.waitForTimeout(1200);
    const mut = await page.evaluate(() => window.__mut ?? 0);
    const tag = `${vw}px ${path}`;
    const found = await page.evaluate(measure);
    if (mut > 40) found.push(`UNSTABLE ${mut} thay đổi DOM trong bảng sau khi đã tải xong`);
    checked++;
    for (const f of found) report(`${tag} :: ${f}`);
    if ((found.some((x) => !x.startsWith("NOTE-")) || process.env.SHOTS_ALL) && SHOTS) await page.screenshot({ path: join(SHOTS, `${vw}-${path.replace(/\W+/g, "_")}.png`) });

    if (OVERLAYS) {
      // Mở lần lượt các nút ngoài bảng (Tạo…, Kết nối…, hàng thao tác) → nếu hiện dialog/sheet thì đo rồi đóng.
      const SEL = path === "/dashboard" ? "header button:visible, main button:visible" : "main button:not(header button):visible, [data-slot=table-body] button:visible";
      const n = await page.locator(SEL).count();
      for (let i = 0; i < Math.min(n, 18); i++) {
        const btn = page.locator(SEL).nth(i);
        const label = ((await btn.innerText().catch(() => "")) || (await btn.getAttribute("aria-label").catch(() => "")) || `#${i}`).trim().slice(0, 30);
        await btn.click({ timeout: 3000 }).catch((e) => process.env.VERBOSE && console.log(`  click lỗi "${label}": ${String(e.message).split(String.fromCharCode(10)).slice(0, 9).join(" | ").slice(600, 1500)}`));
        await page.waitForTimeout(250);
        const overlay = page.locator("[role=dialog]:visible, [data-slot=sheet-content]:visible").first();
        if (await overlay.count()) {
          await page.waitForTimeout(450);
          opened[path] = (opened[path] ?? 0) + 1;
          if (process.env.VERBOSE) console.log(`  overlay mở: ${tag} "${label}"`);
          const o = await page.evaluate(measure);
          checked++;
          for (const f of o) report(`${tag} [overlay "${label}"] :: ${f}`);
          if (o.some((x) => !x.startsWith("NOTE-")) && SHOTS) await page.screenshot({ path: join(SHOTS, `${vw}-${path.replace(/\W+/g, "_")}-ov${i}.png`) });
          // Tải lại trang cho mỗi overlay: Radix đôi khi để lại pointer-events:none trên body sau khi đóng dialog lồng.
          await go(page, `${WEB}${path}`);
          await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});
          await page.waitForTimeout(700);
        } else if (page.url() !== `${WEB}${path}`) {
          await go(page, `${WEB}${path}`);
          await page.waitForTimeout(500);
        } else {
          await page.keyboard.press("Escape"); // đóng menu/popover (nút "Cột"…) kẻo chặn các lần bấm sau
          await page.waitForTimeout(200);
        }
      }
      // Nút thao tác theo hàng: mỗi nhãn aria-label (bỏ phần tên riêng sau dấu “) bấm nút CUỐI CÙNG cùng nhãn — hàng generic
      // (có "Lắng nghe") thường nằm cuối. Mở ngăn Lắng nghe / Lưu lượng / hộp Kết nối… mà vòng 18 nút đầu không tới.
      const rowLabels = await page.evaluate(() => {
        const m = new Map();
        for (const b of document.querySelectorAll("[data-slot=table-body] button[aria-label]")) m.set((b.getAttribute("aria-label") || "").replace(/[“"].*$/, "").trim(), b);
        return [...m.keys()].filter(Boolean).slice(0, 8);
      });
      for (const pfx of rowLabels) {
        const idx = await page.evaluate((p) => {
          const all = [...document.querySelectorAll("[data-slot=table-body] button[aria-label]")];
          let last = -1;
          all.forEach((b, i) => { if ((b.getAttribute("aria-label") || "").replace(/[“"].*$/, "").trim() === p) last = i; });
          return last;
        }, pfx);
        if (idx < 0) continue;
        await page.locator("[data-slot=table-body] button[aria-label]").nth(idx).click({ timeout: 3000 }).catch(() => {});
        await page.waitForTimeout(250);
        if (await page.locator("[role=dialog]:visible, [data-slot=sheet-content]:visible").count()) {
          await page.waitForTimeout(600);
          opened[path] = (opened[path] ?? 0) + 1;
          if (process.env.VERBOSE) console.log(`  overlay mở (nút hàng): ${tag} "${pfx}"`);
          const o = await page.evaluate(measure);
          checked++;
          for (const f of o) report(`${tag} [overlay hàng "${pfx}"] :: ${f}`);
          if (o.some((x) => !x.startsWith("NOTE-")) && SHOTS) await page.screenshot({ path: join(SHOTS, `${vw}-${path.replace(/\W+/g, "_")}-rb.png`) });
          await go(page, `${WEB}${path}`);
          await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});
          await page.waitForTimeout(700);
        } else {
          await page.keyboard.press("Escape");
          await page.waitForTimeout(200);
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
          for (const f of o) report(`${tag} [overlay "hàng đầu"] :: ${f}`);
          if (o.some((x) => !x.startsWith("NOTE-")) && SHOTS) await page.screenshot({ path: join(SHOTS, `${vw}-${path.replace(/W+/g, "_")}-row.png`) });
          await page.keyboard.press("Escape");
        }
      }
    }
    state[key] = { log: rawLog.slice(before), checked: checked - checkedBefore };
    saveState();
  }
  if (errs.length) report(`${vw}px pageerror: ${[...new Set(errs)].slice(0, 5).join(" | ")}`);
  await ctx.close();
}
await browser.close();
if (unknown.size) console.log("API chưa giả (trả []):", [...unknown].join(", "));
console.log("Overlay đã mở được (tổng các viewport):", JSON.stringify(opened));
console.log(`Đã đo ${checked} lượt (trang + overlay) × viewport ${VIEWPORTS.join("/")}`);
const noteA = [...notes].filter(([k]) => k.startsWith("NOTE-A")).reduce((n, [, v]) => n + v, 0);
console.log(`Ghi chú: ${noteA} ô/phần tử cắt bằng … (cố ý) — NOTE-C (cắt không có …, cần xem):`);
for (const [k, v] of notes) if (k.startsWith("NOTE-C")) console.log(`  ${v}× ${k.slice(0, 220)}`);
const uniq = [...new Set(problems)];
console.log(uniq.length ? `LỖI ${uniq.length}:\n${uniq.join("\n")}` : "ĐẠT: không có cuộn ngang / tràn.");
process.exit(uniq.length ? 1 : 0);
