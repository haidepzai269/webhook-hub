// Ảnh lưới mọi logo trong brand-logos.ts trên nền sáng + tối (kiểm bằng mắt sau khi sinh lại). ADR-236.
//
//   node --experimental-strip-types apps/web/scripts/brand-logos/grid.mjs <out.png>
//
// Env: CHROME như build.mjs. Đọc thẳng brand-logos.ts (Node >= 22.6 với --experimental-strip-types; file không import gì).

import { chromium } from "@playwright/test";

import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const out = resolve(process.argv[2] ?? "brand-logos-grid.png");
const lib = join(HERE, "../../src/components/flow/brand-logos.ts");
const { BRAND_LOGOS, monoFill } = await import(pathToFileURL(lib).href);

const THEME = { light: { bg: "#FFFFFF", fg: "#0A0A0A" }, dark: { bg: "#171717", fg: "#FAFAFA" } };
const svg = (l, size, theme) => {
  const fill = l.hex ? monoFill(l.hex)[theme].replace("var(--foreground)", THEME[theme].fg) : null;
  const paths = l.paths
    .map(
      (p) =>
        `<path d="${p.d}"${p.fill ? ` fill="${p.fill}"` : ""}${p.fillRule ? ` fill-rule="${p.fillRule}"` : ""}${p.transform ? ` transform="${p.transform}"` : ""}/>`,
    )
    .join("");
  return `<svg width="${size}" height="${size}" viewBox="${l.viewBox}"${fill ? ` fill="${fill}"` : ""}>${paths}</svg>`;
};
const panel = (theme) =>
  `<div style="background:${THEME[theme].bg};color:${THEME[theme].fg};padding:16px;display:grid;grid-template-columns:repeat(9,1fr);gap:14px 8px">${Object.entries(
    BRAND_LOGOS,
  )
    .map(
      ([id, l]) =>
        `<div style="display:flex;flex-direction:column;align-items:center;gap:6px;font:11px sans-serif">${svg(l, 32, theme)}<div style="display:flex;gap:6px;align-items:center">${svg(l, 16, theme)}${svg(l, 13, theme)}</div><span>${id}</span></div>`,
    )
    .join("")}</div>`;

const html = join(tmpdir(), `brand-logos-grid-${process.pid}.html`);
writeFileSync(html, `<!doctype html><html><body style="margin:0">${panel("light")}${panel("dark")}</body></html>`);
const browser = process.env.CHROME
  ? await chromium.launch({ executablePath: process.env.CHROME })
  : await chromium.launch({ channel: "chrome" }).catch(() => chromium.launch());
const page = await browser.newPage({ viewport: { width: 1000, height: 400 } });
await page.goto(pathToFileURL(html).href);
await page.screenshot({ path: out, fullPage: true });
await browser.close();
console.log(out);
