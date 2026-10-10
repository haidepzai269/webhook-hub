# Kịch bản Admin tự test: hub đã thật sự là đa service chưa?

> **Đường dẫn:** `_bmad-output/planning-artifacts/verification/KICH-BAN-TEST-DA-SERVICE.md`
> **Ngày viết:** 2026-10-10 tối · **Người chạy:** Admin, tự tay, trên Git Bash.
> **Viết theo:**
> - `SPEC-hub-multi-service.md` S0–S14;
> - `DINH-CHINH-2026-10-10.md` §00 (bảng X1–X14), file này **thắng** SPEC;
> - code thật ở `3ea2cb5` (VF1: stack `hubv`, sink nhận thử).
>
> **Thứ tự dự án lúc viết:** VF1 ✅ → VF2 → VF7 → đa service **chặng A** (S0, S3-1, S1–S7, S10) → **chặng B** (S8, S9, S14 phần còn lại, S11, S12) → AU1–AU6.
> **Trước mỗi phần:** mở `DINH-CHINH-2026-10-10.md` §7 ("Lệch / ghi chú"). Agent dev ghi ở đó route, tên trường và mã lỗi **thật** sau mỗi story (X12). Chỗ nào code khác file này thì code + §7 đúng: sửa lệnh, ghi vào cột "Ghi chú" ở bảng kết quả §6.
> **Spec gốc của mỗi bước** là mã `T*` ở SPEC đa service §7.2. File này viết lại cho **người** chạy: mỗi bước có *làm gì*, *phải thấy gì*, và *nếu sai thì nghĩa là gì*.

---

## 0. Kịch bản này chứng minh điều gì

"Đa service" không phải là "có bảng `projects`". Nó là **10 lời hứa** mà một dev bên ngoài sẽ kiểm. Mỗi lời hứa ứng với một phần của file này:

| # | Lời hứa với dev dùng hub | Phần | Story |
|---|---|---|---|
| H1 | Mỗi service có danh tính riêng (key), và key chỉ lộ một lần | A1 | S1, S2 |
| H2 | Project này **không nhìn thấy** project kia, kể cả biết id | A2 | S3 |
| H3 | Key chỉ làm được đúng việc của scope | A3 | S3 |
| H4 | Hub chỉ gửi tới endpoint đã chứng minh là của mình (challenge) | A4, A7 | S6 |
| H5 | Service tự đăng ký nhận đúng loại sự kiện, đúng nguồn | A5 | S5 |
| H6 | Service tự phát sự kiện vào hub, gửi trùng không sinh hai | A6 | S4 |
| H7 | Push có chữ ký chuẩn (Standard Webhooks) mà **service tự kiểm được, không cần tin hub** | A6 | S6 |
| H8 | Endpoint chết thì service tự lấy lại phần lỡ (polling) | A8 | S7 |
| H9 | Một nguồn lạ (ngân hàng không có adapter) cũng vào được, và nhìn được vì sao bị từ chối | B1 | S8, S9 |
| H10 | **Vào nhiều kiểu, ra một kiểu** | 0.2, B2 | S14 |

Chặng 0 chạy được **hôm nay**. Chặng A chạy được khi agent báo xong chặng A, chặng B khi agent báo xong chặng B.

---

## 1. Chuẩn bị (mỗi lần test)

```bash
cd /c/webhook-hub
npm run verify:reset          # xoá sạch hubv rồi dựng lại + seed (~1–2 phút; lần đầu build 5–8 phút)
npm run verify:ps             # mọi service "running"/"healthy", có cả "sink"
```

> Stack `hubv` **tách biệt** với stack dev (cổng +10000). Anh muốn kill, xoá gì trên `hubv` cũng được. **Không** đụng stack dev `webhook-hub` khi agent đang làm.

Dán khối này vào terminal. Mọi bước sau dùng các hàm này:

