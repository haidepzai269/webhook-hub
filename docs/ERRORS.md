# Mã lỗi của hub — giải thích và cách sửa

> Áp dụng cho **API service** `/v1/p/:project/*` (dev dùng API key) và **console** `/api/v1/*`.
> **Không** áp dụng cho `/hooks/:provider/:sourceKey` (bên gọi là provider, ack theo định dạng của provider) — trừ nguồn
> tuỳ chỉnh (`generic`), body lỗi có thêm `fix`.
> Nguồn sự thật trong code: `libs/common/src/errors/catalog.ts`. Thêm mã mới = thêm mục ở catalog **và** một mục `## <mã>`
> ở file này (test `libs/common/test/error-catalog.spec.ts` đỏ nếu thiếu). Quyết định: ADR-055, ADR-136.

## Khuôn lỗi

```jsonc
HTTP/1.1 403 Forbidden
x-request-id: 6f1c0e9a-…                       // có trên MỌI response của hai nhóm route, kể cả 2xx
{
  "error": "missing_scope",                    // mã máy đọc — ỔN ĐỊNH, code của bạn rẽ nhánh theo trường này
  "message": "This credential lacks the scope required for this action.",   // tiếng Anh, theo thông lệ API
  "fix": "Create a key with scope \"publish:events\" in the console (Project → Keys), or ask the project owner.",
  "docsUrl": "docs/ERRORS.md#missing_scope",   // HUB_DOCS_URL + "#" + error
  "requestId": "6f1c0e9a-…",                    // gửi chuỗi này cho admin → tra log hub-api ra đúng request
  "required": "publish:events",                // tham số riêng của mã (xem từng mục)
  "detail": "…"                                // (tuỳ chọn) câu gốc tiếng Việt do hub viết — console hiển thị câu này
}
```

- **Rẽ nhánh theo `error`**, không theo `message`/`detail` (hai trường này có thể đổi câu chữ).
- `fix` và tham số **không bao giờ** chứa key, secret, giá trị header chữ ký hay body request của bạn.
- Lỗi máy chủ (`internal_error`) không bao giờ lộ stack hay message gốc — chỉ có `requestId`; chi tiết nằm ở log server.
- Gửi kèm `x-request-id` của riêng bạn (8–128 ký tự `A-Za-z0-9._-`) thì hub dùng luôn id đó — tiện nối log hai bên.
- Tra log: `docker compose logs hub-api | grep <requestId>`.

## Lỗi challenge của endpoint (`verificationFix`)

Response tạo endpoint (`POST /v1/p/:project/endpoints`), `/verify` và danh sách endpoint có `verificationError` kèm
`verificationFix`:

| `verificationError` | Nghĩa | Cách sửa |
|---|---|---|
| `timeout` | Endpoint không trả lời trong 10 giây | Kiểm app đang chạy, URL truy cập được từ hub |
| `http_<status>` | Endpoint trả status khác 2xx | Trả 200 với `{"challenge": "<giá trị nhận được>"}` — dùng `hub.challengeResponse(body)` |
| `challenge_mismatch` | Trả 2xx nhưng `challenge` sai | Trả đúng giá trị nhận được (`hub.challengeResponse(body)`) |
| `invalid_json` | Body trả về không phải JSON | Trả JSON `{"challenge": …}` |
| `ssrf_blocked` | URL trỏ vào địa chỉ nội bộ (localhost, 10.x, 192.168.x, link-local…) — hub chặn | **Service đã deploy:** đăng ký URL **công khai** của service (vd đặt `SHOP_PUBLIC_URL` = URL https của Shop). **Dev ở máy local:** đừng đăng ký `localhost` — chạy `npx hub listen --forward http://localhost:3000/webhooks` (kéo sự kiện về máy, xem `docs/QUICKSTART.md`) |
| `unreachable` | Lỗi DNS / bị từ chối kết nối / lỗi TLS | Kiểm tên miền, cổng, service đang chạy và công khai |
| `invalid_url` | Endpoint không có URL http(s) hợp lệ | Tạo lại endpoint với URL https công khai |
| `no_signing_secret` | Endpoint chưa có signing secret | Gọi `/verify` với `{"signingSecret": "whsec_…"}` hoặc tạo lại |

