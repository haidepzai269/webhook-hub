# RESUME — đợt đa service (dừng 2026-10-10 tối theo lệnh coordinator)

## Đã commit (master, chưa push)
| Story | Commit | Ghi chú |
|---|---|---|
| S0 | — (chỉ kiểm) | `bash scripts/e2e-smoke.sh` trên stack DEV (code c96bf6b) → OK: repo.push→Discord mock SUCCEEDED, payment.received→Shop SUCCEEDED, SePay 2 lần → 1 raw/1 event, 0 secret trong outbox. `grep channel.publish apps/hub-worker/src/consumers` = 1 (DLX DEAD ở delivery.consumer:397, không phải dual-write). U29 gắn vào test `[AF:#16][MS:U29]` (commit S1) |
| S1 | `aa2692c` | schema + migration `20261011000000_projects_api_keys` (thử trên bản sao DB dev có dữ liệu: OK), ADR-071 |
| S2 | `3d3b5ed` | console project/key, `ProjectScopeGuard`, seed key shop, ADR-072 (+073 viết sẵn) |
| S3 | `6c72d65` | `ApiKeyGuard`, `@RequireScope`, `/v1/p/:project/me` |
| MS-R1..R6 | `3130339` `4da8f29` `a3893fb` `d16433c` `7202269` | sửa review pha 1 (ADR-083..087); docs `58f7e45`; hubv đã build lại, đang chạy cho review pha 2 |
| S12 | `5496b3e` | demo cafe/bookstore |
| S11 | `bb70d92` | SDK + Shop service |
| S9 | `50651b4` | inspect/diagnose |
| S8 | `c3610d1` | GenericAdapter + mapping, sources /v1/p, ADR-079 |
| S10 | `775ca17` | DELIVERY_TIMEOUT_MS, ADR-078 |
| S7 | `2b5f16f` | polling/long-poll, events.created_at (migration 20261011010000), dashboard before/after, retention events, ADR-077 |
| S6 | `b4193a6` | Standard Webhooks, challenge, /verify, U30, link-local, Shop swVerify, ADR-076 |
| S5 | `ce33fb0` | endpoint/subscription /v1/p, sourceIds, ADR-075; hàm repo cũ giữ, mới = findActiveSubscriptionsForEvent |
| S4 | `b11406e` | (phiên 2) POST /events, persistAccepted, ApiAdapter, ADR-074. E2E hubv đủ. Trần body thật = 100KB (body-parser) |

> Phiên 2 (sau khởi động lại): các mục "Story đang dở: S4" bên dưới là LỊCH SỬ. Story đang làm: xem dòng cuối bảng trên + `git log`.

## Story đang dở: S4 (POST /events) — CHƯA commit
Đã làm (working tree, chưa commit):
- `libs/providers/src/api.adapter.ts` (mới), `index.ts`, `provider.registry.ts` (đăng ký ApiAdapter)
- `apps/hub-api/src/modules/ingest/ingest.service.ts`: tách `persistAccepted` (bước 5–7) + `traced` + `ackFor`; thêm `publishFromService`
- `apps/hub-api/src/modules/service-api/service-api.controller.ts`: `POST /v1/p/:project/events` + `validatePublishBody` (422 `validation_failed{field}` / `schema_mismatch{field}`)
- `apps/hub-api/src/modules/console/api-key-create.ts`: key có `publish:events` → tạo kèm source `api` (`api_<keyId>`)
- Test: `libs/providers/test/api.adapter.spec.ts` [MS:U16], `apps/hub-api/test/publish-canonical.spec.ts` [MS:U49], ca X9 `/events` trong `apps/hub-api/test/redis-budget.spec.ts`
- RED đã chụp (stub): U49/422 nhận 500/không throw; redis-budget `/events` Expected 202 Received 500; U16 là lỗi biên dịch stub (ghi chú).
- Đã chạy: `npx jest -w 2 publish-canonical redis-budget api.adapter apps/hub-api/test/ingest` → 22/22 pass; `tsc --noEmit` hub-api sạch.

Còn lại của S4:
1. `npm run verify` (L0+L1 cần hubv) → xanh; `verify:map -- --story S4`.
2. Dựng lại hubv, E2E: T2/T3 (key cafe gọi bookstore 404 giống hệt; scope 403), T6 phần publish (202 / 200 duplicate / `type:"Order"` 422 / thiếu idempotencyKey 422 / `POST /hooks/api/api_<keyId>` 401).
3. ADR S4 (persistAccepted dùng chung bước 5–7; idempotencyKey > 251 ký tự → `api:sha256:<hex>`; source api tạo kèm key; 202 cho /events).
4. Commit `feat(S4): …` với khối Verify.