```bash
API=http://localhost:14000          # hub-api của hubv
SINK=http://localhost:14100         # "service của dev" giả ở đầu nhận (tools/verify-sink)
SINK_IN=http://sink:4100            # địa chỉ hub-worker dùng để gọi sink (trong mạng docker)
DC="docker compose -p hubv -f docker-compose.yml -f docker-compose.verify.yml --env-file .env.verify"

# Lấy một trường JSON: echo '{"a":{"b":1}}' | jget .a.b
jget() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s);const v=eval("o"+process.argv[1]);console.log(typeof v==="object"?JSON.stringify(v):v)})' "$1"; }
# SQL trên Postgres của hubv
q() { $DC exec -T postgres psql -U hub_user -d webhook_hub -tA -F ' | ' -c "$1"; }
# Gọi API in kèm mã HTTP ở dòng cuối
call() { curl -s -w '\n→ HTTP %{http_code}\n' "$@"; }

# Đăng nhập console (trước AU1: JWT admin env; sau AU1 phần này đổi sang cookie, xem SPEC-auth)
JWT=$(curl -s $API/auth/login -H 'content-type: application/json' \
  -d '{"username":"admin","password":"VERIFY_ONLY_admin_password"}' | jget .accessToken)
H="Authorization: Bearer $JWT"; echo "JWT: ${JWT:0:20}…"
```

✅ In ra `JWT: eyJ…`. Ra `undefined` nghĩa là đăng nhập hỏng, dừng lại, chưa test được gì.

**Kiểm chữ ký độc lập.** Đoạn này đóng vai **dev bên ngoài**: dùng `crypto` của Node, **không** dùng code hay SDK của hub. Lưu thành `verify-sig.js` ở scratch, hoặc dán khi cần:

```bash
verify_sig() {  # verify_sig <signingSecret> <path trên sink>
  node -e '
const c=require("crypto");const [secret,path,sink]=process.argv.slice(1);
fetch(sink+"/_requests?path="+encodeURIComponent(path)).then(r=>r.json()).then(list=>{
  const r=list[list.length-1]; if(!r){console.log("❌ sink chưa nhận request nào ở",path);return;}
  const id=r.headers["webhook-id"], ts=r.headers["webhook-timestamp"], sig=r.headers["webhook-signature"]||"";
  const key=secret.startsWith("whsec_")?Buffer.from(secret.slice(6),"base64"):Buffer.from(secret);
  const exp="v1,"+c.createHmac("sha256",key).update(`${id}.${ts}.${r.body}`).digest("base64");
  const ok=sig.split(" ").some(s=>s.length===exp.length&&c.timingSafeEqual(Buffer.from(s),Buffer.from(exp)));
  const xhub=Object.keys(r.headers).filter(h=>h.startsWith("x-hub-"));
  console.log(ok?"✅ chữ ký Standard Webhooks ĐÚNG":"❌ chữ ký SAI", "| webhook-id:",id, "| header x-hub-*:", xhub.length?xhub:"không có");
});' "$1" "$2" "$SINK"
}
```

---

## 2. Chặng 0: chạy được hôm nay, trên code hiện tại

> Phần đa service đã có sẵn từ SPEC-3: S0 (outbox), lõi S14, wildcard.

### 0.1 Luồng cũ còn sống (S0, hồi quy)

```bash
HUB_URL=$API PG_CONTAINER=$($DC ps -q postgres) bash scripts/e2e-smoke.sh
```

✅ Bảng events × deliveries, dòng cuối `OK`, exit 0. Nếu đỏ thì đừng chạy tiếp: nền đã hỏng.

### 0.2 Vào nhiều kiểu, ra một kiểu (lõi S14, đã có) — H10

Smoke vừa bắn **SePay**. Bắn thêm **PayOS** cùng số tiền, rồi so hai body mà Shop nhận:

```bash
q "select e.source, e.type, (select string_agg(k, ',' order by k) from jsonb_object_keys(e.data - 'raw') k) as keys,
          e.data->>'amount' as amount, e.normalized
   from hub.events e where e.type like 'payment.%' order by e.received_at desc limit 4"
```

✅ Mỗi provider (sepay, payos) có một dòng `payment.received`, cột `keys` **giống hệt nhau**, `normalized = t`.
❌ `keys` khác nhau nghĩa là "ra một kiểu" chưa đúng. Đó là luận điểm chính của đề tài.