---

## invalid_api_key

**401.** Thiếu header `Authorization: Bearer hk_…`, key sai định dạng, không tồn tại hoặc **đã bị revoke**.
**Sửa:** kiểm `HUB_URL` (connection string `hub://hk_test_…@host/<project>`); tạo key mới ở console (Project → Keys) nếu key cũ đã bị thu hồi.
```bash
curl -si $API/v1/p/cafe/me -H "Authorization: Bearer hk_test_sai"
```

## unauthenticated

**401 (console).** Chưa đăng nhập (không có cookie phiên).
**Sửa:** đăng nhập lại console.
```bash
curl -si "$API/api/v1/events?projectId=$PID"     # không kèm cookie
```

## session_expired

**401 (console).** Phiên đăng nhập hết hạn hoặc đã bị thu hồi (đăng xuất ở thiết bị khác, đổi mật khẩu).
**Sửa:** đăng nhập lại; console tự làm mới phiên một lần trước khi đưa về trang đăng nhập.
```bash
curl -si "$API/api/v1/events?projectId=$PID" -b "access_token=het_han"
```

## csrf_failed

**403 (console).** Request thay đổi dữ liệu thiếu header `x-csrf-token` khớp cookie csrf.
**Sửa:** tải lại trang console; client tự viết phải gửi `x-csrf-token` = giá trị cookie csrf.
```bash
curl -si -X POST "$API/api/v1/sources?projectId=$PID" -b cookies.txt -d '{}'   # thiếu x-csrf-token
```

## missing_scope

**403.** Key (hoặc role trên console) thiếu scope cần cho thao tác. Tham số: `required` = scope cần có.
**Sửa:** tạo key có scope `required` ở console (Project → Keys) hoặc nhờ owner cấp quyền.
```bash
curl -si $API/v1/p/cafe/events -H "Authorization: Bearer $KEY_CHI_DOC" -H 'content-type: application/json' \
  -d '{"type":"order.created","data":{},"idempotencyKey":"x1"}'
```

## forbidden

**403.** Không được phép (lỗi 403 chung không có mã riêng).
**Sửa:** nhờ owner của project cấp role phù hợp.
```bash
# xem "detail" để biết thao tác nào bị chặn
```

## owner_required

**403 (console).** Chỉ owner mới làm được (gán/thu role owner, xoá owner khác, mời owner).
**Sửa:** nhờ một owner thực hiện, hoặc xin role owner.
```bash
curl -si -X PATCH "$API/api/v1/projects/$PID/members/$UID" -b cookies.txt -H "x-csrf-token: $CSRF" -d '{"role":"owner"}'
```

## operator_required

**403 (console).** Chỉ **người vận hành hub** (`users.is_operator`) mới gọi được: cảnh báo `/api/v1/alerts*` và tuỳ chọn
cảnh báo `/api/v1/me/alert-preferences` (SPEC-canh-bao-nhan-dinh §5.2, ADR-169). Owner của project vẫn nhận mã này.
**Sửa:** đăng nhập bằng tài khoản operator, hoặc nhờ admin của hub.
```bash
curl -si "$API/api/v1/alerts" -b cookies-cua-owner.txt
```

## email_not_verified

**403 (console).** Email chưa xác minh: không tạo được project/key `live`, không mời người.
**Sửa:** bấm link xác minh trong email; trong lúc chờ dùng test mode (project test, key `hk_test_`).
```bash
curl -si -X POST $API/api/v1/projects -b cookies.txt -H "x-csrf-token: $CSRF" -d '{"slug":"x","name":"X","environment":"live"}'
```

