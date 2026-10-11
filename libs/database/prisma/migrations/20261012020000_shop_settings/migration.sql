-- SK2 (SPEC-shop-ket-noi-project §4.1, ADR-155): cài đặt kết nối của Shop (cách B). Chỉ DDL, bảng mới -> không backfill,
-- không cần `SET LOCAL app.rls_system` (gate data-migration-rls chỉ áp cho migration dữ liệu). Không RLS: schema shop
-- không mang tenant_id (bảng nghiệp vụ của apps/shop, không phải của hub — BB-5 áp cho hub.*).

CREATE TABLE "shop"."settings" (
    "id" SMALLINT NOT NULL DEFAULT 1,
    -- AES-256-GCM bằng SHOP_SETTINGS_KEY. KHÔNG có cột plaintext cho các giá trị này.
    "hub_connection_url_encrypted" TEXT,
    "payment_source_keys" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "payos_client_id_encrypted" TEXT,
    "payos_api_key_encrypted" TEXT,
    "payos_checksum_key_encrypted" TEXT,
    "bank_code" VARCHAR(512),
    "bank_account" VARCHAR(512),
    "bank_account_name" VARCHAR(512),
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "settings_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "settings_single_row" CHECK ("id" = 1)
);

-- Role runtime của Shop (`shop_user`, ADR-046/125) đã có DEFAULT PRIVILEGES cho bảng mới do migrator tạo; GRANT tường minh
-- cho chắc (idempotent). Role chưa tồn tại (CI, máy mới) -> bỏ qua. Không câu lệnh nào cần superuser (Neon owner chạy được).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'shop_user') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "shop"."settings" TO shop_user;
  END IF;
END
$$;