> Bắn PayOS ký đúng cần checksum key `VERIFY_ONLY_payos_checksum_key` (trong `.env.verify`) và thuật toán của PayOS. Cách nhanh: `node` + `@payos/node` có sẵn trong repo, như review S3-1 đã làm:
> ```bash
> node -e '
> const {PayOS}=require("@payos/node");const p=new PayOS({clientId:"x",apiKey:"x",checksumKey:"VERIFY_ONLY_payos_checksum_key"});
> const data={orderCode:Date.now()%1e9,amount:10000,description:"TEST",accountNumber:"0",reference:"R"+Date.now(),transactionDateTime:"2026-10-10 10:00:00",currency:"VND",paymentLinkId:"x",code:"00",desc:"success",counterAccountBankId:"",counterAccountBankName:"",counterAccountName:"",counterAccountNumber:"",virtualAccountName:"",virtualAccountNumber:""};
> p.crypto.createSignatureFromObj(data,"VERIFY_ONLY_payos_checksum_key").then(sig=>console.log(JSON.stringify({code:"00",desc:"success",success:true,data,signature:sig})));' > /tmp/payos.json
> call -X POST $API/hooks/payos/src_payos_main -H 'content-type: application/json' --data-binary @/tmp/payos.json
> ```
> Cách ký này giống `libs/providers/test/payos-sign.spec.ts` (`new PayOS({clientId, apiKey, checksumKey})` + `crypto.createSignatureFromObj`). Đơn giản hơn nữa: trang Playground của dashboard có sẵn nút ký PayOS (`apps/web/src/lib/hub/payos-sign`).

### 0.3 Kill worker không mất sự kiện (S0, BB-3)

```bash
$DC stop hub-worker
HUB_URL=$API PG_CONTAINER=$($DC ps -q postgres) SMOKE_TIMEOUT_S=3 bash scripts/e2e-smoke.sh   # sẽ báo chưa xong: đúng, worker đang tắt
q "select count(*) from hub.outbox where published_at is null"        # > 0: sự kiện nằm chờ trong outbox
$DC start hub-worker; sleep 15
q "select status, count(*) from hub.deliveries group by status"      # không còn PENDING treo
```

✅ Khi worker tắt, outbox có dòng chờ. Bật lại thì mọi delivery thành `SUCCEEDED`, không mất event nào.

---

## 3. Chặng A: chạy khi agent báo "xong chặng A"

> Trước khi chạy: đọc DINH-CHINH §7 cho S1–S7, S10. Tên route bên dưới theo SPEC §4.3.

### A1. Project và key — H1 (T1)

```bash
call -X POST $API/api/v1/projects -H "$H" -H 'content-type: application/json' -d '{"slug":"cafe","name":"Cafe","environment":"test"}'
PA=$(curl -s $API/api/v1/projects -H "$H" | jget '.find?.(p=>p.slug==="cafe")?.id ?? .items.find(p=>p.slug==="cafe").id')
call -X POST $API/api/v1/projects -H "$H" -H 'content-type: application/json' -d '{"slug":"bookstore","name":"Bookstore","environment":"live"}'
PB=$(curl -s $API/api/v1/projects -H "$H" | jget '.find?.(p=>p.slug==="bookstore")?.id ?? .items.find(p=>p.slug==="bookstore").id')
call -X POST $API/api/v1/projects -H "$H" -H 'content-type: application/json' -d '{"slug":"cafe","name":"trùng"}'

R=$(curl -s -X POST $API/api/v1/projects/$PA/keys -H "$H" -H 'content-type: application/json' \
  -d '{"serviceName":"cafe-be","scopes":["publish:events","read:events","manage:endpoints","manage:sources"]}')
echo "$R"; KA=$(echo "$R" | jget .key); KA_ID=$(echo "$R" | jget .id)
R=$(curl -s -X POST $API/api/v1/projects/$PB/keys -H "$H" -H 'content-type: application/json' \
  -d '{"serviceName":"book-be","scopes":["publish:events","read:events","manage:endpoints","manage:sources"]}')
KB=$(echo "$R" | jget .key)
call $API/api/v1/projects/$PA/keys -H "$H"
q "select key_prefix, length(key_hash) from hub.api_keys"
q "select action from hub.audit_logs where action like 'api_key.%'"
```

✅ Phải thấy:
- tạo `cafe` và `bookstore` → 201, tạo trùng `cafe` → **409**;
- `KA` bắt đầu `hk_test_`, `KB` bắt đầu `hk_live_` (theo môi trường của project);
- `connectionString` dạng `hub://hk_test_…@localhost:14000/cafe` (host là `HUB_PUBLIC_URL` của hubv);
- danh sách key **không có** trường `key` hay `keyHash`;
- SQL: hash dài **64**, không có key thô;
- audit có `api_key.created`.

❌ Danh sách key mà trả `key` thì key **lộ lần hai**. Lỗi bảo mật, chặn.

