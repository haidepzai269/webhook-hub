#!/bin/sh
# S1-5 (ADR-046): Shop có user DB riêng, CHỈ thấy schema `shop`. Không cấp gì trên schema `hub`.
#
# Chạy tự động bởi image postgres khi volume RỖNG (/docker-entrypoint-initdb.d), với quyền
# POSTGRES_USER (hub_user — cũng là role chạy migration). Volume đã có dữ liệu thì chạy tay:
#   docker compose exec -T postgres sh /docker-entrypoint-initdb.d/02-shop-user.sh
# Script idempotent: chạy lại nhiều lần không sao.
#
# Dạng .sh (không phải .sql) vì mật khẩu lấy từ env SHOP_DB_PASSWORD — .sql không đọc được env.
set -e

psql -v ON_ERROR_STOP=1 \
  --username "${POSTGRES_USER:-hub_user}" \
  --dbname "${POSTGRES_DB:-webhook_hub}" \
  -v shop_password="${SHOP_DB_PASSWORD:-shop_password}" \
  -v db_name="${POSTGRES_DB:-webhook_hub}" \
  -v migrator="${POSTGRES_USER:-hub_user}" <<'SQL'
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'shop_user') THEN
    CREATE ROLE shop_user LOGIN;
  END IF;
END
$$;
ALTER ROLE shop_user WITH LOGIN PASSWORD :'shop_password';

-- Schema `shop` có thể chưa tồn tại (migration của hub-api tạo bảng SAU script này).
CREATE SCHEMA IF NOT EXISTS shop;

GRANT CONNECT ON DATABASE :"db_name" TO shop_user;
GRANT USAGE ON SCHEMA shop TO shop_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA shop TO shop_user;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA shop TO shop_user;

-- Bảng shop.* do migration (chạy bằng role migrator = hub_user) tạo SAU -> default privileges
-- phải khai báo CHO ĐÚNG role đó, nếu không bảng mới sinh ra shop_user không đọc được.
ALTER DEFAULT PRIVILEGES FOR ROLE :"migrator" IN SCHEMA shop GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO shop_user;
ALTER DEFAULT PRIVILEGES FOR ROLE :"migrator" IN SCHEMA shop GRANT USAGE, SELECT ON SEQUENCES TO shop_user;

-- Cố ý KHÔNG có dòng GRANT nào trên schema hub.
SQL
echo "==> shop_user sẵn sàng (chỉ schema shop)"
