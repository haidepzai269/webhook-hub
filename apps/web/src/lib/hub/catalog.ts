// PK9 (SPEC-provider-khac §8.2, E28, ADR-208): danh mục provider phía console. `identify()` chạy NGAY Ở TRÌNH DUYỆT trên
// dữ liệu của `GET /api/v1/catalog` — mẫu dev dán (có thể chứa secret, PII) không bao giờ rời máy (①②③).
// Import qua alias riêng `@hub/providers/catalog` (chỉ identify + kiểu), KHÔNG qua barrel `@hub/providers` (kéo `crypto`).
// Form "Nhà cung cấp khác" dùng các hàm này ở PK7.
import { type CatalogEntry, type IdentifyInput, type IdentifyResult, identify } from "@hub/providers/catalog";

export type { CatalogEntry, IdentifyInput, IdentifyResult };

/** Khuôn phản hồi của `GET /api/v1/catalog`. */
export interface CatalogResponse {
  entries: CatalogEntry[];
}

/** Nhận diện cục bộ — không gọi mạng. */
export function identifyLocally(input: IdentifyInput, catalog: CatalogResponse | undefined): IdentifyResult | null {
  if (!catalog) return null;
  return identify(input, catalog.entries);
}