### A2. Cô lập giữa project — H2 (T2, cốt lõi demo)

```bash
call $API/v1/p/cafe/me      -H "Authorization: Bearer $KA"     # 200
call $API/v1/p/bookstore/me -H "Authorization: Bearer $KA"     # 404 {"error":"not_found"}
call $API/v1/p/khongco/me   -H "Authorization: Bearer $KA"     # 404, body Y HỆT dòng trên
call $API/v1/p/cafe/me      -H "Authorization: Bearer hk_test_sai"   # 401
call $API/v1/p/cafe/me                                                # 401
```

✅ Hai dòng 404 phải có **body giống hệt từng ký tự**. Khác nhau dù một chữ là hub đang lộ "project bookstore có tồn tại".
Phần "key cafe đụng endpoint của bookstore → 404" chạy sau A4 (cần `EB`).

### A3. Scope — H3 (T3)

```bash
KR=$(curl -s -X POST $API/api/v1/projects/$PA/keys -H "$H" -H 'content-type: application/json' \
  -d '{"serviceName":"chi-doc","scopes":["read:events"]}' | jget .key)
call -X POST $API/v1/p/cafe/events -H "Authorization: Bearer $KR" -H 'content-type: application/json' \
  -d '{"type":"order.created","data":{},"idempotencyKey":"x1"}'
call -X POST $API/api/v1/projects/$PA/keys -H "$H" -H 'content-type: application/json' -d '{"serviceName":"rong","scopes":[]}'
```

✅ Dòng đầu **403** `{"error":"missing_scope","required":"publish:events"}`. Dòng hai **422**.

### A4. Endpoint và challenge — H4 (T4)

```bash
curl -s -X DELETE $SINK/_requests >/dev/null
R=$(curl -s -X POST $API/v1/p/cafe/endpoints -H "Authorization: Bearer $KA" -H 'content-type: application/json' \
  -d "{\"name\":\"sink-ok\",\"url\":\"$SINK_IN/cafe\"}"); echo "$R"
EA=$(echo "$R" | jget .id); SECA=$(echo "$R" | jget .signingSecret)
R=$(curl -s -X POST $API/v1/p/cafe/endpoints -H "Authorization: Bearer $KA" -H 'content-type: application/json' \
  -d "{\"name\":\"sink-hong\",\"url\":\"$SINK_IN/hong?mode=fail\"}"); echo "$R"; EH=$(echo "$R" | jget .id)
call -X POST $API/v1/p/cafe/endpoints -H "Authorization: Bearer $KA" -H 'content-type: application/json' \
  -d '{"name":"ssrf","url":"http://169.254.169.254/latest/meta-data"}'
R=$(curl -s -X POST $API/v1/p/bookstore/endpoints -H "Authorization: Bearer $KB" -H 'content-type: application/json' \
  -d "{\"name\":\"book\",\"url\":\"$SINK_IN/book\"}"); EB=$(echo "$R" | jget .id); SECB=$(echo "$R" | jget .signingSecret)
curl -s "$SINK/_requests?path=/cafe" | jget '.map(r=>r.headers["webhook-id"])'
call -X POST $API/v1/p/cafe/endpoints/$EB/verify -H "Authorization: Bearer $KA"   # bổ sung A2: key cafe đụng endpoint bookstore
```

✅ Phải thấy:
- `sink-ok`: 201, `verification: VERIFIED`, `signingSecret` bắt đầu `whsec_`, vì mình không truyền nên hub tự sinh;
- `sink-hong`: vẫn **201**, nhưng `FAILED`, `verificationError: http_500`;
- `ssrf`: `FAILED ssrf_blocked`, hoặc 422. Ghi lại hub làm cách nào;
- sink nhận request challenge có `webhook-id` bắt đầu `verify_`;
- dòng cuối **404**.

❌ `sink-ok` mà FAILED `ssrf_blocked` thì hubv đang chặn IP nội bộ của mạng docker. Báo agent: `hubv` cần cho phép IP private (`NODE_ENV=development`, `ssrf.ts`). Đó là cấu hình stack, không phải lỗi logic.

### A5. Subscription: wildcard, nguồn, chặn vượt project — H5 (T5)

