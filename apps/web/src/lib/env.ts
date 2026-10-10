/**
 * URL các backend — lấy từ env build-time (Next inline `NEXT_PUBLIC_*` vào bundle).
 * Fallback localhost CHỈ cho dev local; deployed (Vercel) bắt buộc đặt biến (DEPLOYMENT §9).
 */
export const HUB_API_URL = (process.env.NEXT_PUBLIC_HUB_API_URL ?? "http://localhost:4000").replace(/\/$/, "");
export const SHOP_API_URL = (process.env.NEXT_PUBLIC_SHOP_API_URL ?? "http://localhost:4001").replace(/\/$/, "");

/** ADR-027: giả lập thanh toán chỉ bật ở LOCAL. Không bao giờ bật ở deployed. */
export const DEMO_SIMULATE = process.env.NEXT_PUBLIC_DEMO_SIMULATE === "true";
