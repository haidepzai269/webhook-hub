# REVIEW-PK5 — scheme `unverified` ("đích tự kiểm")

Reviewer độc lập (Grumbal bảo mật · Winston kiến trúc · Murat test), 2026-10-14.
Phạm vi: `feat/pk` @ `C:\wt\pk`, commit `3a22bd5` (migration) + `2028ba3` (lõi + console + danh mục, đã squash).
Nguồn đối chiếu: SPEC-provider-khac (ĐÍNH CHÍNH E4–E7, E14, E17, E18, E24, E26, E29; §7; §16 PK5), REVIEW-PK-SPEC-v2 (N4–N7, M7, M10, M11), CLAUDE.md BB-1..5, docs/EVENT-CATALOG.md.

## Kết luận: **ĐẠT có điều kiện** — 0 Nặng · 2 Trung bình · 9 Thấp

Không tìm thấy đường nào để sự kiện `verified=false` tới **đích** (delivery, polling, replay, listen) khi đích chưa đồng ý, hay mang kiểu chuẩn. Hai mục TB cần sửa trước khi đóng PK5: nhãn ở console chưa phủ hết (chi tiết sự kiện còn ghi "Chữ ký … hợp lệ"), và đường giao thật của cờ `verified` không có test (đột biến sống sót).

## Đã chạy

| Việc | Kết quả |
|---|---|
| jest `--maxWorkers=2`: hub-api `ingest*`, `unverified*`, `redis-budget`, `service-*`, `auth-scope`; `libs/providers/test`; `libs/hub-sdk/test`; hub-worker `normalize*`, `delivery*`, `sender*`, `telegram*`, `webhook-body*`; `apps/web/src/lib/hub` | 60 suite đạt, 3 bị skip (describeDb) · 695 test đạt, 18 bị skip |
| `libs/common/test/error-catalog.spec.ts` | 5/5 |
| `tsc --noEmit`: hub-api, hub-worker, hub-sdk, web | sạch |
| `verify:gates` | 22 luật, 0 vi phạm |
| `catalog:build --check` | khớp (26 mục) |
| Đột biến 1: `delivery.consumer.ts` `verified: true` cố định | **SỐNG** — 46/46 xanh (→ TB-2) |
| Đột biến 2: `persistAccepted` ghi `verified: true` cố định | đỏ 2 test (`ingest-unverified`) ✓ |

Cả hai đột biến đã trả lại; `git status` chỉ còn `libs/hub-sdk/bin/hub.js` (WIP có từ trước, không đụng tới).
`unverified-db.spec.ts` chỉ đọc mã, không chạy (CI chạy). Đã kiểm: bảng `projects` không có RLS, nên gọi `setProjectAllowUnverified` ngoài tx trong test là hợp lệ; fixture dùng owner, repo dùng app. Bốn ca (T14f, T36e, T36f, T37c) khớp đúng SQL đã đổi.

## 1. Bốn khoá: các đường đọc `events` để giao hoặc trả ra ngoài

| Đường | Kết quả |
|---|---|
| Ingest: cờ project | JOIN `projects` cùng câu nạp source (`prisma.service.ts:110-117`), đi qua `ctx.projectFlags`; lõi không đọc config ✓. Đổi cờ khi còn raw chờ normalize: raw đã ACCEPTED vẫn được normalize và giao tới subscription có `acceptUnverified`. Hợp lý, vì cờ là cổng **nhận**, không phải cổng giao (nên ghi một dòng vào ADR-206) |
| `verified` lấy từ raw | `normalize.consumer.ts:200` chép từ `raw_events.verified`. Renormalize đi lại cùng consumer (`api.controller.ts:928`) ✓. DLQ re-drive normalize cũng vậy ✓. Outbox relay và sweeper chỉ đẩy delivery đã có ✓ |
| Publish `/v1/p/:project/events` | `persistAccepted` mặc định `verified: true`; body publish không đặt được cờ ✓ (service đã xác thực bằng API key) |
| Kiểu chuẩn (`hub.*`) | config: `validateUnverified` dùng `isReservedType` ✓; worker: `assertUnverifiedNotReserved` báo lỗi vĩnh viễn ✓; `verificationConfig` không có PATCH, chỉ đặt lúc tạo |
| Router | `route-event.ts:28` + metric ✓. Event do hub phát (`hub-events.ts`) mặc định verified ✓ |
| Replay đơn | `api.controller.ts:672` → 409 ✓. Replay hàng loạt: `tenant-scoped.repository.ts:708` + `findReplaySkipReasons` ✓ |
| Polling | `AND e.verified` trừ khi có `includeUnverified` + scope; thiếu scope → 403 ✓. Scope chỉ cấp được khi người tạo key tự có (`projects.controller.ts:269`). Chỉ có một đường tạo key (`createApiKeyWithSource`) ✓ |
| `hub listen` | chỉ xin `includeUnverified` khi key có scope, in nhãn ✓ |
| Delivery consumer | `findDeliveryForSend` dùng `include: event`, nên `verified` có mặt ✓ (nhưng không có test, xem TB-2) |
| Telegram/Discord | có tiền tố ✓. Hai sender này cùng webhook là ba sender duy nhất ✓ |
| Console REST `/api/v1/events*`, flow, Socket.IO | chỉ thành viên project thấy; nhãn chưa phủ hết (TB-1) |
| `/v1/p/:project/sources/:id/inspect` (manage:sources) | trả cả raw `unverified` mà không cần `read:unverified`. Đây là công cụ cấu hình, vốn đã lộ cả mẫu REJECTED giả, nên chấp nhận được (ghi chú) |

