-- CB2 (SPEC-canh-bao-nhan-dinh §5.1): index cho truy vấn tổng hợp của AlertEvaluator — chỉ DDL, không đụng dữ liệu.

-- Attempt trong cửa sổ 15–30 phút (luật chuỗi 401/4xx, destination.failing): trước đây chỉ có index (delivery_id).
-- Bảng chỉ INSERT, index tăng ở mép phải -> chi phí ghi nhỏ trên đường giao.
CREATE INDEX IF NOT EXISTS "delivery_attempts_created_at_idx" ON "hub"."delivery_attempts" ("created_at");

-- Delivery mới DEAD trong cửa sổ (delivery.dead_spike, facts.dead): index MỘT PHẦN chỉ chứa dòng DEAD — không phải quét
-- cả DLQ theo (tenant_id, status, …), và chỉ tốn ghi khi một delivery đi vào DEAD. Prisma 6 không khai được `WHERE`
-- nên index này chỉ có ở đây (schema.prisma ghi chú — tiền lệ alerts_open_unique).
CREATE INDEX IF NOT EXISTS "deliveries_dead_tenant_updated_idx" ON "hub"."deliveries" ("tenant_id", "updated_at" DESC) WHERE "status" = 'DEAD';
