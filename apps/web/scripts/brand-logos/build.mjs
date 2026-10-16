// Tải + làm sạch + sinh lại apps/web/src/components/flow/brand-logos.ts (ADR-236). Xem README.md cùng thư mục.
//
//   node apps/web/scripts/brand-logos/build.mjs [--date YYYY-MM-DD] [--out <file.ts>] [--only id1,id2]
//
// Env: CHROME=<đường dẫn chrome.exe> (tuỳ chọn) — mặc định thử Chrome hệ thống (channel "chrome") rồi tới Chromium của
// Playwright. `--only` chỉ để thử nhanh vài logo: KHÔNG ghi file, in kết quả ra màn hình.

import { chromium } from "@playwright/test";

import { BRANDS, NO_LOGO_NOTES, SIMPLE_ICONS_VERSION } from "./brands.mjs";
import { extractLogo } from "./extract.mjs";
import { generateBrandLogosTs } from "./generate.mjs";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const arg = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const OUT = resolve(arg("--out") ?? join(HERE, "../../src/components/flow/brand-logos.ts"));
const DATE = arg("--date") ?? new Date().toISOString().slice(0, 10);
const ONLY = arg("--only")?.split(",");
const SI_CDN = `https://cdn.jsdelivr.net/npm/simple-icons@${SIMPLE_ICONS_VERSION}`;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36";
const MAX_BYTES = 2_000_000;

async function fetchText(url) {
  const res = await fetch(url, { headers: { "user-agent": UA }, redirect: "follow" });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const text = await res.text();
  if (text.length > MAX_BYTES) throw new Error(`${url}: quá lớn (${text.length} byte)`);
  return text;
}

async function launch() {
  if (process.env.CHROME) return chromium.launch({ executablePath: process.env.CHROME });
  try {
    return await chromium.launch({ channel: "chrome" });
  } catch {
    return chromium.launch();
  }
}

const brands = ONLY ? BRANDS.filter((b) => ONLY.includes(b.id)) : BRANDS;
const dl = mkdtempSync(join(tmpdir(), "brand-logos-"));
console.log(`Tải về: ${dl}`);

// 1. Meta Simple Icons (title + hex) — một lần.
const siMeta = {};
if (brands.some((b) => b.si)) {
  const data = JSON.parse(await fetchText(`${SI_CDN}/data/simple-icons.json`));
  const icons = Array.isArray(data) ? data : data.icons;
  const norm = (t) => t.toLowerCase().replace(/[^a-z0-9]/g, "");
  for (const b of brands.filter((x) => x.si)) {
    const i = icons.find((x) => x.slug === b.si) ?? icons.find((x) => !x.slug && norm(x.title) === b.si);
    if (!i) throw new Error(`Simple Icons ${SIMPLE_ICONS_VERSION} không có slug "${b.si}"`);
    if (i.license)
      console.warn(`  ! ${b.id}: Simple Icons ghi giấy phép riêng ${JSON.stringify(i.license)} — kiểm trước khi dùng`);
    siMeta[b.id] = { title: i.title, hex: i.hex };
  }
}

// 2. Tải SVG từng logo.
const items = [];
for (const b of brands) {
  let svgText;
  if (b.si) svgText = await fetchText(`${SI_CDN}/icons/${b.si}.svg`);
  else if (b.html) {
    const html = await fetchText(b.url);
    const m = html.match(new RegExp(b.html.pattern));
    if (!m) throw new Error(`${b.id}: không thấy <svg> khớp pattern trong ${b.url} — trang đã đổi, sửa brands.mjs`);
    svgText = m[0].replace(/\swidth="100%"/, "");
  } else svgText = await fetchText(b.url);
  writeFileSync(join(dl, `${b.id}.svg`), svgText);
  items.push({ id: b.id, svgText, region: b.region, exclude: b.exclude, keepViewBox: b.si ? "0 0 24 24" : undefined });
}

// 3. Làm sạch + trích trong trang trống, chặn mọi request mạng của trang.
const browser = await launch();
const ctx = await browser.newContext({ javaScriptEnabled: true });
await ctx.route("**/*", (r) => r.abort());
const page = await ctx.newPage();
await page.setContent("<!doctype html><html><body></body></html>");
const extracted = {};
for (const it of items) {
  extracted[it.id] = await extractLogo(page, it);
  console.log(
    `  ${it.id.padEnd(13)} ${extracted[it.id].viewBox.padEnd(26)} ${extracted[it.id].paths.length} path  ${extracted[it.id].rawFills.join(" | ")}`,
  );
}
await browser.close();

// 4. Sinh file.
if (ONLY) {
  console.log("--only: không ghi file.");
} else {
  const ts = generateBrandLogosTs({
    brands,
    extracted,
    siMeta,
    siVersion: SIMPLE_ICONS_VERSION,
    date: DATE,
    noLogoNotes: NO_LOGO_NOTES,
  });
  writeFileSync(OUT, ts);
  console.log(`Đã ghi ${OUT} (${Buffer.byteLength(ts)} byte). Tiếp: cd apps/web && npx biome format --write ${OUT}`);
}