## 2. Migration `20261014090000_unverified_sources`

- Chỉ có `ADD COLUMN … NOT NULL DEFAULT <hằng>`, kèm `lock_timeout 5s` rồi trả lại 0. Không DML, không thêm enum ✓. GRANT cấp bảng nên cột mới tự có quyền ✓. Policy RLS lọc theo `tenant_id`, cột mới không liên quan ✓.
- Index: không cần index mới. Điều kiện `verified` chỉ là bộ lọc phụ trên lượt quét `(tenant_id, poll_seq)`. Rủi ro hiệu năng ghi ở T-5.
- Rollback về `2b38a8d`: Prisma client cũ bỏ qua cột thừa ✓. GenericAdapter cũ không đọc được `scheme: 'unverified'`: nhận mới sẽ trả 401, normalize raw cũ báo lỗi config, nên **không** sinh event mới mang `verified=true` sai ✓. Riêng polling cũ không lọc: xem T-4.

## 3. E7 · E17 · forwardHeaders · URL

- E7: `generic:<id>:<bodyHash>` hoặc `generic:<bodyHash>`, không có nhánh ngẫu nhiên ✓ (`generic.adapter.ts:294-305`).
- E17: trả 413 trong `verify` (sau cờ, trước EG3 và mọi lệnh ghi) ✓. Trần chưa tính `url`/headers, xem T-3.
- `forwardHeaders` cấm `authorization`, `proxy-authorization`, `cookie`, `set-cookie`, `x-api-key`, `x-hub-*` (đủ các tên mà lõi che, `redact-headers.ts:10`) ✓.
- `__hub_meta` do lõi ghi đè sau `storedHeaders`, nên kẻ gửi header `__hub_meta` không chèn được url ✓. `url` dựng bằng `publicIngestBase(env)` + `req.provider/sourceKey` + query thô (`hooksQueryOf` không decode, đúng yêu cầu của Twilio) ✓. Chỉ có `url` khi `forwardUrl` ✓.

## 4. `refusal`: có thành kênh "không phạt" cho kẻ dò không?

Không thành kênh khuếch đại. Phạt `bad_signature` chỉ có ở cấp **cặp**, và `checkPair` đã chạy **sau** câu nạp source (`ingest.service.ts:503`). Vì vậy request bị từ chối khi cờ tắt tốn đúng bằng một request bị chặn cặp: một câu DB, 0 HMAC, 0 ghi, 0 Redis. Phạt cấp IP (404 sourceKey lạ) vẫn chạy trước DB. Phần còn thiếu là quan sát được, xem T-9. Riêng khi cờ bật thì `markGood` được cấp mà không cần ký, xem T-2.

## 5. Ngân sách Redis

`redis-budget.spec.ts` `[PK:T14](phần e)`: nhận 3 lệnh, cờ tắt hoặc 413 thì 0 lệnh, normalize vẫn 1 PUBLISH ✓. Đã chạy, xanh.

## 6. SDK, Telegram/Discord

`unwrapUnverified` dùng `Buffer.from(raw,'base64')`, khớp đúng từng byte (có test form và byte nhị phân). Hàm ném lỗi khi `verified !== false` ✓. Tiền tố được thêm cả khi nội dung lấy từ template ✓.

## 7. Console

Chỉ owner hoặc operator đổi được cờ project (`manage:project`), audit `project.unverified_sources_changed` ghi trước/sau trong cùng tx ✓. Có tick ở subscription/endpoint, kèm audit ✓. Cảnh báo URL chứa sourceKey hiện ở ô `forwardUrl` ✓. Hệ số 2,33× hiện trong note ✓. Nhãn: xem TB-1.

