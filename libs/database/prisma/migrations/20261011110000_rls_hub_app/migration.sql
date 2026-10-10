-- AU6 (SPEC-auth §5.12, ADR-108): Row-Level Security — "kể cả khi code quên lọc tenant, Postgres vẫn trả 0 dòng".
-- Chạy bằng OWNER (DIRECT_URL). Runtime hub-api / hub-worker dùng role `hub_app`: KHÔNG superuser, KHÔNG BYPASSRLS
-- (superuser luôn bỏ qua RLS, kể cả FORCE — nếu runtime vẫn chạy bằng nó thì RLS chỉ là trang trí).

-- 1. Role runtime. Migration chỉ bảo đảm role TỒN TẠI (NOLOGIN) để GRANT không lỗi; đăng nhập + mật khẩu đặt NGOÀI
--    migration (không bao giờ commit mật khẩu): local = `ensure-app-role` trong docker-entrypoint (HUB_APP_DB_PASSWORD),
--    Neon = tạo role trong console (docs/DEPLOYMENT.md).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hub_app') THEN
    CREATE ROLE hub_app NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA hub TO hub_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA hub TO hub_app;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA hub TO hub_app;
-- Bảng / sequence tạo bởi migration SAU này (cùng owner) tự cấp quyền cho hub_app.
ALTER DEFAULT PRIVILEGES IN SCHEMA hub GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO hub_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA hub GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO hub_app;
-- Bảng lịch sử migration là việc của owner, runtime không được đụng.
DO $$
BEGIN
  IF to_regclass('hub._prisma_migrations') IS NOT NULL THEN
    REVOKE ALL ON TABLE hub._prisma_migrations FROM hub_app;
  END IF;
END
$$;

-- 2. Bảng nghiệp vụ MANG tenant_id: một policy cho mọi bảng. Không set gì -> NULL -> 0 dòng (mặc định ĐÓNG).
--    `app.project_id` / `app.rls_system` đặt bằng set_config(..., true) = LOCAL trong transaction (an toàn với
--    pgbouncer transaction mode của Neon). Chỉ PrismaService.systemTx được đặt app.rls_system (gate + UA30).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['sources', 'events', 'destinations', 'subscriptions', 'deliveries', 'audit_logs'] LOOP
    EXECUTE format('ALTER TABLE hub.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE hub.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON hub.%I', t);
    EXECUTE format($p$
      CREATE POLICY tenant_isolation ON hub.%I
        USING      (tenant_id = NULLIF(current_setting('app.project_id', true), '')::uuid
                    OR current_setting('app.rls_system', true) = 'on')
        WITH CHECK (tenant_id = NULLIF(current_setting('app.project_id', true), '')::uuid
                    OR current_setting('app.rls_system', true) = 'on')$p$, t);
  END LOOP;
END
$$;

-- 3. Bảng con KHÔNG có tenant_id: theo bảng cha. Bảng cha cũng bật RLS nên subquery chỉ thấy cha của ĐÚNG project
--    (cùng setting) — không cần thêm cột, không cần backfill.
ALTER TABLE hub.source_secrets ENABLE ROW LEVEL SECURITY;
ALTER TABLE hub.source_secrets FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON hub.source_secrets;
CREATE POLICY tenant_isolation ON hub.source_secrets
  USING      (EXISTS (SELECT 1 FROM hub.sources s WHERE s.id = source_secrets.source_id))
  WITH CHECK (EXISTS (SELECT 1 FROM hub.sources s WHERE s.id = source_secrets.source_id));

ALTER TABLE hub.raw_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE hub.raw_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON hub.raw_events;
CREATE POLICY tenant_isolation ON hub.raw_events
  USING      (EXISTS (SELECT 1 FROM hub.sources s WHERE s.id = raw_events.source_id))
  WITH CHECK (EXISTS (SELECT 1 FROM hub.sources s WHERE s.id = raw_events.source_id));

ALTER TABLE hub.delivery_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE hub.delivery_attempts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON hub.delivery_attempts;
CREATE POLICY tenant_isolation ON hub.delivery_attempts
  USING      (EXISTS (SELECT 1 FROM hub.deliveries d WHERE d.id = delivery_attempts.delivery_id))
  WITH CHECK (EXISTS (SELECT 1 FROM hub.deliveries d WHERE d.id = delivery_attempts.delivery_id));

-- Không bật RLS (SPEC-auth §5.1, §5.12.3): bảng danh tính (users, project_members, auth_sessions, email_tokens,
-- auth_audit, projects, api_keys) — tra TRƯỚC khi biết tenant, chỉ qua IdentityRepository / escape hatch có tên;
-- outbox, processed_messages — không có tenant_id (hạ tầng xuyên project). Schema shop không đụng.
