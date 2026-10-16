// Sinh nội dung apps/web/src/components/flow/brand-logos.ts từ kết quả extract (ADR-236). Hàm thuần — không I/O.

/**
 * @param {object} a
 * @param {Array<object>} a.brands        BRANDS (brands.mjs)
 * @param {Record<string, {viewBox: string, paths: object[]}>} a.extracted  kết quả extract theo id
 * @param {Record<string, {title: string, hex: string}>} a.siMeta  meta Simple Icons theo id (chỉ mục `si`)
 * @param {string} a.siVersion
 * @param {string} a.date                 ngày tải (YYYY-MM-DD)
 * @param {string[]} a.noLogoNotes
 */
export function generateBrandLogosTs({ brands, extracted, siMeta, siVersion, date, noLogoNotes }) {
  const lines = [];
  const header = [];
  for (const b of brands) {
    const e = extracted[b.id];
    if (!e) throw new Error(`thiếu kết quả extract của ${b.id}`);
    const si = b.si ? siMeta[b.id] : null;
    if (b.si && !si) throw new Error(`thiếu meta Simple Icons của ${b.id}`);
    const title = si ? si.title : b.title;
    const mono = si ? si.hex : b.mono;
    const paths = e.paths.map((p) => {
      const o = { d: p.d };
      if (!mono && p.fill) o.fill = p.fill;
      if (p.fillRule) o.fillRule = p.fillRule;
      if (p.transform) o.transform = p.transform;
      return o;
    });
    const source = si ? `simple-icons@${siVersion} icons/${b.si}.svg` : b.url;
    const license = si ? `CC0-1.0 (Simple Icons ${siVersion})` : "trademark";
    header.push(
      ` *  ${b.id.padEnd(13)} ${title.padEnd(13)} ${
        si
          ? `Simple Icons ${siVersion} slug "${b.si}" #${si.hex}`
          : `${b.url} (tải ${date})${b.note ? ` — ${b.note}` : ""}`
      }`,
    );
    lines.push(
      `  ${JSON.stringify(b.id)}: {\n    title: ${JSON.stringify(title)},\n    viewBox: ${JSON.stringify(e.viewBox)},\n` +
        (mono ? `    hex: ${JSON.stringify(`#${mono.toUpperCase()}`)},\n` : "") +
        `    source: ${JSON.stringify(source)},\n    license: ${JSON.stringify(license)},\n` +
        `    paths: [\n${paths.map((p) => `      ${JSON.stringify(p)},`).join("\n")}\n    ],\n  },`,
    );
  }

  return `/**
 * Logo thương hiệu THẬT của provider/đích (ADR-236). File SINH TỰ ĐỘNG từ SVG đã tải — sửa bằng cách tải lại + sinh lại,
 * không sửa tay từng path. Cách sinh lại: apps/web/scripts/brand-logos/README.md.
 *
 * An toàn: SVG tải về là dữ liệu không tin cậy. Mỗi file được dựng trong trình duyệt headless SAU KHI bỏ script/
 * foreignObject/image/use/a, thuộc tính on…, href; chỉ trích ra: \`d\` (kiểm regex chỉ gồm lệnh path + số), \`fill\` (#hex), \`fillRule\`
 * (enum), \`transform\` (ma trận số). Không còn thuộc tính hay phần tử nào khác (test: brand-logos.spec.ts).
 *
 * Nguồn + giấy phép (tải ${date}):
 *  - Simple Icons (https://simpleicons.org) bản npm simple-icons@${siVersion} — CC0-1.0. Logo vẫn là nhãn hiệu của chủ sở hữu;
 *    dùng để nhận diện, theo DISCLAIMER của Simple Icons.
 *  - Logo chính thức (trang/brand kit của provider): nhãn hiệu thuộc chủ sở hữu, dùng để nhận diện; không ngụ ý liên kết.
 *
 *  id            Tên           Nguồn
${header.join("\n")}
 *
 * Không có logo dùng được -> fallback của ProviderIcon (chữ tắt theo tên nguồn, hoặc icon Lucide chung):
${noLogoNotes.map((n) => ` *  - ${n}`).join("\n")}
 */

export interface BrandPath {
  d: string;
  /** Có ở logo nhiều màu. Logo đơn sắc (có \`hex\`) không có fill trên path — tô theo theme ở BrandLogo. */
  fill?: string;
  fillRule?: "evenodd";
  transform?: string;
}

export interface BrandLogo {
  title: string;
  viewBox: string;
  /** Màu thương hiệu của logo đơn sắc. Không có = logo nhiều màu (fill riêng từng path). */
  hex?: string;
  source: string;
  license: string;
  paths: BrandPath[];
}

export const BRAND_LOGOS: Record<string, BrandLogo> = {
${lines.join("\n")}
};

/** Nền sáng/tối của console (globals.css: --background/--card ở hai theme). */
const LIGHT_BG = "#FFFFFF";
const DARK_BG = "#171717";
/**
 * Dưới ngưỡng tương phản này thì logo đơn sắc chuyển sang màu chữ của theme. 2:1 (không phải 3:1 của WCAG cho đồ hoạ):
 * logo luôn đi kèm nhãn chữ, và 3:1 sẽ biến Telegram/GitLab/Shopify thành đen ở nền sáng — mất màu nhận diện.
 */
const MIN_CONTRAST = 2;
const FOREGROUND = "var(--foreground)";

function luminance(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}

export function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

/** Màu tô logo đơn sắc ở theme sáng/tối: màu thương hiệu nếu đủ tương phản, không thì màu chữ (vd GitHub đen -> trắng ở dark). */
export function monoFill(hex: string): { light: string; dark: string } {
  return {
    light: contrast(hex, LIGHT_BG) >= MIN_CONTRAST ? hex : FOREGROUND,
    dark: contrast(hex, DARK_BG) >= MIN_CONTRAST ? hex : FOREGROUND,
  };
}

/** Logo theo id provider/đích (không phân biệt hoa thường). Không biết -> null (nơi gọi dùng icon chung). */
export function brandLogo(id: string | null | undefined): BrandLogo | null {
  if (!id) return null;
  return BRAND_LOGOS[id.toLowerCase()] ?? null;
}
`;
}
