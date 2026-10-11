# ADR nháp — Event Flow UI (cấp số lúc merge, chép vào docs/adr/README.md)

**EF-1 · Web dùng chung từ vựng chặng qua path alias.** Vấn đề: API và web phải cùng một `StageView`/`REASON_CODES`/`healthOf`. Chọn: `apps/web/tsconfig.json` alias `@hub/flow` → `libs/common/src/flow/index.ts` (file thuần TS, không import Node); hub-api import tương đối qua `modules/flow/flow-lib.ts` vì `libs/common/src/index.ts` ngoài phạm vi sửa. Đánh đổi: Vercel phải bật "include files outside root" (mặc định bật); lúc merge thêm `export * from './flow'` vào index rồi đổi `flow-lib.ts` sang `@hub/common`.

**EF-2 · Repo flow kế thừa TenantScopedRepository trong module flow.** Vấn đề: spec cấm sửa `libs/database` (agent đa service đang sửa) nhưng BB-5 bắt đi qua repo scope. Chọn: `FlowScopedRepository extends TenantScopedRepository` (constructor bắt tenantId), mọi câu lọc `tenant_id`/`sources.tenant_id`; lấy client qua `forTenant()` (PrismaService.client là private). Đánh đổi: một cast có chú thích; lúc merge chuyển các hàm vào repo gốc.

**EF-3 · FlowModule mượn PrismaService của AppModule qua ModuleRef.** Vấn đề: chỉ được thêm một dòng ở app.module, PrismaService không export qua module nào. Chọn: factory `ModuleRef.get(PrismaService, {strict:false})` lười. Đánh đổi: phụ thuộc ngầm; không tạo client/pool thứ hai (giới hạn kết nối Neon).

**EF-4 · Mã test `[UI:Fx-nn]` chưa có nguồn trong verify/spec-sources.json.** Vấn đề: `verify:map` sẽ coi là mã ma; file đó ngoài phạm vi sửa và spec chưa có bảng mã. Chọn: dùng mã `[UI:F1-01..26]`, `[UI:F2-01..06]`, `[UI:F4-01..04]`, `[UI:F5-01..02]`. Lúc merge thêm nguồn `{ns:"UI", file:".../SPEC-event-flow-ui.md", inline codes}`. Đánh đổi: map đỏ trên nhánh tới khi merge.

**EF-5 · Mốc thời gian normalize lấy từ delivery đầu.** Vấn đề: `events.received_at` là bản sao giờ nhận raw (normalize consumer chép sang) nên +ms của normalize luôn 0. Chọn: normalize/route kết thúc = `min(deliveries.created_at)` (cùng transaction normalize+route); không có delivery → null (không bịa). Đánh đổi: event không khớp subscription nào không có số đo normalize.

**EF-6 · executions: sắp + lọc sơ bộ trước LATERAL.** Vấn đề: đo 10k event, LATERAL dựng JSON cho mọi dòng rồi mới sắp → 800ms. Chọn: subquery có ORDER BY + điều kiện EXISTS rẻ theo index unique deliveries(event_id, subscription_id, generation) để LIMIT dừng sớm; điều kiện chính xác vẫn ở ngoài. Kết quả p95 ≤ 154ms. Đánh đổi: hai bản điều kiện trạng thái (test DB F4-02 đối chiếu với buildEventFlow). Không cần migration index.

**EF-7 · V1 gộp các attempt thành chip trong node Delivery.** Vấn đề: `Delivery → Attempt 1 → … → Kết thúc` thành 13 cột, fitView thu nhỏ còn ~55% không đọc được. Chọn: node Delivery chứa chip `#n HTTP ms` nối nhau, bấm chip mở panel attempt; chi tiết đầy đủ ở card Delivery Attempts. Đánh đổi: lệch nhẹ chữ của spec §4 V1.

**EF-8 · Trùng (duplicate) không có trong DB.** Ingest trả ACK duplicate mà không ghi raw_events, nên V2/V3 không đếm được bản trùng (node source luôn "0 trùng"); `buildEventFlow` vẫn có nhánh DUPLICATE cho tương lai. Muốn đếm phải ghi mẫu như REJECTED — ngoài phạm vi spec.