## invite_email_mismatch

**403 (console).** Lời mời gửi cho email khác với tài khoản đang đăng nhập.
**Sửa:** đăng nhập đúng tài khoản được mời, hoặc nhờ owner mời email này.
```bash
# mở link mời khi đang đăng nhập bằng tài khoản khác
```

## project_limit

**403 (console).** Đã sở hữu tối đa số project cho phép. Tham số: `limit`.
**Sửa:** xoá project không dùng, hoặc xác minh email để được tạo thêm.
```bash
curl -si -X POST $API/api/v1/projects -b cookies.txt -H "x-csrf-token: $CSRF" -d '{"slug":"thu-n","name":"N"}'
```

## not_found

**404.** Tài nguyên không tồn tại **hoặc thuộc project khác** — hai trường hợp trả **cùng một body** (chỉ khác `requestId`)
để không ai dò được project/tài nguyên của người khác. Route không tồn tại cũng ra mã này.
**Sửa:** kiểm slug project trong connection string (key `cafe` chỉ gọi được `/v1/p/cafe/*`) và id tài nguyên.
```bash
curl -si $API/v1/p/bookstore/events -H "Authorization: Bearer $KEY_CAFE"
```

## bad_request

**400.** Request sai (lỗi 400 chung: tham số query sai, JSON hỏng…). `detail` nói rõ quy tắc; có thể có `field`.
**Sửa:** sửa theo `detail` rồi gửi lại.
```bash
curl -si $API/v1/p/cafe/events -H "Authorization: Bearer $KEY" -H 'content-type: application/json' -d '{hong'
```

## project_required

**400 (console).** Route console thiếu `?projectId=` (mọi route console đều theo một project).
**Sửa:** thêm `?projectId=<uuid>` — console tự gắn project đang chọn.
```bash
curl -si $API/api/v1/events -b cookies.txt
```

## token_invalid

**400.** Link/token (xác minh email, đặt lại mật khẩu, lời mời) sai, đã dùng hoặc hết hạn.
**Sửa:** yêu cầu gửi link mới.
```bash
# mở lại một link mời đã dùng
```

## invalid_cursor

**400.** `after` của polling không phải cursor hợp lệ. Hợp lệ: chuỗi số lấy từ `nextCursor`/`event.cursor` lần trước,
hoặc `latest` (bắt đầu từ bây giờ — `hub listen` dùng cách này). **Không** dùng `seq` thấy trên dashboard (thứ tự khác).
**Sửa:** truyền lại đúng `nextCursor`, hoặc `after=latest`.
```bash
curl -si "$API/v1/p/cafe/events?after=abc" -H "Authorization: Bearer $KEY"
curl -s  "$API/v1/p/cafe/events?after=latest" -H "Authorization: Bearer $KEY"   # {"events":[],"nextCursor":"…"}
```

## invalid_event_pattern

**400 (console).** Mẫu kiểu sự kiện sai ngữ pháp.
**Sửa:** chữ thường, số, `_`, phân tách bằng `.`; wildcard chỉ ở cuối (`payment.*`) hoặc `*` một mình.
```bash
curl -si -X POST "$API/api/v1/subscriptions?projectId=$PID" -b cookies.txt -H "x-csrf-token: $CSRF" -d '{"eventTypes":["*.paid"]}'
```

## validation_failed

**422.** Một trường sai quy tắc. Tham số: `field` (tên trường), `invalid` (các giá trị sai, nếu có); `detail` nêu quy tắc.
**Sửa:** sửa trường `field` theo `detail`.
```bash
curl -si "$API/v1/p/cafe/events?limit=500" -H "Authorization: Bearer $KEY"     # limit 1–100
```

## schema_mismatch

