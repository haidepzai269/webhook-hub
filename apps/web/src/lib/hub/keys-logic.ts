// SK1 (SPEC-shop-ket-noi-project §3): logic THUẦN của trang Project + API key — không React, test bằng jest gốc.

/** Scope cấp được cho API key (máy). Scope của NGƯỜI (manage:keys…) không bao giờ có ở đây (UA19). */
export const KEY_SCOPES = [
  { scope: "manage:endpoints", hint: "tự đăng ký endpoint + subscription (Shop cần)" },
  { scope: "read:events", hint: "đọc sự kiện (polling)" },
  { scope: "publish:events", hint: "phát sự kiện vào hub" },
  { scope: "manage:sources", hint: "xem/tạo source (Shop dùng để liệt kê source khi Kiểm tra)" },
] as const;

/** Mặc định cho Shop: tự đăng ký endpoint + đọc sự kiện (SPEC §3). */
export const SHOP_DEFAULT_SCOPES = ["manage:endpoints", "read:events"];

export interface ApiKeySummary {
  id: string;
  serviceName: string;
  keyPrefix: string;
  scopes: string[];
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export interface CreatedApiKey extends ApiKeySummary {
  key: string;
  connectionString: string;
}

/** Dòng dán vào env của service — CHỈ dựng từ response tạo key (một lần). */
export const envLine = (connectionString: string) => `HUB_URL=${connectionString}`;

/** 4 ký tự cuối của prefix (`hk_test_ab12` -> `ab12`) — đủ để đối chiếu, không lộ key. */
export const prefixTail = (keyPrefix: string) => keyPrefix.slice(-4);

/**
 * Bản an toàn để giữ trong danh sách/cache: bỏ `key` + `connectionString` (key thô chỉ sống trong hộp "Chỉ hiện một
 * lần"; đóng hộp là mất, không bao giờ vào cache của react-query).
 */
export function toSummary(k: CreatedApiKey | ApiKeySummary): ApiKeySummary {
  const { id, serviceName, keyPrefix, scopes, lastUsedAt, revokedAt, createdAt } = k;
  return { id, serviceName, keyPrefix, scopes, lastUsedAt, revokedAt, createdAt };
}

export const keyStatus = (k: Pick<ApiKeySummary, "revokedAt">) => (k.revokedAt ? "Đã thu hồi" : "Đang dùng");

/** slug gợi ý từ tên (bỏ dấu tiếng Việt), khớp ^[a-z0-9][a-z0-9-]{2,62}$ của hub. */
export function slugFromName(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/gi, "d")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);
}

/** Lỗi tạo project -> câu tiếng Việt (409 slug trùng, 422 slug sai, 403 trần/xác minh). */
export function projectCreateError(status: number, body: unknown, fallback: string): string {
  const code = (body as { error?: unknown } | null)?.error;
  if (status === 409 || code === "slug_taken") return "Slug này đã có project khác dùng — chọn slug khác.";
  if (status === 422) return "Slug chỉ gồm chữ thường, số, gạch ngang; 3–63 ký tự (vd: cua-hang-cua-toi).";
  if (code === "project_limit") return fallback || "Đã đạt số project tối đa.";
  return fallback || `Lỗi ${status}`;
}
