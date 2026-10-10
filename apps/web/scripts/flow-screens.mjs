// Chụp màn hình Event Flow (SPEC-event-flow-ui §8) bằng Playwright headless + Chrome hệ thống.
// node apps/web/scripts/flow-screens.mjs <outDir> [okEventId] [failEventId]
// Env: WEB (mặc định http://localhost:3100), HUB (http://localhost:4100), THEMES (light,dark), ONLY (v1,v2,v3).
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { chromium } from "@playwright/test";

const WEB = process.env.WEB ?? "http://localhost:3100";
const HUB = process.env.HUB ?? "http://localhost:4100";
const [outDir = "screens", okId, failId] = process.argv.slice(2);
const themes = (process.env.THEMES ?? "light,dark").split(",");
const only = (process.env.ONLY ?? "v1,v2,v3").split(",");
mkdirSync(outDir, { recursive: true });

const login = await fetch(`${HUB}/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: "admin", password: process.env.ADMIN_PASSWORD ?? "admin123" }),
}).then((r) => r.json());
const token = login.accessToken;
if (!token) throw new Error("Không đăng nhập được hub-api");

const browser = await chromium.launch({ channel: "chrome", headless: true });
for (const theme of themes) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, colorScheme: theme });
  await ctx.addCookies([{ name: "theme_mode", value: theme, url: WEB }]);
  await ctx.addInitScript((t) => localStorage.setItem("hub_jwt_token", t), token);
  // F7: project đang xem (V2/V3/V1 gửi ?projectId=). Trống = project của JWT (default).
  const projectId = process.env.PROJECT_ID ?? "";
  await ctx.addInitScript((p) => (p ? localStorage.setItem("flow:projectId", p) : localStorage.removeItem("flow:projectId")), projectId);
  const page = await ctx.newPage();
  // Ẩn nút chỉ báo của next dev (chỉ có ở dev, không thuộc giao diện).
  await ctx.addInitScript(() => {
    const s = document.createElement("style");
    s.textContent = "nextjs-portal{display:none!important}";
    document.addEventListener("DOMContentLoaded", () => document.head.appendChild(s));
  });
  const shot = async (name, url, opts = {}) => {
    await page.goto(`${WEB}${url}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(opts.wait ?? 2500);
    const file = join(outDir, `${name}${process.env.NAME_SUFFIX ?? ""}-${theme}.png`);
    await page.screenshot({ path: file, fullPage: Boolean(opts.full) });
    console.log("đã chụp", file);
  };
  if (only.includes("v3")) await shot("v3-flow-map", "/dashboard/flow", { wait: 3500 });
  if (only.includes("v2")) await shot("v2-executions", "/dashboard/events");
  if (only.includes("v1") && okId) await shot("v1-journey-ok", `/dashboard/events/${okId}`, { full: true });
  if (only.includes("v1") && failId) await shot("v1-journey-fail", `/dashboard/events/${failId}`, { full: true });
  await ctx.close();
}
await browser.close();