**422.** Publish kiểu **chuẩn** (`payment.*`, `repo.*`) mà `data` sai khuôn catalog. Tham số: `type`, `field` (trường sai đầu tiên).
Hub kiểm **trước khi ghi** — không có sự kiện nào được tạo.
**Sửa:** sửa `data` theo `docs/EVENT-CATALOG.md`, hoặc dùng không gian tên riêng của service (vd `order.created`).
```bash
npx hub trigger payment.received --data '{"amount":1.5}'    # amount phải là số nguyên > 0
```

## reserved_type

**422.** Publish (`POST /v1/p/:project/events`, SDK `publish`) kiểu thuộc không gian **`hub.*`** — chỉ chính hub được phát (vd
`hub.project.cleanup_suggested`, ADR-187). Bị từ chối kể cả khi `data` đúng khuôn: nếu không, service có `publish:events`
giả mạo được sự kiện của hub tới mọi subscriber. Tham số: `type`, `field` (= `type`). Hub kiểm **trước khi ghi**. Adapter
(kể cả Generic) map ra `hub.*` thì normalize báo lỗi sai khuôn vĩnh viễn.
**Sửa:** dùng không gian tên riêng của service (vd `order.created`). Muốn **nhận** sự kiện của hub thì đăng ký `hub.*` ở endpoint.
`hub trigger hub.*` không tới được server: CLI dừng ngay ở máy (không có mẫu cho không gian dành riêng, mã thoát 2) — muốn thấy
mã lỗi này thì publish thẳng:
```bash
curl -si $API/v1/p/cafe/events -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"type":"hub.project.cleanup_suggested","data":{}}'    # 422 reserved_type, field = type
```

## scope_not_grantable

**422 (console).** Tạo key với scope mà role của bạn không được cấp.
**Sửa:** chọn scope trong quyền của role (xem `detail`), hoặc nhờ owner tạo key.
```bash
curl -si -X POST "$API/api/v1/projects/$PID/keys" -b cookies.txt -H "x-csrf-token: $CSRF" -d '{"serviceName":"x","scopes":["manage:sources"]}'
```

## outside_read_types

**422.** Subscription xin kiểu sự kiện nằm ngoài `readTypes` của key. Tham số: `field`, `invalid`.
**Sửa:** chỉ subscribe kiểu key được đọc, hoặc tạo key có `readTypes` rộng hơn.
```bash
curl -si -X POST $API/v1/p/cafe/subscriptions -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"endpointId":"…","name":"s","eventTypes":["repo.*"]}'
```

## unknown_source

**422.** `sourceIds`/`sourceKeys` có giá trị không thuộc project. Tham số: `ids` hoặc `keys`.
**Sửa:** dùng id/sourceKey của chính project (console → Sources, hoặc `GET /v1/p/:project/sources` với scope `manage:sources`).
```bash
curl -si -X POST $API/v1/p/cafe/subscriptions -H "Authorization: Bearer $KEY" -d '{"…":"…","sourceKeys":["src_khong_co"]}'
```

## no_publish_source

**422.** Key có scope `publish:events` nhưng không có source `api` để ghi vào (key tạo trước khi có cơ chế này).
**Sửa:** tạo key mới có scope `publish:events` — hub tạo source `api` cùng lúc với key.
```bash
curl -si $API/v1/p/cafe/events -H "Authorization: Bearer $KEY_CU" -d '{"type":"order.created","data":{},"idempotencyKey":"x"}'
```

## missing_idempotency_key

**422.** Không xác định được khoá chống trùng của sự kiện (hub **không bao giờ** tự sinh khoá ngẫu nhiên — gửi lại sẽ thành hai sự kiện).
Gặp ở nguồn tuỳ chỉnh thiếu cấu hình `idempotency`.
**Sửa:** gửi `idempotencyKey` (API) hoặc cấu hình `idempotency` (trường/ header duy nhất mỗi sự kiện) cho nguồn.
```bash
curl -si -X POST $API/hooks/generic/$SOURCE_KEY -H 'content-type: application/json' -d '{"khong_co_id":1}'
```