```bash
call -X POST $API/v1/p/cafe/subscriptions -H "Authorization: Bearer $KA" -H 'content-type: application/json' \
  -d "{\"endpointId\":\"$EA\",\"name\":\"orders\",\"eventTypes\":[\"order.*\"]}"                 # 201
call -X POST $API/v1/p/cafe/subscriptions -H "Authorization: Bearer $KA" -H 'content-type: application/json' \
  -d "{\"endpointId\":\"$EB\",\"name\":\"x\",\"eventTypes\":[\"order.*\"]}"                      # 404
call -X POST $API/v1/p/cafe/subscriptions -H "Authorization: Bearer $KA" -H 'content-type: application/json' \
  -d "{\"endpointId\":\"$EA\",\"name\":\"x\",\"eventTypes\":[\"*.paid\"]}"                       # 422
call -X POST $API/v1/p/cafe/subscriptions -H "Authorization: Bearer $KA" -H 'content-type: application/json' \
  -d "{\"endpointId\":\"$EA\",\"name\":\"x\",\"eventTypes\":[\"order.*\"],\"sourceIds\":[\"00000000-0000-0000-0000-000000000000\"]}"  # 422 unknown_source
call -X POST $API/v1/p/bookstore/subscriptions -H "Authorization: Bearer $KB" -H 'content-type: application/json' \
  -d "{\"endpointId\":\"$EB\",\"name\":\"orders\",\"eventTypes\":[\"order.*\"]}"                 # 201
# Lưới cuối ở DB: chèn thẳng subscription của cafe trỏ sang endpoint bookstore
q "insert into hub.subscriptions (id, tenant_id, destination_id, name, event_types) values (gen_random_uuid(), '$PA', '$EB', 'lach', '{order.*}')"
```

✅ Bốn lệnh đầu đúng như comment (X1: `*` đứng một mình **hợp lệ**, `*.paid` thì 422 ở `/v1/p`). Lệnh SQL cuối bị **DB từ chối** (lỗi khoá ngoại).
❌ SQL chèn được thì "chặn vượt project" chỉ là code kiểm, chưa phải ràng buộc DB.

### A6. Publish, push có chữ ký, chống trùng — H6, H7 (T6)

```bash
curl -s -X DELETE $SINK/_requests >/dev/null
call -X POST $API/v1/p/cafe/events -H "Authorization: Bearer $KA" -H 'content-type: application/json' \
  -d '{"type":"order.created","data":{"total":45000},"idempotencyKey":"ord-1"}'      # 202
call -X POST $API/v1/p/cafe/events -H "Authorization: Bearer $KA" -H 'content-type: application/json' \
  -d '{"type":"order.created","data":{"total":45000},"idempotencyKey":"ord-1"}'      # 200 {"duplicate":true}
sleep 5
curl -s "$SINK/_requests?path=/cafe" | jget '.filter(r=>!r.headers["webhook-id"].startsWith("verify_")).length'   # 1
curl -s "$SINK/_requests?path=/book" | jget '.filter(r=>!r.headers["webhook-id"].startsWith("verify_")).length'   # 0
verify_sig "$SECA" /cafe
call -X POST $API/v1/p/cafe/events -H "Authorization: Bearer $KA" -H 'content-type: application/json' -d '{"type":"Order","data":{},"idempotencyKey":"a"}'   # 422
call -X POST $API/v1/p/cafe/events -H "Authorization: Bearer $KA" -H 'content-type: application/json' -d '{"type":"order.created","data":{}}'             # 422
call -X POST $API/hooks/api/api_$KA_ID -H 'content-type: application/json' -d '{}'                                                                  # 401
```

✅ Phải thấy:
- lần đầu 202, lần hai 200 `duplicate:true`;
- sink `/cafe` nhận **đúng 1** request, sink `/book` nhận **0**;
- `verify_sig` in ra `✅ chữ ký Standard Webhooks ĐÚNG | … | header x-hub-*: không có`.

Dòng `verify_sig` là bằng chứng mạnh nhất của H7: chữ ký được kiểm bằng **code của anh**, theo chuẩn công khai, không dùng gì của hub.

### A7. Endpoint chưa chứng minh thì không nhận — H4 (T7)

```bash
call -X POST $API/v1/p/cafe/subscriptions -H "Authorization: Bearer $KA" -H 'content-type: application/json' \
  -d "{\"endpointId\":\"$EH\",\"name\":\"hong\",\"eventTypes\":[\"order.*\"]}"
call -X POST $API/v1/p/cafe/events -H "Authorization: Bearer $KA" -H 'content-type: application/json' -d '{"type":"order.created","data":{},"idempotencyKey":"ord-2"}'
sleep 5; q "select count(*) from hub.deliveries where destination_id='$EH'"        # 0
```

