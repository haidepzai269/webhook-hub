-- R-1/R-2 (review sau merge, ADR-094): endpoint có CHỦ là API key đã tạo nó qua /v1/p. Key khác cùng project không
-- thấy / không gắn subscription / không tắt subscription / không /verify endpoint đó. NULL = đích do operator (console,
-- seed cũ) tạo — /v1/p không quản được. Không FK cứng: key chỉ bị revoke, không bị xoá.
ALTER TABLE "hub"."destinations" ADD COLUMN "created_by_key_id" UUID;
CREATE INDEX "destinations_tenant_id_created_by_key_id_idx" ON "hub"."destinations"("tenant_id", "created_by_key_id");