## payload_too_large

**413.** Body quá lớn. Tham số: `limit`.
**Sửa:** gửi tối đa 1MB mỗi request.
```bash
head -c 2000000 /dev/zero | tr '\0' a | curl -si $API/v1/p/cafe/events -H "Authorization: Bearer $KEY" --data-binary @-
```

## unsupported_media_type

**415.** `Content-Type` không được hỗ trợ.
**Sửa:** gửi `Content-Type: application/json`.
```bash
curl -si $API/v1/p/cafe/events -H "Authorization: Bearer $KEY" -H 'content-type: text/xml' -d '<a/>'
```

## source_inactive

**409.** Source `api` mà key dùng để publish đang bị tắt.
**Sửa:** bật lại source của key ở console (Sources), hoặc tạo key mới có `publish:events`.
```bash
curl -si $API/v1/p/cafe/events -H "Authorization: Bearer $KEY" -d '{"type":"order.created","data":{},"idempotencyKey":"x"}'
```

## project_storage_full

**507 (`/hooks/*` và `/v1/p/:project/events`).** Project đã vượt hạn mức dung lượng (ước tính) và đang **khoá chiều ghi**
(SPEC-han-muc-dung-luong, ADR-182/189). Ở nấc `LOCKED` (≥ 100%) source thường bị từ chối, source gắn **"Giữ lâu"** vẫn nhận
tới 110%; ở `HARD_LOCKED` (≥ 110%) mọi source đều bị từ chối. Không phải 2xx: provider sẽ tự gửi lại một thời gian rồi bỏ.
Event đã lưu vẫn được giao; polling, console và dọn dẹp vẫn chạy. Trả trước khi verify chữ ký nên không tốn HMAC/Redis.
Chỉ xảy ra khi người vận hành bật `STORAGE_LOCK_ENABLED=1`.
**Sửa:** vào trang Dung lượng của project: áp dụng gợi ý dọn, hoặc dọn / xoá hẳn event cũ; project mở khoá khi dưới 90%.
Hoặc nhờ người vận hành tăng hạn mức.
```bash
curl -si -X POST $API/hooks/github/$SOURCE_KEY -H 'content-type: application/json' -d '{}'
```

## suggestion_stale

**409 (`POST /api/v1/projects/:p/storage/suggestions/:id/apply` và `/v1/p/:project/storage/suggestions/:id/apply`).** Hub tính
lại gợi ý dọn ngay lúc gọi (SPEC-han-muc-dung-luong §5.6, ADR-187): gợi ý `:id` đã hết hạn (24h) hoặc không còn trong bộ
hiện tại (dữ liệu đã đổi, đã được dọn…). Tham số `suggestions` = bộ gợi ý vừa tính lại (đã qua hàng rào an toàn).
**Sửa:** chọn một gợi ý trong `suggestions` rồi gọi `apply` lại với `id` của nó. Gọi lại cùng một id hợp lệ trong 24h trả
CÙNG lệnh dọn (idempotent).
```bash
curl -si -X POST $API/v1/p/cafe/storage/suggestions/sug_0123456789abcdef01234567/apply -H "Authorization: Bearer $KEY"
```

## event_trimmed

**409 (console: replay delivery).** Nội dung của event đã được **"Dọn"** để giải phóng dung lượng (SPEC-han-muc-dung-luong
§5.1, ADR-184): chỉ còn dòng gầy (khoá chống trùng, kiểu, thời gian, trạng thái giao) — `data` là `null`, polling trả
`trimmed: true`. Không còn gì để gửi lại. Replay hàng loạt bỏ qua các delivery này với lý do `event_trimmed`.
**Sửa:** không replay được event đã dọn. "Dọn" **giữ** khoá chống trùng, nên bên gửi phát lại với **cùng** khoá sẽ bị chặn
trùng (BB-2) — dữ liệu chỉ vào lại được dưới một khoá **mới** (vd publish lại với `idempotencyKey` khác; provider gửi lại
cùng id thì không cứu được). Lần sau gắn "Giữ lâu" cho source quan trọng
hoặc tắt "Dọn" tự động cho mức tương ứng ở trang Dung lượng.
```bash
curl -si -X POST $API/api/v1/deliveries/$DELIVERY_ID/replay?projectId=$PROJECT -b cookies.txt -H "x-csrf-token: $CSRF"
```