✅ **0** delivery cho endpoint FAILED. (Muốn thấy chiều ngược lại: tạo endpoint mới trỏ `$SINK_IN/hong2` (không có `mode=fail`) → VERIFIED → publish `ord-3` → có delivery.)

### A8. Polling: endpoint chết thì tự lấy lại — H8 (T8)

```bash
call "$API/v1/p/cafe/events?after=0&limit=2" -H "Authorization: Bearer $KA"            # seq tăng, nextCursor là CHUỖI
call "$API/v1/p/cafe/events?after=0&types=order.*" -H "Authorization: Bearer $KA"      # chỉ order.*
call "$API/v1/p/cafe/events?after=0" -H "Authorization: Bearer $KB"                    # 404
call "$API/v1/p/bookstore/events?after=0" -H "Authorization: Bearer $KB"               # không có event nào của cafe

# Long-poll: lệnh dưới CHỜ; trong 10s mở terminal khác publish ord-9
CUR=$(curl -s "$API/v1/p/cafe/events?after=0&limit=1000" -H "Authorization: Bearer $KA" | jget .nextCursor)
time curl -s "$API/v1/p/cafe/events?after=$CUR&wait=10" -H "Authorization: Bearer $KA"
time curl -s "$API/v1/p/cafe/events?after=$CUR&wait=3"  -H "Authorization: Bearer $KA"   # không ai publish: rỗng sau ~3s
```

**Kịch bản "endpoint chết" (điều kiện của Sally):**

```bash
$DC stop sink
for i in 20 21 22 23 24; do curl -s -o /dev/null -X POST $API/v1/p/cafe/events -H "Authorization: Bearer $KA" \
  -H 'content-type: application/json' -d "{\"type\":\"order.created\",\"data\":{\"n\":$i},\"idempotencyKey\":\"ord-$i\"}"; done
sleep 20
call "$API/v1/p/cafe/events?after=0&status=failed&endpointId=$EA" -H "Authorization: Bearer $KA"
$DC start sink
```

✅ Phải thấy:
- phân trang không lặp, không sót;
- long-poll trả `ord-9` sau khoảng **2–4s** (cửa sổ lắng 2s cộng thời gian normalize);
- `status=failed` trả **đúng 5** event `ord-20..24`, không lẫn event đã gửi thành công.

Đây là câu trả lời cho "service của tôi sập một tiếng thì sao?".

### A9. Redis chết, hub chậm chứ không sai (BB-2, T14.5)

```bash
$DC stop redis
call -X POST $API/v1/p/cafe/events -H "Authorization: Bearer $KA" -H 'content-type: application/json' -d '{"type":"order.created","data":{},"idempotencyKey":"ord-r"}'   # 202
call -X POST $API/v1/p/cafe/events -H "Authorization: Bearer $KA" -H 'content-type: application/json' -d '{"type":"order.created","data":{},"idempotencyKey":"ord-r"}'   # 200 duplicate
$DC start redis
q "select count(*) from hub.raw_events where idempotency_key like '%ord-r'"     # 1
```

✅ Vẫn 202 rồi `duplicate`, DB chỉ có **1** dòng. Postgres là trọng tài, không phải Redis.

### A10. Timeout cấu hình được (S10)

```bash
grep -n DELIVERY_TIMEOUT_MS .env.verify docker-compose.verify.yml apps/hub-worker/src -r | head
```

✅ Worker đọc `DELIVERY_TIMEOUT_MS` (kẹp trong 1000–10000). Phần đo noisy neighbor (T10) là **L4**: chạy riêng khi cần số cho báo cáo, không thuộc kịch bản này.

---

## 4. Chặng B: chạy khi agent báo "xong chặng B"

> Đọc DINH-CHINH §7 cho S8, S9, S14, S11, S12 trước.

### B1. Ngân hàng không có adapter — H9 (T9)

