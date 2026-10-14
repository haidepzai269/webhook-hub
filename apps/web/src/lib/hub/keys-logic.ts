// SK1 (SPEC-shop-ket-noi-project §3): logic THUẦN của trang Project + API key — không React, test bằng jest gốc.
// Chữ hiển thị trả về dạng khoá i18n hoặc nhận `t` (import tương đối: jest gốc không có alias `@/`).
import type { MessageKey, TranslateFn } from "../i18n/dictionary";

/** Scope cấp được cho API key (máy). Scope của NGƯỜI (manage:keys…) không bao giờ có ở đây (UA19). */
export const KEY_SCOPES = [
  { scope: "manage:endpoints", hintKey: "page.api-keys.scope.manage-endpoints" },
  { scope: "read:events", hintKey: "page.api-keys.scope.read-events" },
  { scope: "publish:events", hintKey: "page.api-keys.scope.publish-events" },
  { scope: "manage:sources", hintKey: "page.api-keys.scope.manage-sources" },
  // PK5 (E4, ADR-206): polling trả cả sự kiện chưa xác thực — chỉ owner cấp được (server 403 với người khác).
  { scope: "read:unverified", hintKey: "page.api-keys.scope.read-unverified" },
] as const satisfies readonly { scope: string; hintKey: MessageKey }[];

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

/** Khoá i18n của trạng thái key ("Đã thu hồi" / "Đang dùng"). */
export const keyStatus = (k: Pick<ApiKeySummary, "revokedAt">): MessageKey =>
  k.revokedAt ? "page.api-keys.status.revoked" : "page.api-keys.status.active";

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

/** Lỗi tạo project -> câu theo ngôn ngữ đang chọn (409 slug trùng, 422 slug sai, 403 trần/xác minh). `fallback` = câu của server. */
export function projectCreateError(status: number, body: unknown, fallback: string, t: TranslateFn): string {
  const code = (body as { error?: unknown } | null)?.error;
  if (status === 409 || code === "slug_taken") return t("page.projects.error.slug-taken");
  if (status === 422) return t("page.projects.error.slug-invalid");
  if (code === "project_limit") return fallback || t("page.projects.error.limit");
  return fallback || t("page.projects.error.http", { status });
}