## Việc tiếp theo (thứ tự §00): S5 → S6 → S7 → S10 → ghi §7 chặng A → S8(+mapping) → S9 → S11 → S12 → docs.

## Lệnh khi quay lại
```bash
cd /c/webhook-hub
df -h /c                       # !!! ổ C đã ĐẦY (0 byte) giữa phiên -> ENOSPC; đã prune build cache, còn ~2.8G. Docker CLI bị treo.
docker builder prune -f        # nếu docker đã hồi lại; cân nhắc giải phóng thêm chỗ trước khi build
npm run verify:up              # 5–9 phút
npm run verify                 # xác nhận S4 xanh
```

## Quyết định / giả định chưa ghi vào DINH-CHINH §7 (X12, X17)
- Route + lỗi thật (S2): `POST /api/v1/projects` 201 · 409 `{error:"slug_taken"}` · 422 `{error:"validation_failed",field,message}`; `GET /api/v1/projects` trả **mảng** `[{id,slug,name,environment,createdAt}]`; `POST /api/v1/projects/:projectId/keys` → 201 `{id,serviceName,keyPrefix,scopes,readTypes,sourceId,createdAt,key,connectionString}`; scopes rỗng → 422 field `scopes`; `DELETE …/keys/:keyId` 204 (lần 2 vẫn 204), key không thuộc project 404 `{error:"not_found"}`; project lạ 404 `{error:"not_found"}`. Audit: `project.created`, `api_key.created`, `api_key.revoked`.
- `?projectId=`: đọc DUY NHẤT ở `apps/hub-api/src/modules/console/project-scope.guard.ts` (`ProjectScopeGuard`, gắn sau `JwtAuthGuard` trên `ApiController`).
- S3: `/v1/p/:project/me` → `{project:{slug,name,environment},serviceName,scopes}`; 401 `{error:"invalid_api_key"}`, 404 `{error:"not_found"}`, 403 `{error:"missing_scope",required}`. `request.principal = {kind:'key', id, tenantId, scopes, serviceName}`.
- S4 (dở): 202 `{eventId:null,rawEventId,duplicate:false}`; trùng 200 `{duplicate:true}`; source tắt 409 `{error:"source_inactive"}`.
- Cột mới (X17): `projects`, `api_keys(tenant_id, service_name, key_prefix, key_hash, scopes, read_types, source_id, last_used_at, revoked_at)`, `sources.verification_config`, `events.seq` (BIGINT, JSON ra **chuỗi**), `events.source_id`, `destinations.verification` (enum `EndpointVerification` PENDING/VERIFIED/FAILED, default VERIFIED), `destinations.verified_at`, `destinations.verification_error`, `subscriptions.source_ids uuid[]`; enum `ProviderEnum` thêm `generic`, `api`; enum `ProjectEnv` test/live. FK `subscriptions_destination_id_tenant_id_fkey` (ghép, RESTRICT) thay `subscriptions_destination_id_fkey`. Không đổi/xoá cột delivery/attempt nào.
- Hàm repo: CHƯA đổi tên `findActiveSubscriptionsForEventType`. Dự định S5: thêm `findActiveSubscriptionsForEvent(type, sourceId)` và GIỮ hàm cũ (cho module flow của nhánh UI).
- Dự định S6: SSRF ngoài production vẫn cho IP private (sink) nhưng LUÔN chặn 169.254.0.0/16 + fe80::/10 (metadata) — cần ADR.
- Dự định S7: cửa sổ lắng lọc theo cột mới `events.created_at` (thời điểm INSERT) chứ không theo `received_at` (= lúc ingest, sớm hơn INSERT nên không bảo vệ cursor) — cần ADR + ghi lệch; dashboard `GET /api/v1/events` dùng `before` (giảm dần, như cũ), `after` = seq tăng dần; `useEvents` gửi `before`.
- `.env.verify`: `HUB_PUBLIC_URL=http://localhost:14000`, `SEED_SHOP_API_KEY=hk_test_VERIFY_ONLY_shop_key_…`; env-verify + assert production nhận/chặn dạng `hk_test_VERIFY_ONLY_`.
- Các agent khác đã commit spec (`c79e539`, …): DINH-CHINH/SPEC giờ được track — vẫn KHÔNG commit chúng theo luật.