```bash
R=$(curl -s -X POST $API/v1/p/cafe/sources -H "Authorization: Bearer $KA" -H 'content-type: application/json' -d '{
  "provider":"generic","name":"AB Bank (giả)","secret":"bank_secret_123",
  "verificationConfig":{"scheme":"hmac-sha256","header":"x-signature","encoding":"hex",
    "idempotency":{"field":"transactionId"},"eventType":"bank.transaction.received"}}'); echo "$R"
URL_G=$(echo "$R" | jget .webhookUrl); SRC_G=$(echo "$R" | jget .id)
BODY='{"transactionId":"TX1","soTien":50000}'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac bank_secret_123 | awk '{print $NF}')
call $API$URL_G -H 'content-type: application/json' -H "x-signature: $SIG" --data-raw "$BODY"          # 200
call $API$URL_G -H 'content-type: application/json' -H "x-signature: $SIG" --data-raw "$BODY"          # 200 duplicate
call $API$URL_G -H 'content-type: application/json' -H "x-sig: $SIG"       --data-raw "$BODY"          # 401
call $API$URL_G -H 'content-type: application/json' -H "x-signature: $SIG" --data-raw '{"soTien":1}'  # 401
B2='{"soTien":1}'; S2=$(printf '%s' "$B2" | openssl dgst -sha256 -hmac bank_secret_123 | awk '{print $NF}')
call $API$URL_G -H 'content-type: application/json' -H "x-signature: $S2"  --data-raw "$B2"            # 422 missing_idempotency_key
R=$(curl -s "$API/v1/p/cafe/sources/$SRC_G/inspect?since=2000-01-01T00:00:00Z" -H "Authorization: Bearer $KA"); echo "$R"
echo "$R" | grep -c -e "$SIG" -e bank_secret_123            # PHẢI = 0
```

✅ Phải thấy:
- `inspect` có dòng `reason:"ok"`, dòng `missing_header` kèm `candidateHeaders:["x-sig"]`, dòng `signature_mismatch` và dòng `missing_idempotency_key`;
- dòng `grep` cuối ra **0**: không lộ chữ ký hay secret.

Đây là "chế độ lắng nghe": dev của ngân hàng biết **vì sao** request của mình bị từ chối mà không phải hỏi ai.

### B2. Vào nhiều kiểu, ra một kiểu, kể cả nguồn lạ — H10 (T15)

```bash
curl -s -X DELETE $SINK/_requests >/dev/null
call -X POST $API/v1/p/cafe/subscriptions -H "Authorization: Bearer $KA" -H 'content-type: application/json' \
  -d "{\"endpointId\":\"$EA\",\"name\":\"pay\",\"eventTypes\":[\"payment.received\"]}"
# 1) PayOS và SePay vào source của cafe (dùng source mà seed S12 tạo cho cafe; xem DINH-CHINH §7 cho sourceKey + secret)
# 2) Source AB Bank có mapping (SPEC §4.14.4), bắn body {soTien:50000,...} ký đúng
sleep 5
curl -s "$SINK/_requests?path=/cafe" | jget '.filter(r=>r.body.includes("payment.received")).map(r=>{const b=JSON.parse(r.body);const d={...(b.data??b.event?.data)};delete d.raw;return Object.keys(d).sort().join(",")})'
call -X POST $API/v1/p/cafe/events -H "Authorization: Bearer $KA" -H 'content-type: application/json' \
  -d '{"type":"payment.received","data":{"amount":1},"idempotencyKey":"bad-1"}'     # 422 schema_mismatch
```

✅ Phải thấy:
- danh sách cuối có **3 chuỗi giống hệt nhau** (PayOS, SePay, AB Bank), cả ba `normalized:true`, `amount` = 50000;
- `orderCode` chỉ nằm dưới `data.raw`;
- publish sai khuôn → **422**.

Mở `apps/shop/src/main.ts` cho thấy **một** hàm xử lý thanh toán, không có `if` theo provider.

### B3. Shop là service thật (T11)

```bash
npm run verify:reset
$DC logs shop | grep -i verified                                  # "endpoint VERIFIED"
q "select name, url, verification from hub.destinations where url like '%hub-webhook%'"
grep -c "" apps/shop/src/main.ts                                  # ≤ 300
grep -n "x-hub-\|transferAmount" apps/shop/src/main.ts            # không có kết quả
call -X POST http://localhost:14001/hub-webhook -H 'content-type: application/json' -d '{"type":"endpoint.verification","challenge":"x"}'   # 401: challenge không chữ ký
```

✅ Endpoint của Shop do **Shop tự đăng ký** qua SDK sau khi khởi động. Seed **không** tạo (X6), chỉ có một dòng VERIFIED. Challenge giả không chữ ký → 401. Sau đó chạy lại 0.1 (smoke): đơn PAID đúng một lần.