## 8. Danh mục (đã WebFetch tài liệu, 2026-10-14)

- **momo**: tài liệu ghi rõ đối tác trả **204 trong 15 giây**. Có 13 trường IPN, khớp `required + optional`. `transId` là số, nên `extractIdempotencyKey` đổi sang chuỗi ✓.
- **twilio**: chữ ký HMAC-SHA1 với khoá Auth Token, tính trên URL đầy đủ cộng tham số POST sắp a→z. Tài liệu nhấn mạnh phải dùng *đúng URL, không decode/encode lại*: lõi giữ query thô ✓. Body JSON thì có `bodySHA256` trong query, vẫn được phủ nhờ `forwardUrl` ✓. Ghi chú TwiML/S10 hợp lý.

---

## Trung bình

### TB-1. Console vẫn để sự kiện chưa xác thực "trông như đã xác thực" (khoá 2: "nhãn ở mọi nơi có event")
- `libs/common/src/flow/build-event-flow.ts:549-558`: raw ACCEPTED có `signatureValid=true` dựng chặng `verified` với **status ok, tiêu đề "Chữ ký generic hợp lệ"**. Trang chi tiết sự kiện (`apps/web/.../events/[id]/page.tsx`) và stage-sheet hiện ✓ xanh. Hiện chỉ trang **danh sách** sự kiện có badge.
- Tab Lắng nghe: `diagnose` của ACCEPTED trả `reason 'ok'`, giao diện ghi **"hợp lệ"** (`page-sources.ts:206`).
- Chặng `routed`: `classifySkippedSubscriptions` (`build-event-flow.ts:131-147`) không có lý do cho "subscription không acceptUnverified". Subscription bị router bỏ qua biến mất khỏi hành trình, không có giải thích, dù console vẫn hiện "khớp kiểu".
- **Kịch bản**: kẻ biết sourceKey bơm `momo.ipn` giả, cờ project đang bật. Nhân viên mở chi tiết sự kiện và thấy "Chữ ký … hợp lệ ✓".
- **Đề xuất**: `FlowRawInput.verified`. Khi false, chặng `verified` lấy status riêng (vd `warn`/`skipped`) với tiêu đề "Không xác thực — đích tự kiểm chữ ký gốc". Listen tab dùng nhãn "nhận (chưa xác thực)". Thêm lý do `unverified_not_accepted` vào `classifySkippedSubscriptions` (cần `acceptUnverified` + `event.verified` trong input). Thêm badge ở trang chi tiết. Mỗi chỗ một test.

### TB-2. Đường giao thật của cờ `verified` không có test (đột biến sống)
- `apps/hub-worker/src/consumers/delivery.consumer.ts:220-221`: đổi thành `verified: true` thì 46/46 test (`normalize-unverified`, `delivery-consumer`, `telegram-sender`) vẫn xanh. `[PK:T16](phần c)` chỉ gọi `toWebhookBody` trực tiếp, Telegram/Discord thì test bằng event dựng tay.
- **Kịch bản**: refactor `toNormalizedEvent` (hoặc chuyển `findDeliveryForSend` sang `select`) làm rơi trường này. Mọi đích nhận `"verified": true` cho bản giả, Telegram mất tiền tố, CI vẫn xanh. Đây đúng là chỗ khoá 2 chạm tới đích.
- **Đề xuất**: test DeliveryConsumer với `row.event.verified=false`, assert body gửi đi có `"verified":false` (webhook) và text bắt đầu bằng `[Chưa xác thực]` (Telegram). Chạy lại đột biến trên để xác nhận đỏ.

## Thấp

