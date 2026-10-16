// Danh sách logo thương hiệu của console (ADR-236). Thứ tự ở đây = thứ tự trong brand-logos.ts.
// Thêm logo: thêm MỘT mục vào BRANDS rồi chạy `node apps/web/scripts/brand-logos/build.mjs` (xem README.md).
//
// Khuôn một mục:
//   { id, si: "<slug>" }                         — lấy từ Simple Icons (title + hex lấy từ data của Simple Icons)
//   { id, title, url, note?, region?, exclude?, mono? }   — SVG chính thức
//   { id, title, url, html: { pattern }, ... }   — SVG nằm INLINE trong trang HTML (regex bắt nguyên thẻ <svg>…</svg>)
// region: [x0, y0, x1, y1] theo toạ độ viewBox gốc — chỉ giữ phần tử có TÂM nằm trong vùng (cắt biểu tượng, bỏ chữ).
// exclude: chỉ số phần tử (path/polygon/rect/circle… ngoài <defs>, đếm từ 0) cần bỏ.
// mono: "RRGGBB" — logo đơn sắc: bỏ fill gốc, tô màu này (đổi theo theme ở BrandLogo).

export const SIMPLE_ICONS_VERSION = "16.35.0";

export const BRANDS = [
  // Nguồn có adapter
  {
    id: "payos",
    title: "PayOS",
    url: "https://payos.vn/branding/logo.svg",
    region: [0, 0, 230, 999],
    note: "cắt phần biểu tượng (bỏ chữ payOS)",
  },
  {
    id: "sepay",
    title: "SePay",
    url: "https://sepay.vn/assets/img/logo/logo-sepay-blue.svg",
    region: [0, 0, 350, 999],
    note: "cắt phần biểu tượng (bỏ chữ SePay)",
  },
  { id: "github", si: "github" },
  { id: "stripe", si: "stripe" },
  // Đích
  { id: "discord", si: "discord" },
  { id: "telegram", si: "telegram" },
  // Catalog (libs/providers/src/catalog/entries)
  {
    id: "checkout-com",
    title: "Checkout.com",
    url: "https://www.checkout.com",
    html: { pattern: String.raw`<svg[^>]*viewBox="0 0 276 48"[^>]*class="light-navigation-logo">[\s\S]*?</svg>` },
    region: [0, 0, 48, 48],
    note: "logo SVG trong thanh điều hướng, cắt phần biểu tượng",
  },
  { id: "circleci", si: "circleci" },
  { id: "gitlab", si: "gitlab" },
  { id: "intercom", si: "intercom" },
  { id: "jira", si: "jira" },
  { id: "linear", si: "linear" },
  { id: "paddle", si: "paddle" },
  { id: "postmark", title: "Postmark", url: "https://postmarkapp.com/images/logo-stamp-simple.svg" },
  { id: "razorpay", si: "razorpay" },
  { id: "render", si: "render" },
  { id: "resend", si: "resend" },
  { id: "shopify", si: "shopify" },
  {
    id: "slack",
    title: "Slack",
    url: "https://a.slack-edge.com/9cc0056/marketing/img/nav/logo.svg",
    note: "bỏ clip-path",
  },
  { id: "squarespace", si: "squarespace" },
  { id: "svix", title: "Svix", url: "https://www.svix.com/icon.svg", exclude: [0], note: "bỏ lục giác nền trắng" },
  {
    id: "twilio",
    title: "Twilio",
    url: "https://www.twilio.com/content/dam/twilio-com/core-assets/social/safari-pinned-tab.svg",
    mono: "F22F46",
    note: "mask-icon đơn sắc, tô màu #F22F46 (color của thẻ mask-icon)",
  },
  { id: "twitch", si: "twitch" },
  { id: "vercel", si: "vercel" },
  {
    id: "vnpay",
    title: "VNPAY",
    url: "https://vnpay.vn/assets/images/logo-icon/logo-primary.svg",
    region: [0, 0, 55, 99],
    note: "cắt phần biểu tượng (bỏ chữ + khẩu hiệu)",
  },
];

/** Ghi vào đầu brand-logos.ts — thương hiệu đã thử mà không có logo dùng được. */
export const NO_LOGO_NOTES = [
  "heroku, momo, pipedrive, zalopay: trang chính thức chỉ có PNG/ICO hoặc logo chữ, không có biểu tượng SVG sạch.",
  "typeform, woocommerce: Simple Icons chỉ có logo chữ — không đọc được ở 13–18px.",
  "generic/api: không phải thương hiệu; đích webhook giữ icon Lucide.",
];