### B4. Revoke key chỉ ngắt đúng một service (T12)

```bash
KA2=$(curl -s -X POST $API/api/v1/projects/$PA/keys -H "$H" -H 'content-type: application/json' -d '{"serviceName":"cafe-be-2","scopes":["read:events"]}' | jget .key)
call -X DELETE $API/api/v1/projects/$PA/keys/$KA_ID -H "$H"      # 204
call -X DELETE $API/api/v1/projects/$PA/keys/$KA_ID -H "$H"      # 204 lần nữa
call $API/v1/p/cafe/me -H "Authorization: Bearer $KA"            # 401
call $API/v1/p/cafe/me -H "Authorization: Bearer $KA2"           # 200
call $API/v1/p/bookstore/me -H "Authorization: Bearer $KB"       # 200
```

✅ Như comment. Endpoint `EA` (tạo bằng KA) **vẫn nhận** push, vì endpoint thuộc project chứ không thuộc key. Ghi hành vi này vào bảng kết quả.

### B5. Retention (T13, theo DINH-CHINH §3)

```bash
q "update hub.events set received_at = now() - interval '9 days' where id in (select id from hub.events order by received_at limit 3) returning id"
# kích cleanup: đặt CLEANUP_INTERVAL_MS ngắn cho hubv hoặc dùng lệnh agent ghi ở DINH-CHINH §7
q "select count(*) from hub.raw_events r where r.status='ACCEPTED' and not exists (select 1 from hub.events e where e.raw_event_id=r.id)"
```

✅ 3 event cũ và delivery của chúng **biến mất**. `raw_events` ACCEPTED **vẫn còn** (ADR-045: bằng chứng gốc giữ vô hạn). Banner "orphans" trên dashboard **không** báo động vì các raw cũ đó.

### B6. Seed demo S12

```bash
npm run verify:reset
q "select slug, environment from hub.projects order by slug"
```

✅ Có `cafe`, `bookstore` (và `default`, `demo` nếu `verify:seed` thêm). Mỗi project có source, key, endpoint mock theo `docs/DEMO-MULTI-PROJECT.md`. Đọc file đó và làm theo đúng từng chữ: một người lạ phải chạy được.

### B7. Hồi quy cuối (T14)

```bash
HUB_URL=$API PG_CONTAINER=$($DC ps -q postgres) bash scripts/e2e-smoke.sh   # OK (smoke đã sửa theo X10: không còn x-hub-*)
npm run verify                                                               # khi VF2 có: L0/L1/L2 xanh, skip = 0
```

Mở dashboard `http://localhost:13000` (cần `VERIFY_WITH_WEB=1`, hoặc dùng web của stack dev nếu agent hướng dẫn): trang Overview, Events, Subscriptions không vỡ.

---

## 5. Khi một bước đỏ

1. Chép **nguyên văn** lệnh + output vào cột "Ghi chú" ở §6.
2. Đối chiếu DINH-CHINH §7. Nếu agent đã ghi "lệch có chủ đích" (tên trường hay mã lỗi khác) thì đó **không phải lỗi**: sửa lệnh trong file này cho khớp.
3. Còn lại là lỗi: báo phiên dev kèm đúng mã bước (ví dụ `A2: hai body 404 khác nhau`).
4. Đỏ ở 0.1, A2, A6 (`verify_sig`), A8, A9 hoặc B2 nghĩa là **lời hứa cốt lõi bị phá**, chặn demo.

---

## 6. Kết quả (Admin điền)

| Bước | Lời hứa | PASS/FAIL | Ghi chú (output, lệch) | Ngày |
|---|---|---|---|---|
| 0.1 | hồi quy | | | |
| 0.2 | H10 (lõi) | | | |
| 0.3 | BB-3 | | | |
| A1 | H1 | | | |
| A2 | H2 | | | |
| A3 | H3 | | | |
| A4 | H4 | | | |
| A5 | H5 | | | |
| A6 | H6, H7 | | | |
| A7 | H4 | | | |
| A8 | H8 | | | |
| A9 | BB-2 | | | |
| A10 | S10 | | | |
| B1 | H9 | | | |
| B2 | H10 | | | |
| B3 | S11 | | | |
| B4 | T12 | | | |
| B5 | retention | | | |
| B6 | S12 | | | |
| B7 | hồi quy | | | |