- **T-1. Cờ tắt mà bắt tay vẫn được trả lời và ghi dòng.** `runHandshake('before-verify')` (`ingest.service.ts:551`) chạy trước `verify`, còn `GenericAdapter.handshake` (`generic.adapter.ts:74`) không xét `projectFlags`. Source `unverified` có body-echo/query-echo/manual-url, ở project cờ tắt, vẫn trả 200 và ghi dòng handshake (meta-only, ≤5/phút). Điều này trái câu "tắt cờ… không ghi" của §7.1. Đề xuất: adapter trả `null` hoặc refusal cho bắt tay khi `unverified` và cờ tắt, hoặc ghi rõ ngoại lệ vào ADR-206.
- **T-2. `markGood` cho request không ký.** `ingest.service.ts:578` đánh dấu "cặp tốt" sau khi nhận `unverified`. Kẻ có sourceKey nhờ đó có ngưỡng 401 ×hệ số và được bỏ qua lệnh cấm IP cho cặp này. Ảnh hưởng nhỏ, vì request của họ vốn được nhận. Nhưng "cặp tốt" nghĩa là *ký đúng*. Đề xuất: chỉ `markGood` khi `verdict.verified`.
- **T-3. Trần 45KB chưa tính `url` và `forwardHeaders`.** Base64 của 45KB = 60KB, cộng query ≤8KB (E27) trong `data.url`, cộng tối đa 10 header, có thể vượt `SEND_MAX_BYTES` 64KB. Request đã ACK (BB-3 đúng) nhưng delivery DEAD vĩnh viễn. Đề xuất: ở verify, kiểm `ceil(body×4/3) + len(query) + Σ header forward ≤ ~62KB`, hoặc trừ query vào trần.
- **T-4. Rollback mở polling.** Code `2b38a8d` không lọc `verified`, nên mọi key `read:events` poll thấy các event `verified=false` đã có. Ghi vào runbook/ADR-206: trước rollback, chặn polling hoặc chấp nhận rủi ro.
- **T-5. Cursor không vượt qua đoạn bị lọc.** `nextCursor = after` khi trang rỗng (`service-resources.controller.ts:388`). Nếu đuôi toàn event `unverified` (kẻ có sourceKey bơm ~100/phút, theo EG3), key không có scope sẽ quét lại cả đuôi ngày càng dài ở mỗi vòng long-poll. Lỗi này đã có sẵn với `types`/`readTypes`, PK5 làm nó dễ bị kích hơn. Docstring "Cursor vẫn đi qua chúng" (`tenant-scoped.repository.ts:512`) gây hiểu nhầm. Đề xuất: trả kèm `max(poll_seq)` đã quét, hoặc sửa docstring và mở việc riêng.
- **T-6. Retry đang chạy không dừng khi bỏ tick `acceptUnverified`.** `delivery.consumer.ts` không kiểm lại cờ lúc gửi. Cách xử lý giống `isActive`, nên nhất quán; chỉ cần ghi một dòng vào ADR-206 (E4 chỉ nói replay).
- **T-7. Replay hàng loạt dùng lý do `destination_unavailable`** (lệch 6). Người dùng sẽ đi kiểm tra đích thay vì cờ của subscription. Nên thêm lý do riêng khi web có `ReplaySkipReason` mới.
- **T-8. §16 PK5 không nói gì về T-7 của PK1** ("body không phải JSON ở generic vẫn `body = {}`… PK5 không được trượt"). Với `unverified` đã xong (`data.raw` giữ bytes). Với scheme có verify thì chưa thấy thay đổi. Cần ghi rõ là đóng, hay chuyển sang PK6/PK7.
- **T-9. Từ chối do cờ tắt là vô hình với chủ project.** Request bị từ chối không vào lưu lượng, cũng không vào Lắng nghe; chỉ có metric và log. Dev quên bật cờ sẽ không thấy gì trên console. Đề xuất: danh sách nguồn hiện cảnh báo "Project chưa bật nhận nguồn chưa xác thực" cạnh nguồn `unverified`. Không cần ghi DB.

## 10. Ý kiến về các lệch ở §16

1. **`refusal` là biến thể thứ ba của `VerifyResult`**: đồng ý. Lõi vẫn không đọc config, kiểu `status: 401|413` đóng chặt. Cách làm đúng.
2. **Hook `storedMeta` + `ctx.publicUrl`, bỏ `diagnose public_url_missing`**: đồng ý về kiến trúc (worker không đọc env). Nhưng `url: null` đến đích im lặng; nên có một chẩn đoán ở Lắng nghe (gộp vào T-9).
3. **Cấm thêm `proxy-authorization`, `x-api-key`**: đúng; nếu không, đích nhận `***`.
4. **`idempotency` tuỳ chọn ở mức kiểu**: chấp nhận được. Validator vẫn bắt buộc với scheme có verify; các chỗ đọc đã có guard (`diagnose`, `eventHeadersOf`, `handshakeConflict`).
5. **Scope `read:unverified` và cách "owner cấp"**: đúng ý E4. Audit đi qua `api_key.created` (có scopes). Thiếu scope thì 403 thay vì lọc im lặng: tốt cho DX.
6. **Replay hàng loạt dùng `destination_unavailable`**: chấp nhận tạm, xem T-7.
7. **Nhãn console**: đây là lệch đáng ngại nhất. "Mọi nơi" mới làm được ở danh sách, xem TB-1.
Ngoài ra: `[PK:T18]` mới ở mức L0, vòng qua stack LOCAL dời sang PK8 §13 bài B, chấp nhận. Việc giữ aws-sns ở pending vì chưa ghim được TopicArn là đúng (verify mà không ghim topic thì vô nghĩa).