## source_limit

**409 (console + `/v1/p/:project/sources` + tạo key có `publish:events`).** Project đã có tối đa `SOURCE_LIMIT_PER_PROJECT`
(mặc định 20) source **chưa lưu trữ** (SPEC-han-muc-dung-luong §10). Tham số: `limit`. Người vận hành không bị giới hạn.
Key có `publish:events` tạo kèm một source `api` nên cũng tính vào trần.
**Sửa:** lưu trữ ("Xoá" trên bản đồ luồng) source không dùng nữa, hoặc nhờ người vận hành.
```bash
curl -si -X POST $API/v1/p/cafe/sources -H "Authorization: Bearer $KEY" -d '{"provider":"github","name":"x","secret":"s"}'
```

## destination_archived

**409 (console).** Replay một delivery mà đích (hoặc subscription) của nó đã bị **Xoá** khỏi bản đồ luồng (lưu trữ,
ADR-161). Lịch sử vẫn đọc được nhưng không còn nơi nhận.
**Sửa:** tạo đích / subscription mới; sự kiện mới sẽ đi tới đó. Replay hàng loạt tự bỏ các delivery này.
```bash
curl -si -X POST "$API/api/v1/deliveries/$ID/replay?projectId=$PID" -b cookies.txt -H "x-csrf-token: $CSRF"
```

## destination_inactive

**409 (console).** Replay một delivery tới đích đang **Ngắt** (`isActive=false`, ADR-161).
**Sửa:** kết nối lại đích ("Kết nối lại" trên bản đồ luồng hoặc `PATCH /api/v1/destinations/:id {"isActive": true}`) rồi replay.
```bash
curl -si -X PATCH "$API/api/v1/destinations/$ID?projectId=$PID" -b cookies.txt -H "x-csrf-token: $CSRF" -d '{"isActive":true}'
```

## subscription_inactive

**409 (console).** Replay một delivery mà subscription của nó đang **tắt** (`isActive=false`, ADR-163) — giống replay
hàng loạt bỏ qua với lý do `destination_unavailable`.
**Sửa:** bật lại subscription (`PATCH /api/v1/subscriptions/:id {"isActive": true}`) rồi replay.
```bash
curl -si -X PATCH "$API/api/v1/subscriptions/$ID?projectId=$PID" -b cookies.txt -H "x-csrf-token: $CSRF" -d '{"isActive":true}'
```

## conflict

**409.** Xung đột với trạng thái hiện tại (lỗi 409 chung). Tham số có thể có: `code` (vd `DESTINATION_IN_USE`,
`SUBSCRIPTION_HAS_DELIVERIES`), `subscriptionCount`, `deliveryCount`, `field`.
**Sửa:** đọc `detail`; thường là tắt (`isActive=false`) thay vì xoá, hoặc tải lại tài nguyên rồi thử lại.
```bash
curl -si -X DELETE "$API/api/v1/destinations/$ID?projectId=$PID" -b cookies.txt -H "x-csrf-token: $CSRF"
```

## slug_taken

**409 (console).** Đã có project dùng slug này.
**Sửa:** chọn slug khác.
```bash
curl -si -X POST $API/api/v1/projects -b cookies.txt -H "x-csrf-token: $CSRF" -d '{"slug":"cafe","name":"Cafe 2"}'
```

## already_member

