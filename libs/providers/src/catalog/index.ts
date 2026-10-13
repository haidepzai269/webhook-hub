/**
 * PK9 (E28): barrel PHÍA CLIENT của danh mục — chỉ `identify` + kiểu, không import Node API. Web dùng alias riêng
 * `@hub/providers/catalog` trỏ vào file này, KHÔNG qua barrel `@hub/providers` (barrel đó import `crypto` của Node).
 * Dữ liệu danh mục lấy qua `GET /api/v1/catalog`; phía server dùng `./catalog` (`CATALOG`, kiểm lúc khởi động).
 */
export * from './identify';
export * from './types';
