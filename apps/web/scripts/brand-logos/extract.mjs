// Làm sạch + trích SVG logo (ADR-236). SVG tải về là dữ liệu KHÔNG tin cậy: dựng trong trang headless trống (không mạng,
// không quyền gì) SAU KHI bỏ script/foreignObject/image/use/a/iframe/animate/set và mọi thuộc tính on* / *href.
// Chỉ xuất: d (kiểm regex lệnh path), fill (#hex, từ computed style), fill-rule (enum), transform (ma trận số đã gộp mọi
// transform của tổ tiên). Không thuộc tính/phần tử nào khác lọt qua.

const D_OK = /^[MmLlHhVvCcSsQqTtAaZz0-9eE.,\s+-]+$/;

/** Chạy TRONG trình duyệt (page.evaluate) — không dùng biến ngoài. */
function pageExtract({ svgText, region, exclude }) {
  const doc = new DOMParser().parseFromString(svgText, "image/svg+xml");
  const root0 = doc.documentElement;
  if (root0.nodeName !== "svg") return { error: "không phải <svg>" };
  for (const bad of root0.querySelectorAll("script,foreignObject,image,use,a,iframe,animate,set")) bad.remove();
  for (const el of [root0, ...root0.querySelectorAll("*")])
    for (const at of [...el.attributes])
      if (/^on/i.test(at.name) || /href$/i.test(at.name)) el.removeAttribute(at.name);
  const root = document.importNode(root0, true);
  root.setAttribute("width", "400");
  root.setAttribute("height", "400");
  document.body.appendChild(root);
  const inv = root.getScreenCTM().inverse();
  const out = [];
  let idx = -1;
  for (const el of root.querySelectorAll("path,polygon,polyline,rect,circle,ellipse")) {
    if (el.closest("defs,clipPath,mask,symbol,pattern,marker")) continue;
    idx++;
    if (exclude?.includes(idx)) continue;
    const cs = getComputedStyle(el);
    if (cs.fill === "none" || cs.display === "none" || cs.visibility === "hidden") continue;
    const m = inv.multiply(el.getScreenCTM());
    const bb = el.getBBox();
    const pts = [
      [bb.x, bb.y],
      [bb.x + bb.width, bb.y],
      [bb.x, bb.y + bb.height],
      [bb.x + bb.width, bb.y + bb.height],
    ].map(([x, y]) => [m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f]);
    const box = {
      x0: Math.min(...pts.map((p) => p[0])),
      y0: Math.min(...pts.map((p) => p[1])),
      x1: Math.max(...pts.map((p) => p[0])),
      y1: Math.max(...pts.map((p) => p[1])),
    };
    if (region) {
      const cx = (box.x0 + box.x1) / 2;
      const cy = (box.y0 + box.y1) / 2;
      if (cx < region[0] || cy < region[1] || cx > region[2] || cy > region[3]) continue;
    }
    const n = el.nodeName;
    const num = (a) => Number.parseFloat(el.getAttribute(a) || "0");
    let d;
    if (n === "path") d = el.getAttribute("d");
    else if (n === "polygon" || n === "polyline") {
      const p = el
        .getAttribute("points")
        .trim()
        .split(/[\s,]+/);
      const pairs = [];
      for (let i = 0; i + 1 < p.length; i += 2) pairs.push(`${p[i]} ${p[i + 1]}`);
      d = `M${pairs.join("L")}${n === "polygon" ? "Z" : ""}`;
    } else if (n === "rect") {
      const [x, y, w, h] = [num("x"), num("y"), num("width"), num("height")];
      d = `M${x} ${y}h${w}v${h}h${-w}Z`;
    } else {
      const [cx, cy] = [num("cx"), num("cy")];
      const rx = n === "circle" ? num("r") : num("rx");
      const ry = n === "circle" ? num("r") : num("ry");
      d = `M${cx - rx} ${cy}a${rx} ${ry} 0 1 0 ${2 * rx} 0a${rx} ${ry} 0 1 0 ${-2 * rx} 0Z`;
    }
    const rgb = cs.fill.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    const fill = rgb
      ? `#${[1, 2, 3]
          .map((i) => Number(rgb[i]).toString(16).padStart(2, "0"))
          .join("")
          .toUpperCase()}`
      : null;
    const r4 = (v) => Math.round(v * 10000) / 10000;
    const ident = Math.abs(m.a - 1) < 1e-9 && Math.abs(m.d - 1) < 1e-9 && !m.b && !m.c && !m.e && !m.f;
    out.push({
      d: d.replace(/\s+/g, " ").trim(),
      fill,
      rawFill: cs.fill,
      fillRule: cs.fillRule === "evenodd" ? "evenodd" : undefined,
      transform: ident ? undefined : `matrix(${[m.a, m.b, m.c, m.d, m.e, m.f].map(r4).join(" ")})`,
      box,
    });
  }
  root.remove();
  return { out };
}

/**
 * @param {import("@playwright/test").Page} page  trang trống (setContent)
 * @param {{id: string, svgText: string, region?: number[], exclude?: number[], keepViewBox?: string}} item
 * @returns {Promise<{viewBox: string, paths: object[], rawFills: string[]}>}
 */
export async function extractLogo(page, item) {
  const r = await page.evaluate(pageExtract, {
    svgText: item.svgText,
    region: item.region ?? null,
    exclude: item.exclude ?? null,
  });
  if (r.error) throw new Error(`${item.id}: ${r.error}`);
  if (r.out.length === 0) throw new Error(`${item.id}: không còn phần tử nào (region/exclude sai?)`);
  for (const e of r.out) {
    if (!D_OK.test(e.d)) throw new Error(`${item.id}: path d chứa ký tự lạ`);
    if (!e.fill && !e.rawFill.startsWith("rgb"))
      console.warn(`  ! ${item.id}: fill "${e.rawFill}" (gradient/url?) -> bỏ fill`);
  }
  const box = r.out.reduce(
    (a, e) => ({
      x0: Math.min(a.x0, e.box.x0),
      y0: Math.min(a.y0, e.box.y0),
      x1: Math.max(a.x1, e.box.x1),
      y1: Math.max(a.y1, e.box.y1),
    }),
    {
      x0: Number.POSITIVE_INFINITY,
      y0: Number.POSITIVE_INFINITY,
      x1: Number.NEGATIVE_INFINITY,
      y1: Number.NEGATIVE_INFINITY,
    },
  );
  // viewBox vuông bao sát phần đã giữ (cắt chữ thì biểu tượng tự lấp đầy ô).
  const w = box.x1 - box.x0;
  const h = box.y1 - box.y0;
  const side = Math.max(w, h);
  const r2 = (v) => Math.round(v * 100) / 100;
  const viewBox =
    item.keepViewBox ?? [r2(box.x0 - (side - w) / 2), r2(box.y0 - (side - h) / 2), r2(side), r2(side)].join(" ");
  return {
    viewBox,
    paths: r.out.map(({ box: _b, rawFill: _r, ...e }) => e),
    rawFills: [...new Set(r.out.map((e) => e.rawFill))],
  };
}