**409 (console).** Email đã là thành viên project.
**Sửa:** đổi role của thành viên thay vì mời lại.
```bash
curl -si -X POST "$API/api/v1/projects/$PID/invites" -b cookies.txt -H "x-csrf-token: $CSRF" -d '{"email":"a@b.c","role":"viewer"}'
```

## last_owner

**409 (console).** Project phải còn ít nhất một owner.
**Sửa:** cho thành viên khác làm owner trước.
```bash
curl -si -X DELETE "$API/api/v1/projects/$PID/members/$OWNER_CUOI" -b cookies.txt -H "x-csrf-token: $CSRF"
```

## adoption_not_verified

**409.** Service xin nhận lại endpoint cùng URL của key cũ (đã revoke, cùng `serviceName`) nhưng endpoint không chứng minh
được giữ signing secret → không chuyển chủ. Tham số: `verificationError`; `fix` lấy theo bảng `verificationFix` ở trên.
**Sửa:** làm endpoint trả lời challenge (đúng secret), rồi gọi lại.
```bash
curl -si -X POST $API/v1/p/cafe/endpoints -H "Authorization: Bearer $KEY_MOI" -d '{"name":"shop","url":"https://shop.example.com/webhooks"}'
```

## rate_limited

**429.** Gọi quá nhiều (vd `/verify` tối đa 5 lần/phút/endpoint; publish theo trần của source). Tham số: `retryAfter` (giây) nếu có.
**Sửa:** chờ rồi thử lại, có backoff.
```bash
for i in 1 2 3 4 5 6; do curl -s -o /dev/null -w '%{http_code}\n' -X POST $API/v1/p/cafe/endpoints/$EID/verify -H "Authorization: Bearer $KEY"; done
```

## ip_temporarily_blocked

**429 (`/hooks/*`).** Hộp phạt của hub-api (ADR-177) đang tạm chặn IP của bạn: (a) quá nhiều request vào `sourceKey`
**không tồn tại** từ cùng một IP (mặc định ≥ 20 lần/60s) -> chặn mọi `/hooks/*` từ IP đó; hoặc (b) quá nhiều request
**sai chữ ký** vào cùng một source từ cùng một IP (mặc định ≥ 30 lần/60s) -> chỉ chặn cặp (IP, source) đó. Mặc định chặn
10 phút. Tham số: `retryAfter` (giây còn lại, cũng có ở header `Retry-After`). Source tắt/đã lưu trữ không tính điểm.
Chặn ở cửa trước khi đọc body (D3) thì kèm `Connection: close` — client mở kết nối mới cho lần thử sau.
**Sửa:** kiểm URL webhook (đúng `sourceKey`) và secret đã cấu hình ở provider, rồi đợi hết `retryAfter`.
```bash
for i in $(seq 1 21); do curl -s -o /dev/null -w '%{http_code}\n' -X POST $API/hooks/github/khong_ton_tai -d '{}'; done
```

## edge_rate_limited

**429**, kèm `Retry-After: 1`. Do **nginx ở cửa vào** trả (cầu chì theo IP, chỉ `/hooks/*` và `/v1/p/*`; ADR-176), không
phải hub-api — request chưa tới hub. Một IP vượt `EDGE_IP_RATE` request/giây (mặc định 50, burst `EDGE_IP_BURST` = 500).
Tham số: `retryAfter` (giây). Provider (GitHub, PayOS…) tự gửi lại khi gặp 429.
**Sửa:** giảm tốc độ gửi từ một IP; cần trần cao hơn thì người vận hành chỉnh `EDGE_IP_RATE`/`EDGE_IP_BURST` (không cần build lại).
```bash
for i in $(seq 1 600); do curl -s -o /dev/null -w '%{http_code}\n' -X POST $API/hooks/github/$SOURCE_KEY & done | sort | uniq -c
```

## use_endpoints_route

**422.** `POST /api/v1/destinations` với `type:"webhook"`. Endpoint webhook tạo ở route riêng để hub sinh `whsec_`,
chạy challenge và tạo subscription cùng lúc (SPEC-ket-noi KN1, ADR-138). `/destinations` còn dùng cho telegram/discord.
**Sửa:** gọi `POST /api/v1/endpoints`.
```bash
curl -si -X POST "$API/api/v1/endpoints?projectId=$PID" -b cookies.txt -H "x-csrf-token: $CSRF" -d '{"name":"shop","url":"https://shop.example.com/webhooks","eventTypes":["payment.*"]}'
```

## endpoint_owned_by_service

**409.** Console xoay secret của endpoint do một API key (service) tạo. Service đang giữ secret đó; xoay từ console
làm service ngừng verify được.
**Sửa:** xoay từ phía service (`/v1/p/:project/endpoints/:id/verify` kèm `signingSecret`, SDK `ensure()` làm việc này).
```bash
curl -si -X POST $API/v1/p/cafe/endpoints/$EID/verify -H "Authorization: Bearer $KEY" -d '{"signingSecret":"whsec_..."}'
```

## connector_unsupported

**422.** Provider không có connector (hub không tự đăng ký URL được), vd `sepay`, `generic`. Tham số: `provider`.
**Sửa:** tạo source bằng `POST /api/v1/sources` rồi dán URL ingest vào dashboard của provider.
```bash
curl -si -X POST "$API/api/v1/sources/connect?projectId=$PID" -b cookies.txt -H "x-csrf-token: $CSRF" -d '{"provider":"sepay","name":"x","credentials":{}}'
```

## public_url_required

**422.** `HUB_PUBLIC_URL` là localhost / IP nội bộ: provider ngoài internet không gọi vào được, nên hub không đăng ký.
Không có lời gọi nào tới provider.
**Sửa:** dùng named tunnel (cloudflared) hoặc bản deployed, đặt `HUB_PUBLIC_URL` là URL https công khai.
```bash
HUB_PUBLIC_URL=https://hub.example.com npm run start:api
```

## overwrite_not_acknowledged

**422.** Kết nối PayOS **thay** webhook URL hiện tại của kênh (mỗi kênh chỉ có một URL). Body phải có
`acknowledgeOverwrite: true`. Tham số: `field`.
**Sửa:** xác nhận không còn backend nào nhận PayOS trực tiếp qua URL cũ, rồi gửi lại kèm `"acknowledgeOverwrite": true`.
```bash
curl -si -X POST "$API/api/v1/sources/connect?projectId=$PID" -b cookies.txt -H "x-csrf-token: $CSRF" -d '{"provider":"payos","name":"PayOS","acknowledgeOverwrite":true,"credentials":{"clientId":"…","apiKey":"…","checksumKey":"…"}}'
```

## credentials_required

**422.** Credentials của kết nối đã bị xoá (nút "Xoá credentials"), nên "Thử lại" không có gì để gửi provider.
**Sửa:** gửi lại credentials trong body của `retry`.
```bash
curl -si -X POST "$API/api/v1/sources/$SID/connection/retry?projectId=$PID" -b cookies.txt -H "x-csrf-token: $CSRF" -d '{"credentials":{"secretKey":"rk_…"}}'
```

## internal_error

**500.** Lỗi phía hub. Body **không** chứa chi tiết (không stack, không message gốc) — chỉ `requestId`.
**Sửa:** thử lại sau; nếu lặp lại, gửi `requestId` cho admin hub (admin: `docker compose logs hub-api | grep <requestId>`).
```bash
# không tái hiện được bằng curl thường
```

## service_unavailable

**503.** Hub tạm thời không phục vụ được (phụ thuộc đang hỏng, đang khởi động).
**Sửa:** thử lại có backoff; lặp lại thì gửi `requestId` cho admin.
```bash
curl -si $API/v1/p/cafe/me -H "Authorization: Bearer $KEY"
```
