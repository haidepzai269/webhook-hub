# Kịch bản Admin tự test: hub đã thật sự là đa service chưa?

> **Đường dẫn:** `_bmad-output/planning-artifacts/verification/KICH-BAN-TEST-DA-SERVICE.md`
> **Ngày viết:** 2026-10-10 tối · **Đối route với code thật:** 2026-10-11 · **Người chạy:** Admin, tự tay, trên Git Bash.
> **Viết theo:**
> - `SPEC-hub-multi-service.md` S0–S14;
> - `DINH-CHINH-2026-10-10.md` §00 (bảng X1–X14), §7 + §7b (route/trường/mã lỗi thật do dev ghi, X12). File đó **thắng** SPEC;
> - code thật ở HEAD `9f14d54` (đa service S1–S12 + sửa MS-R*/MS-P2-*, auth AU1–AU6, DX3 `after=latest`).
>
> **Spec gốc của mỗi bước** là mã `T*` ở SPEC đa service §7.2. File này viết lại cho **người** chạy: mỗi bước có *làm gì*, *phải thấy gì*, và *nếu sai thì nghĩa là gì*.

> ### Trạng thái đối route (2026-10-11)
>
> **Đã CHẠY thật trên `hubv` đang sống** (image hub-api build 2026-10-11 14:03, cũ hơn HEAD vài commit DX3), project test riêng `cafe-<RUN>` / `book-<RUN>`, không reset, không dừng container nào:
> đăng nhập cookie + CSRF (`/auth/login`, thiếu CSRF → 403 `csrf_failed`) · **A1** (201/201/409 `slug_taken`, `hk_test_`/`hk_live_`, `connectionString`, list key không có `key`, hash 64, audit) · **A2** (200/404/404/401/401, hai 404 giống hệt cả header) · **A3** (403 `missing_scope`, 422 scopes rỗng, 422 `scope_not_grantable`) · **A4** (VERIFIED + `whsec_`, `http_500`, `ssrf_blocked` vẫn 201, challenge `verify_…`, 404) · **A5** (201/404/422/422 `unknown_source`; FK ghép kiểm bằng `\d`, **không** chèn thử) · **A6** (202/200 duplicate, sink 1/0, `verify_sig` ĐÚNG, không `x-hub-*`, 422/422, `/hooks/api` 401) · **A7** (0 delivery cho endpoint FAILED) · **A8** phần polling + long-poll (không chạy phần "endpoint chết") · **B1** (200/200 duplicate/401/401/422, inspect đủ 4 lý do, grep = 0) · **B2** (SePay + PayOS + AB Bank mapping vào CÙNG một project test → 3 chuỗi khoá giống hệt, `amount=50000`; publish sai khuôn 422) · **B3** phần challenge không chữ ký → 401 và subscription của Shop · **B4** (204/204/401/200/200).
>
> **Chỉ ĐỌC CODE, chưa chạy:** 0.1–0.3 (smoke + kill worker), A8 "endpoint chết" (`stop sink`), A9 (`stop redis`), A10, B3 phần `verify:reset`, B5 (retention), B6, B7, và toàn bộ §7 production (chỉ chạy GET không xác thực: `/health`, `/login`, `/products`, `/v1/p/khongco/me` → 401, `/api/v1/projects` → 401 qua cả hub lẫn proxy web). Lý do: hai agent dev đang dùng `hubv` (một bên chạy chaos), không được reset/dừng gì.
>
> **Khác image đang chạy vs HEAD:** `after=latest` và `after=<rác>` → **400 `invalid_cursor`** là code HEAD (DX3, `fc40e29`); image `hubv` lúc đối route còn trả 422 và chưa hiểu `latest`. Sau `npm run verify:reset` (build lại) thì đúng như file này.

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

Chặng A và B đã xong code (DINH-CHINH §7, §7b). Cả file chạy được trên `hubv` dựng từ HEAD.

---

## 1. Chuẩn bị (mỗi lần test)

```bash
cd /c/webhook-hub
npm run verify:reset          # xoá sạch hubv rồi dựng lại + seed (~1–2 phút; lần đầu build 5–8 phút)
npm run verify:ps             # mọi service "running"/"healthy", có cả "sink"
# muốn có dashboard (B7): VERIFY_WITH_WEB=1 npm run verify:reset   -> http://localhost:13000
```

> Stack `hubv` **tách biệt** với stack dev (cổng +10000). Anh muốn kill, xoá gì trên `hubv` cũng được. **Không** đụng stack dev `webhook-hub` khi agent đang làm.
> **Nếu agent khác đang dùng `hubv`** thì đừng `verify:reset` và bỏ qua các bước có `$DC stop/restart` (0.3, A8 phần cuối, A9, B5). Mọi bước còn lại tự đặt tên theo `RUN` nên chạy chồng lên dữ liệu có sẵn vẫn được.

Dán khối này vào terminal. Mọi bước sau dùng các hàm/biến này:

```bash
export MSYS_NO_PATHCONV=1           # Git Bash: KHÔNG đổi "/a-123" thành "C:/Program Files/Git/a-123" khi truyền cho node/docker
API=http://localhost:14000          # hub-api của hubv
SINK=http://localhost:14100         # "service của dev" giả ở đầu nhận (tools/verify-sink)
SINK_IN=http://sink:4100            # địa chỉ hub-worker dùng để gọi sink (trong mạng docker)
SHOP=http://localhost:14001         # shop của hubv
DC="docker compose -p hubv -f docker-compose.yml -f docker-compose.verify.yml --env-file .env.verify"
CT='content-type: application/json'
RUN=$(date +%s)                     # hậu tố cho slug/đường dẫn sink: chạy lại nhiều lần không đụng nhau
SA=cafe-$RUN; SB=book-$RUN          # hai project test (seed đã có sẵn "cafe"/"bookstore" -> không dùng tên đó)

# Lấy một trường JSON: echo '{"a":{"b":1}}' | jget .a.b
jget() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s);const v=eval("o"+process.argv[1]);console.log(typeof v==="object"?JSON.stringify(v):v)})' "$1"; }
# SQL trên Postgres của hubv (chỉ đọc là chính)
q() { $DC exec -T postgres psql -U hub_user -d webhook_hub -tA -F ' | ' -c "$1"; }
# Gọi API in kèm mã HTTP ở dòng cuối
call() { curl -s -w '\n→ HTTP %{http_code}\n' "$@"; }

# Đăng nhập console (AU1, SPEC-auth §5.3/§5.4): POST /auth/login {email,password} -> 3 cookie:
#   __Host-hub_at (access, 15 phút) · __Host-hub_rt (refresh) · hub_csrf (đọc được).
# Route console cần cookie; POST/PATCH/DELETE cần thêm header x-csrf-token = giá trị cookie hub_csrf.
# Không dùng cookie jar của curl: cookie __Host-/Secure trên http://localhost curl có thể bỏ -> ghép tay header Cookie.
login() {
  local hdr; hdr=$(curl -s -D - -o /dev/null "$API/auth/login" -H "$CT" \
    -d '{"email":"operator@verify.local","password":"VERIFY_ONLY_admin_password"}' | tr -d '\r')
  COOKIE=$(printf '%s\n' "$hdr" | grep -i '^set-cookie:' | sed -E 's/^[Ss]et-[Cc]ookie: ([^;]+);.*/\1/' | paste -sd ';' -)
  CSRF=$(printf '%s\n' "$COOKIE" | tr ';' '\n' | sed -n 's/^ *hub_csrf=//p')
  H=(-H "Cookie: $COOKIE" -H "x-csrf-token: $CSRF")
  echo "CSRF: ${CSRF:0:12}…"
}
login
call $API/auth/me "${H[@]}"
```

✅ In ra `CSRF: …` (không rỗng) và `/auth/me` → 200 `{"user":{"email":"operator@verify.local",…,"emailVerified":true},"memberships":[…]}`. CSRF rỗng nghĩa là đăng nhập hỏng (sai mật khẩu → 401; gọi dồn → 429 kèm `Retry-After`), dừng lại.
⚠ Cookie access sống **15 phút**. Gặp `401 {"error":"session_expired"}` ở route console thì gõ lại `login`. Route console dùng `"${H[@]}"` (mảng, có ngoặc kép), **không** còn `Authorization: Bearer` cho người.

**Kiểm chữ ký độc lập.** Đoạn này đóng vai **dev bên ngoài**: dùng `crypto` của Node, **không** dùng code hay SDK của hub. Dán khi cần:

```bash
verify_sig() {  # verify_sig <signingSecret> <path trên sink, vd /a-$RUN>
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

> Sink giữ request trong bộ nhớ, đọc lại bằng `GET $SINK/_requests?path=/x`. File này dùng đường dẫn riêng theo `RUN` (`/a-$RUN`, `/b-$RUN`, `/hong-$RUN`) nên **không cần** `DELETE $SINK/_requests` (lệnh đó xoá cả request của người khác đang dùng sink).

---

## 2. Chặng 0: hồi quy nền

> Phần đa service đã có sẵn từ SPEC-3: S0 (outbox), lõi S14, wildcard.

### 0.1 Luồng cũ còn sống (S0, hồi quy)

```bash
# X15(4): smoke đọc secret từ env, rỗng thì đọc .env của stack DEV (sai secret) -> export từ .env.verify trước
export $(grep -E '^(HUB_SIGNING_SECRET|GITHUB_WEBHOOK_SECRET|DEMO_SEPAY_APIKEY)=' .env.verify | xargs)
HUB_URL=$API PG_CONTAINER=$($DC ps -q postgres) bash scripts/e2e-smoke.sh
```

✅ Bảng events × deliveries, dòng cuối `OK`, exit 0. Nếu đỏ thì đừng chạy tiếp: nền đã hỏng.
(Smoke bắn SePay → `payment.received` khớp subscription Telegram của seed; trên `hubv` Telegram/Discord trỏ `/mock/*` của chính hub-api nên không gửi gì ra ngoài.)

### 0.2 Vào nhiều kiểu, ra một kiểu (lõi S14) — H10

Smoke vừa bắn **SePay**. Bắn thêm **PayOS** cùng số tiền vào source `src_payos_main` của project `default`, rồi so hai event:

```bash
PAYOS=$(node -e '
const {PayOS}=require("@payos/node");const k=process.argv[1];const p=new PayOS({clientId:"x",apiKey:"x",checksumKey:k});
const data={orderCode:Number(process.argv[2])%1e9,amount:10000,description:"TEST",accountNumber:"0",reference:"R"+process.argv[2],transactionDateTime:"2026-10-10 10:00:00",currency:"VND",paymentLinkId:"x",code:"00",desc:"success",counterAccountBankId:"",counterAccountBankName:"",counterAccountName:"",counterAccountNumber:"",virtualAccountName:"",virtualAccountNumber:""};
p.crypto.createSignatureFromObj(data,k).then(sig=>console.log(JSON.stringify({code:"00",desc:"success",success:true,data,signature:sig})));' VERIFY_ONLY_payos_checksum_key "$RUN")
call -X POST $API/hooks/payos/src_payos_main -H "$CT" --data-binary "$PAYOS"      # 200 {"code":"00","desc":"success",…}
sleep 5
q "select e.source, e.type, (select string_agg(k, ',' order by k) from jsonb_object_keys(e.data - 'raw') k) as keys,
          e.data->>'amount' as amount, e.normalized
   from hub.events e where e.type like 'payment.%' order by e.received_at desc limit 4"
```

✅ Mỗi provider (sepay, payos) có một dòng `payment.received`, cột `keys` **giống hệt nhau** (`account,amount,counterparty,currency,memo,method,paidAt,providerTxnId,reference`), `normalized = t`.
❌ `keys` khác nhau nghĩa là "ra một kiểu" chưa đúng. Đó là luận điểm chính của đề tài.

> Checksum `VERIFY_ONLY_payos_checksum_key` là `PAYOS_CHECKSUM_KEY` trong `.env.verify`. Cách ký giống `libs/providers/test/payos-sign.spec.ts` và `scripts/demo-multi-project.sh` (hồi 6). Body PayOS để trong biến, **không** ghi ra `/tmp/…` (curl của Git Bash không đọc được `/tmp` khi đã `MSYS_NO_PATHCONV=1`).

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

## 3. Chặng A

> Route, tên trường, mã lỗi dưới đây đã đối với code (DINH-CHINH §7 S1–S7, S10 và §7b). Console (`/api/v1/*`) dùng cookie + CSRF (`"${H[@]}"`); API service (`/v1/p/:project/*`) dùng `Authorization: Bearer hk_…`.

### A1. Project và key — H1 (T1)

```bash
call -X POST $API/api/v1/projects "${H[@]}" -H "$CT" -d "{\"slug\":\"$SA\",\"name\":\"Cafe test\",\"environment\":\"test\"}"
call -X POST $API/api/v1/projects "${H[@]}" -H "$CT" -d "{\"slug\":\"$SB\",\"name\":\"Book test\",\"environment\":\"live\"}"
call -X POST $API/api/v1/projects "${H[@]}" -H "$CT" -d '{"slug":"cafe","name":"trung"}'          # seed đã có "cafe"
call -X POST $API/api/v1/projects -H "Cookie: $COOKIE" -H "$CT" -d '{"slug":"thieu-csrf","name":"x"}'   # thiếu x-csrf-token
PA=$(curl -s $API/api/v1/projects "${H[@]}" | jget ".find(p=>p.slug===\"$SA\").id")
PB=$(curl -s $API/api/v1/projects "${H[@]}" | jget ".find(p=>p.slug===\"$SB\").id")

R=$(curl -s -X POST $API/api/v1/projects/$PA/keys "${H[@]}" -H "$CT" \
  -d '{"serviceName":"cafe-be","scopes":["publish:events","read:events","manage:endpoints","manage:sources"]}')
echo "$R"; KA=$(echo "$R" | jget .key); KA_ID=$(echo "$R" | jget .id)
R=$(curl -s -X POST $API/api/v1/projects/$PB/keys "${H[@]}" -H "$CT" \
  -d '{"serviceName":"book-be","scopes":["publish:events","read:events","manage:endpoints","manage:sources"]}')
KB=$(echo "$R" | jget .key)
call $API/api/v1/projects/$PA/keys "${H[@]}"
q "select key_prefix, length(key_hash) from hub.api_keys where tenant_id='$PA'"
q "select action from hub.audit_logs where tenant_id='$PA' order by created_at"
```

✅ Phải thấy:
- tạo `$SA` và `$SB` → **201** `{id,slug,name,environment,createdAt}`; tạo trùng `cafe` → **409** `{"error":"slug_taken",…}`; thiếu CSRF → **403** `{"error":"csrf_failed",…}`;
- `GET /api/v1/projects` trả **mảng** (có thêm `role`);
- tạo key → 201 `{id,serviceName,keyPrefix,scopes,readTypes,sourceId,createdAt,key,connectionString}`; `KA` bắt đầu `hk_test_`, `KB` bắt đầu `hk_live_` (theo môi trường của project);
- `connectionString` dạng `hub://hk_test_…@localhost:14000/cafe-<RUN>` (host là `HUB_PUBLIC_URL` của hubv);
- danh sách key **không có** trường `key` hay `keyHash` (chỉ `keyPrefix`);
- SQL: hash dài **64**, không có key thô;
- audit có `project.created`, `api_key.created`.

❌ Danh sách key mà trả `key` thì key **lộ lần hai**. Lỗi bảo mật, chặn.
> Tên tiếng Việt có dấu trong `-d '…'` có thể bị Git Bash đổi mã (thành `?`). Đó là terminal, không phải hub; dùng tên không dấu cho chắc.

### A2. Cô lập giữa project — H2 (T2, cốt lõi demo)

```bash
call $API/v1/p/$SA/me       -H "Authorization: Bearer $KA"     # 200 {project:{slug,name,environment},serviceName,scopes}
call $API/v1/p/$SB/me       -H "Authorization: Bearer $KA"     # 404 {"error":"not_found"}
call $API/v1/p/khongco/me   -H "Authorization: Bearer $KA"     # 404, body Y HỆT dòng trên
call $API/v1/p/$SA/me       -H "Authorization: Bearer hk_test_sai"   # 401 {"error":"invalid_api_key"}
call $API/v1/p/$SA/me                                                # 401 {"error":"invalid_api_key"}
# So cả header (trừ date/etag):
diff <(curl -s -D - $API/v1/p/$SB/me -H "Authorization: Bearer $KA" | tr -d '\r' | grep -vi '^date\|^etag') \
     <(curl -s -D - $API/v1/p/khongco/me -H "Authorization: Bearer $KA" | tr -d '\r' | grep -vi '^date\|^etag') && echo "GIỐNG HỆT"
```

✅ Hai dòng 404 phải có **body giống hệt từng ký tự**, `diff` in `GIỐNG HỆT`. Khác nhau dù một chữ là hub đang lộ "project kia có tồn tại".
Phần "key cafe đụng endpoint của bookstore → 404" chạy ở cuối A4 (cần `EB`).

### A3. Scope — H3 (T3)

```bash
KR=$(curl -s -X POST $API/api/v1/projects/$PA/keys "${H[@]}" -H "$CT" \
  -d '{"serviceName":"chi-doc","scopes":["read:events"]}' | jget .key)
call -X POST $API/v1/p/$SA/events -H "Authorization: Bearer $KR" -H "$CT" \
  -d '{"type":"order.created","data":{},"idempotencyKey":"x1"}'
call -X POST $API/api/v1/projects/$PA/keys "${H[@]}" -H "$CT" -d '{"serviceName":"rong","scopes":[]}'
call -X POST $API/api/v1/projects/$PA/keys "${H[@]}" -H "$CT" -d '{"serviceName":"leo","scopes":["manage:keys"]}'
```

✅ Dòng đầu **403** `{"error":"missing_scope","required":"publish:events"}`. Dòng hai **422** `{"error":"validation_failed","field":"scopes",…}`. Dòng ba **422** `{"error":"scope_not_grantable",…}` (scope của người không cấp cho máy, UA19).

### A4. Endpoint và challenge — H4 (T4)

```bash
R=$(curl -s -X POST $API/v1/p/$SA/endpoints -H "Authorization: Bearer $KA" -H "$CT" \
  -d "{\"name\":\"sink-ok\",\"url\":\"$SINK_IN/a-$RUN\"}"); echo "$R"
EA=$(echo "$R" | jget .id); SECA=$(echo "$R" | jget .signingSecret)
R=$(curl -s -X POST $API/v1/p/$SA/endpoints -H "Authorization: Bearer $KA" -H "$CT" \
  -d "{\"name\":\"sink-hong\",\"url\":\"$SINK_IN/hong-$RUN?mode=fail\"}"); echo "$R"; EH=$(echo "$R" | jget .id)
call -X POST $API/v1/p/$SA/endpoints -H "Authorization: Bearer $KA" -H "$CT" \
  -d '{"name":"ssrf","url":"http://169.254.169.254/latest/meta-data"}'
R=$(curl -s -X POST $API/v1/p/$SB/endpoints -H "Authorization: Bearer $KB" -H "$CT" \
  -d "{\"name\":\"book\",\"url\":\"$SINK_IN/b-$RUN\"}"); EB=$(echo "$R" | jget .id); SECB=$(echo "$R" | jget .signingSecret)
curl -s "$SINK/_requests?path=/a-$RUN" | jget '.map(r=>r.headers["webhook-id"])'
call -X POST $API/v1/p/$SA/endpoints/$EB/verify -H "Authorization: Bearer $KA"   # bổ sung A2: key cafe đụng endpoint bookstore
```

✅ Phải thấy:
- `sink-ok`: 201 `{id,name,url,verification:"VERIFIED",verificationError:null,verifiedAt,createdAt,signingSecret}`; `signingSecret` bắt đầu `whsec_` vì mình không truyền nên hub tự sinh (chỉ trả **một lần**);
- `sink-hong`: vẫn **201**, nhưng `verification:"FAILED"`, `verificationError:"http_500"`;
- `ssrf`: **201** với `FAILED`, `verificationError:"ssrf_blocked"` (169.254/16 bị chặn mọi môi trường). Hub **không** trả 422 ở đây;
- sink nhận request challenge có `webhook-id` bắt đầu `verify_`;
- dòng cuối **404** `{"error":"not_found"}`.

❌ `sink-ok` mà FAILED `ssrf_blocked` thì hubv đang chặn IP nội bộ của mạng docker. Báo agent: `hubv` cần cho phép IP private (`NODE_ENV=development`, `libs/crypto/src/ssrf.ts`). Đó là cấu hình stack, không phải lỗi logic.
> Lý do FAILED có thể gặp: `timeout`, `http_<status>`, `challenge_mismatch`, `ssrf_blocked`, `invalid_json`, `unreachable`. `/verify` tối đa 5 lần/phút/endpoint → 429 `rate_limited`. `/verify` và mọi thao tác endpoint chỉ áp dụng cho endpoint **do chính key đó tạo** (ADR-094): key khác cùng project cũng nhận 404.

### A5. Subscription: wildcard, nguồn, chặn vượt project — H5 (T5)

```bash
call -X POST $API/v1/p/$SA/subscriptions -H "Authorization: Bearer $KA" -H "$CT" \
  -d "{\"endpointId\":\"$EA\",\"name\":\"orders\",\"eventTypes\":[\"order.*\"]}"                 # 201
call -X POST $API/v1/p/$SA/subscriptions -H "Authorization: Bearer $KA" -H "$CT" \
  -d "{\"endpointId\":\"$EB\",\"name\":\"x\",\"eventTypes\":[\"order.*\"]}"                      # 404
call -X POST $API/v1/p/$SA/subscriptions -H "Authorization: Bearer $KA" -H "$CT" \
  -d "{\"endpointId\":\"$EA\",\"name\":\"x\",\"eventTypes\":[\"*.paid\"]}"                       # 422
call -X POST $API/v1/p/$SA/subscriptions -H "Authorization: Bearer $KA" -H "$CT" \
  -d "{\"endpointId\":\"$EA\",\"name\":\"x\",\"eventTypes\":[\"order.*\"],\"sourceIds\":[\"00000000-0000-0000-0000-000000000000\"]}"  # 422 unknown_source
call -X POST $API/v1/p/$SA/subscriptions -H "Authorization: Bearer $KA" -H "$CT" \
  -d "{\"endpointId\":\"$EA\",\"name\":\"x\",\"eventTypes\":[\"order.*\"],\"sourceKeys\":[\"src_sepay_cafe\"]}"            # 422: source của project KHÁC
call -X POST $API/v1/p/$SB/subscriptions -H "Authorization: Bearer $KB" -H "$CT" \
  -d "{\"endpointId\":\"$EB\",\"name\":\"orders\",\"eventTypes\":[\"order.*\"]}"                 # 201
# Lưới cuối ở DB: chèn thẳng subscription của cafe trỏ sang endpoint bookstore
q "insert into hub.subscriptions (id, tenant_id, destination_id, name, event_types) values (gen_random_uuid(), '$PA', '$EB', 'lach', '{order.*}')"
```

✅ Phải thấy:
- 201 trả `{id,name,endpointId,eventTypes,sourceIds,isActive,createdAt,sourceKeys}`;
- `EB` qua key cafe → **404** `{"error":"not_found"}`;
- `*.paid` → **422** `{"error":"validation_failed","field":"eventTypes","invalid":["*.paid"]}` (X1: `*` đứng một mình **hợp lệ**);
- `sourceIds` lạ → **422** `{"error":"unknown_source","ids":[…]}`; `sourceKeys` của project khác → **422** `{"error":"unknown_source","keys":[…]}`;
- lệnh SQL cuối bị **DB từ chối**: `violates foreign key constraint "subscriptions_destination_id_tenant_id_fkey"` (FK ghép `(destination_id, tenant_id)`).

❌ SQL chèn được thì "chặn vượt project" chỉ là code kiểm, chưa phải ràng buộc DB.
> Key có `readTypes` mà xin `eventTypes` rộng hơn → 422 `outside_read_types` (MS-R3).

### A6. Publish, push có chữ ký, chống trùng — H6, H7 (T6)

```bash
call -X POST $API/v1/p/$SA/events -H "Authorization: Bearer $KA" -H "$CT" \
  -d '{"type":"order.created","data":{"total":45000},"idempotencyKey":"ord-1"}'      # 202
call -X POST $API/v1/p/$SA/events -H "Authorization: Bearer $KA" -H "$CT" \
  -d '{"type":"order.created","data":{"total":45000},"idempotencyKey":"ord-1"}'      # 200 {"duplicate":true}
sleep 5
curl -s "$SINK/_requests?path=/a-$RUN" | jget '.filter(r=>!r.headers["webhook-id"].startsWith("verify_")).length'   # 1
curl -s "$SINK/_requests?path=/b-$RUN" | jget '.filter(r=>!r.headers["webhook-id"].startsWith("verify_")).length'   # 0
verify_sig "$SECA" /a-$RUN
curl -s "$SINK/_requests?path=/a-$RUN" | jget '.at(-1).body'                                                      # body Shop/dev nhận
call -X POST $API/v1/p/$SA/events -H "Authorization: Bearer $KA" -H "$CT" -d '{"type":"Order","data":{},"idempotencyKey":"a"}'   # 422
call -X POST $API/v1/p/$SA/events -H "Authorization: Bearer $KA" -H "$CT" -d '{"type":"order.created","data":{}}'             # 422
call -X POST $API/hooks/api/api_$KA_ID -H "$CT" -d '{}'                                                                       # 401
```

✅ Phải thấy:
- lần đầu **202** `{"eventId":null,"rawEventId":"…","duplicate":false}` (đã COMMIT, chưa normalize), lần hai **200** `{"duplicate":true}`;
- sink `/a-$RUN` nhận **đúng 1** request, sink `/b-$RUN` nhận **0**;
- `verify_sig` in ra `✅ chữ ký Standard Webhooks ĐÚNG | webhook-id: evt_… | header x-hub-*: không có`;
- body push phẳng: `{"id":"evt_…","type":"order.created","source":"api","sourceId":"…","normalized":true,"data":{"total":45000},"occurredAt":…,"receivedAt":…}`;
- `type` sai → 422 `field:"type"`; thiếu `idempotencyKey` → 422 `field:"idempotencyKey"`; gọi thẳng `/hooks/api/…` → 401.

Dòng `verify_sig` là bằng chứng mạnh nhất của H7: chữ ký được kiểm bằng **code của anh**, theo chuẩn công khai, không dùng gì của hub.
> Trần body thật là 100KB (body-parser) → 413, không phải 1MB/422 (§7 S4).

### A7. Endpoint chưa chứng minh thì không nhận — H4 (T7)

```bash
call -X POST $API/v1/p/$SA/subscriptions -H "Authorization: Bearer $KA" -H "$CT" \
  -d "{\"endpointId\":\"$EH\",\"name\":\"hong\",\"eventTypes\":[\"order.*\"]}"
call -X POST $API/v1/p/$SA/events -H "Authorization: Bearer $KA" -H "$CT" -d '{"type":"order.created","data":{},"idempotencyKey":"ord-2"}'
sleep 5
# deliveries không có cột destination_id: đi qua subscription
q "select count(*) from hub.deliveries d join hub.subscriptions s on s.id=d.subscription_id where s.destination_id='$EH'"   # 0
q "select d.status, count(*) from hub.deliveries d join hub.subscriptions s on s.id=d.subscription_id where s.destination_id='$EA' group by 1"  # SUCCEEDED | 2
```

✅ **0** delivery cho endpoint FAILED, endpoint VERIFIED thì có. (Muốn thấy chiều ngược lại: tạo endpoint mới trỏ `$SINK_IN/hong2-$RUN` (không có `mode=fail`) → VERIFIED → subscription → publish `ord-3` → có delivery.)

### A8. Polling: endpoint chết thì tự lấy lại — H8 (T8)

```bash
call "$API/v1/p/$SA/events?after=0&limit=1" -H "Authorization: Bearer $KA"            # mỗi event có "cursor" (CHUỖI), nextCursor là CHUỖI
call "$API/v1/p/$SA/events?after=0&types=order.*" -H "Authorization: Bearer $KA"       # chỉ order.*
call "$API/v1/p/$SA/events?after=0" -H "Authorization: Bearer $KB"                     # 404
call "$API/v1/p/$SB/events?after=0" -H "Authorization: Bearer $KB"                     # không có event nào của cafe
call "$API/v1/p/$SA/events?after=abc" -H "Authorization: Bearer $KA"                   # 400 invalid_cursor
call "$API/v1/p/$SA/events?after=latest" -H "Authorization: Bearer $KA"                # {"events":[],"nextCursor":"<cursor cuối>"}

# Long-poll: lệnh dưới CHỜ; trong 10s mở terminal khác publish ord-9 (nhớ dán lại khối §1 + KA, SA)
CUR=$(curl -s "$API/v1/p/$SA/events?after=latest" -H "Authorization: Bearer $KA" | jget .nextCursor)
time curl -s "$API/v1/p/$SA/events?after=$CUR&wait=10" -H "Authorization: Bearer $KA"
time curl -s "$API/v1/p/$SA/events?after=$CUR&wait=3"  -H "Authorization: Bearer $KA"   # không ai publish: rỗng sau ~3s
```

Mỗi event trả về: `{id,cursor,type,source,sourceId,subject,data,normalized,correlationId,occurredAt,receivedAt}`. `cursor` là thứ tự COMMIT (`poll_seq`, ADR-099), cố ý **không** gọi là `seq`. `wait` 0–20 giây; `limit` 1–100 (sai → 422 có `field`).

**Kịch bản "endpoint chết" (điều kiện của Sally):**

```bash
$DC stop sink
for i in 20 21 22 23 24; do curl -s -o /dev/null -X POST $API/v1/p/$SA/events -H "Authorization: Bearer $KA" \
  -H "$CT" -d "{\"type\":\"order.created\",\"data\":{\"n\":$i},\"idempotencyKey\":\"ord-$i\"}"; done
sleep 20
call "$API/v1/p/$SA/events?after=0&status=failed&endpointId=$EA&limit=100" -H "Authorization: Bearer $KA"
$DC start sink
```

✅ Phải thấy:
- phân trang không lặp, không sót;
- long-poll trả `ord-9` vài giây sau khi publish (đo trên hubv: ~1s sau publish; cửa sổ lắng 2s + normalize);
- `status=failed` trả **đúng 5** event `ord-20..24`, không lẫn event đã gửi thành công.

> `endpointId` phải là endpoint **do chính key gọi tạo** (ADR-094), không thì 404. `status` chỉ nhận `failed`.
> ⚠ `$DC stop sink` làm mọi người đang dùng sink mất challenge/push, chỉ chạy khi `hubv` là của riêng anh.

Đây là câu trả lời cho "service của tôi sập một tiếng thì sao?".

### A9. Redis chết, hub chậm chứ không sai (BB-2, T14.5)

```bash
$DC stop redis
time call -X POST $API/v1/p/$SA/events -H "Authorization: Bearer $KA" -H "$CT" -d '{"type":"order.created","data":{},"idempotencyKey":"ord-r"}'   # 202
time call -X POST $API/v1/p/$SA/events -H "Authorization: Bearer $KA" -H "$CT" -d '{"type":"order.created","data":{},"idempotencyKey":"ord-r"}'   # 200 duplicate
$DC start redis
q "select count(*) from hub.raw_events where idempotency_key='api:ord-r' and source_id=(select source_id from hub.api_keys where id='$KA_ID')"   # 1
```

✅ Vẫn 202 rồi `duplicate`, DB chỉ có **1** dòng (khoá idem của `/events` là `api:<idempotencyKey>`). Postgres là trọng tài, không phải Redis.
✅ Thêm: mỗi request vẫn **nhanh** (dưới 1s; ADR-090 `fastFailRedisOptions`, `REDIS_COMMAND_TIMEOUT_MS` 300). Chậm 8–18s là hồi quy MS-P2-3.

### A10. Timeout cấu hình được (S10)

```bash
grep -rn DELIVERY_TIMEOUT_MS .env.verify docker-compose.yml docker-compose.verify.yml apps/hub-worker/src | head
```

✅ `docker-compose.yml` truyền `DELIVERY_TIMEOUT_MS=${DELIVERY_TIMEOUT_MS:-5000}` cho worker; `apps/hub-worker/src/senders/http-limits.ts` `resolveSendTimeoutMs` kẹp trong 1000–10000. Phần đo noisy neighbor (T10) là **L4**: chạy riêng khi cần số cho báo cáo (số đã đo ở `docs/DEMO-MULTI-PROJECT.md` §5), không thuộc kịch bản này.

---

## 4. Chặng B

> Đối với DINH-CHINH §7 S8, S9, S14, S11, S12 và §7b.

### B1. Ngân hàng không có adapter — H9 (T9)

```bash
R=$(curl -s -X POST $API/v1/p/$SA/sources -H "Authorization: Bearer $KA" -H "$CT" -d '{
  "provider":"generic","name":"AB Bank (gia)","secret":"bank_secret_123",
  "verificationConfig":{"scheme":"hmac-sha256","header":"x-signature","encoding":"hex",
    "idempotency":{"field":"transactionId"},"eventType":"bank.transaction.received"}}'); echo "$R"
URL_G=$(echo "$R" | jget .webhookUrl); SRC_G=$(echo "$R" | jget .id)
BODY='{"transactionId":"TX1","soTien":50000}'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac bank_secret_123 | awk '{print $NF}')
call $API$URL_G -H "$CT" -H "x-signature: $SIG" --data-raw "$BODY"          # 200 {"ok":true}
call $API$URL_G -H "$CT" -H "x-signature: $SIG" --data-raw "$BODY"          # 200 {"ok":true,"duplicate":true}
call $API$URL_G -H "$CT" -H "x-sig: $SIG"       --data-raw "$BODY"          # 401
call $API$URL_G -H "$CT" -H "x-signature: $SIG" --data-raw '{"soTien":1}'  # 401
B2='{"soTien":1}'; S2=$(printf '%s' "$B2" | openssl dgst -sha256 -hmac bank_secret_123 | awk '{print $NF}')
call $API$URL_G -H "$CT" -H "x-signature: $S2"  --data-raw "$B2"            # 422 {"error":"missing_idempotency_key"}
R=$(curl -s "$API/v1/p/$SA/sources/$SRC_G/inspect?since=2000-01-01T00:00:00Z" -H "Authorization: Bearer $KA"); echo "$R"
echo "$R" | grep -c -e "$SIG" -e bank_secret_123            # PHẢI = 0
```

✅ Phải thấy:
- tạo source → `{id,name,provider:"generic",sourceKey:"src_generic_…",webhookUrl:"/hooks/generic/src_generic_…",isActive,verificationConfig,createdAt}` (không có secret);
- `inspect` là **mảng** (mới nhất trước) `[{id,receivedAt,status,diagnosis}]`, có `diagnosis.reason`: `ok`, `missing_header` kèm `expectedHeader:"x-signature"` + `candidateHeaders:["x-sig"]`, `signature_mismatch`, `missing_idempotency_key` kèm `expectedField:"transactionId"`;
- dòng `grep` cuối ra **0**: không lộ chữ ký hay secret.

Đây là "chế độ lắng nghe": dev của ngân hàng biết **vì sao** request của mình bị từ chối mà không phải hỏi ai.

### B2. Vào nhiều kiểu, ra một kiểu, kể cả nguồn lạ — H10 (T15)

Tự dựng ba nguồn **trong cùng project `$SA`** bằng key `KA` (secret do mình chọn, không cần key thật), ghim subscription vào ba nguồn đó:

```bash
SEP_KEY=sepay_test_$RUN; POS_KEY=payos_test_$RUN
R=$(curl -s -X POST $API/v1/p/$SA/sources -H "Authorization: Bearer $KA" -H "$CT" -d "{\"provider\":\"sepay\",\"name\":\"SePay test\",\"secret\":\"$SEP_KEY\"}")
URL_S=$(echo "$R" | jget .webhookUrl); KEY_S=$(echo "$R" | jget .sourceKey)
R=$(curl -s -X POST $API/v1/p/$SA/sources -H "Authorization: Bearer $KA" -H "$CT" -d "{\"provider\":\"payos\",\"name\":\"PayOS test\",\"secret\":\"$POS_KEY\"}")
URL_P=$(echo "$R" | jget .webhookUrl); KEY_P=$(echo "$R" | jget .sourceKey)
R=$(curl -s -X POST $API/v1/p/$SA/sources -H "Authorization: Bearer $KA" -H "$CT" -d '{"provider":"generic","name":"AB Bank mapping","secret":"bank_secret_123",
  "verificationConfig":{"scheme":"hmac-sha256","header":"x-signature","idempotency":{"field":"maGD"},"eventType":"payment.received",
  "mapping":{"amount":"soTien","currency":{"const":"VND"},"method":{"const":"bank_transfer"},"reference":"maGD","memo":"noiDung","providerTxnId":"maGD","paidAt":"thoiGian"}}}')
URL_M=$(echo "$R" | jget .webhookUrl); KEY_M=$(echo "$R" | jget .sourceKey)
call -X POST $API/v1/p/$SA/subscriptions -H "Authorization: Bearer $KA" -H "$CT" \
  -d "{\"endpointId\":\"$EA\",\"name\":\"pay\",\"eventTypes\":[\"payment.received\"],\"sourceKeys\":[\"$KEY_S\",\"$KEY_P\",\"$KEY_M\"]}"

# 1) SePay (Authorization: Apikey <secret của source>)
call -X POST "$API$URL_S" -H "$CT" -H "Authorization: Apikey $SEP_KEY" --data-binary "{\"id\":9$RUN,\"gateway\":\"MBBank\",\"transactionDate\":\"2026-10-10 10:00:00\",\"accountNumber\":\"0123456789\",\"code\":null,\"content\":\"KB $RUN\",\"transferType\":\"in\",\"transferAmount\":50000,\"accumulated\":0,\"referenceCode\":\"SP$RUN\",\"description\":\"KB $RUN\"}"
# 2) PayOS (checksum = secret của source)
PAYOS=$(node -e '
const {PayOS}=require("@payos/node");const k=process.argv[1];const p=new PayOS({clientId:"x",apiKey:"x",checksumKey:k});
const data={orderCode:Number(process.argv[2])%1e9,amount:50000,description:"KB",accountNumber:"0",reference:"PO"+process.argv[2],transactionDateTime:"2026-10-10 10:00:00",currency:"VND",paymentLinkId:"x",code:"00",desc:"success",counterAccountBankId:"",counterAccountBankName:"",counterAccountName:"",counterAccountNumber:"",virtualAccountName:"",virtualAccountNumber:""};
p.crypto.createSignatureFromObj(data,k).then(sig=>console.log(JSON.stringify({code:"00",desc:"success",success:true,data,signature:sig})));' "$POS_KEY" "$RUN")
call -X POST "$API$URL_P" -H "$CT" --data-binary "$PAYOS"
# 3) AB Bank có mapping (SPEC §4.14.4)
BAB="{\"soTien\":50000,\"maGD\":\"AB$RUN\",\"noiDung\":\"KB $RUN\",\"thoiGian\":\"2026-10-10 10:00:00\"}"
SIG=$(printf '%s' "$BAB" | openssl dgst -sha256 -hmac bank_secret_123 | awk '{print $NF}')
call "$API$URL_M" -H "$CT" -H "x-signature: $SIG" --data-raw "$BAB"
sleep 6
curl -s "$SINK/_requests?path=/a-$RUN" | jget '.filter(r=>r.body.includes("payment.received")).map(r=>{const b=JSON.parse(r.body);const d={...b.data};delete d.raw;return b.source+": "+Object.keys(d).sort().join(",")+" amount="+d.amount+" normalized="+b.normalized})'
call -X POST $API/v1/p/$SA/events -H "Authorization: Bearer $KA" -H "$CT" \
  -d '{"type":"payment.received","data":{"amount":1},"idempotencyKey":"bad-1"}'     # 422 schema_mismatch
```

✅ Phải thấy:
- ba lệnh bắn: SePay 200 `{"success":true}`, PayOS 200 `{"code":"00",…}`, AB Bank 200 `{"ok":true}`;
- danh sách cuối có **3 dòng** (`sepay`, `payos`, `generic`) với **chuỗi khoá giống hệt nhau** `account,amount,counterparty,currency,memo,method,paidAt,providerTxnId,reference`, cả ba `normalized=true`, `amount=50000`;
- `orderCode` của PayOS chỉ nằm dưới `data.raw`;
- publish `payment.received` sai khuôn → **422** `{"error":"schema_mismatch","field":"…"}`.

> Phiên bản "ba project seed" (PayOS của `bookstore`, SePay + AB Bank của `cafe`) có sẵn ở `bash scripts/demo-multi-project.sh` hồi 6 (script đó **dừng sink** ở hồi 3).
Mở `apps/shop/src/payment.ts` (`readPayment`) cho thấy **một** hàm đọc thanh toán, không có `if` theo provider.

### B3. Shop là service thật (T11)

```bash
npm run verify:reset
$DC logs shop | grep -i "VERIFIED"                                  # "[Shop] endpoint VERIFIED (http://shop:4001/hub-webhook), subscription payment.received"
q "select d.name, d.verification, d.created_by_key_id is not null as co_chu, s.event_types, s.source_ids
   from hub.destinations d join hub.subscriptions s on s.destination_id=d.id where d.name='shop'"
wc -l apps/shop/src/*.ts                                            # main.ts ≤ 300 (đếm ngày 11/10: 222; cả thư mục 405)
grep -n "x-hub-\|transferAmount" apps/shop/src/*.ts                 # không có kết quả
call -X POST $SHOP/hub-webhook -H "$CT" -d '{"type":"endpoint.verification","challenge":"x"}'   # 401: challenge không chữ ký
```

✅ Endpoint `shop` do **Shop tự đăng ký** qua `@hub/sdk` (`endpoints.ensure`) sau khi khởi động: một dòng `VERIFIED`, có chủ (key của Shop), subscription `{payment.received}` **ghim** 2 source (`SHOP_PAYMENT_SOURCE_KEYS`, mặc định `src_payos_main,src_sepay_main`, ADR-089). Seed **không** tạo (X6). Challenge giả không chữ ký → **401** `{"error":"Chữ ký Standard Webhooks không hợp lệ hoặc quá hạn"}`. Bảng `destinations` không có cột `url` (cấu hình mã hoá) nên lọc theo `name`. Sau đó chạy lại 0.1 (smoke).
> Log lúc khởi động có thể có vài dòng `Đăng ký endpoint với hub lỗi … ECONNREFUSED` trước khi hub-api lên: Shop tự thử lại, bình thường.

### B4. Revoke key chỉ ngắt đúng một service (T12)

```bash
KA2=$(curl -s -X POST $API/api/v1/projects/$PA/keys "${H[@]}" -H "$CT" -d '{"serviceName":"cafe-be-2","scopes":["read:events"]}' | jget .key)
call -X DELETE $API/api/v1/projects/$PA/keys/$KA_ID "${H[@]}"     # 204
call -X DELETE $API/api/v1/projects/$PA/keys/$KA_ID "${H[@]}"     # 204 lần nữa
call -X DELETE $API/api/v1/projects/$PB/keys/$KA_ID "${H[@]}"     # 404: key không thuộc project đó
call $API/v1/p/$SA/me -H "Authorization: Bearer $KA"              # 401
call $API/v1/p/$SA/me -H "Authorization: Bearer $KA2"             # 200
call $API/v1/p/$SB/me -H "Authorization: Bearer $KB"              # 200
q "select action from hub.audit_logs where tenant_id='$PA' and action like 'api_key.%'"   # có đúng MỘT api_key.revoked
```

✅ Như comment. Endpoint `EA` (tạo bằng KA) **vẫn nhận** push, vì endpoint thuộc project chứ không thuộc key; nhưng sau revoke **không key nào quản được nó qua `/v1/p`** cho tới khi một key mới **cùng `serviceName`** tạo endpoint cùng URL (nhận lại có chứng minh, ADR-098/101). Ghi hành vi này vào bảng kết quả.

### B5. Retention (T13, theo DINH-CHINH §3)

```bash
q "update hub.events set received_at = now() - interval '9 days' where id in (select id from hub.events order by received_at limit 3) returning id"
# retention mặc định CLEANUP_RETENTION_DAYS=7 (tên chính EVENT_RETENTION_DAYS). Job chạy lượt đầu 30–90s sau khi worker khởi động,
# nhưng lock "cleanup:lock" giữ ~0,9 chu kỳ (MS-P2-6) -> xoá lock rồi restart worker:
$DC exec -T redis redis-cli DEL cleanup:lock
$DC restart hub-worker; sleep 100
$DC logs --since 3m hub-worker | grep -i cleanup
q "select count(*) from hub.raw_events r where r.status='ACCEPTED' and not exists (select 1 from hub.events e where e.raw_event_id=r.id)"
```

✅ 3 event cũ và delivery của chúng **biến mất** (job lọc theo `events.received_at`). `raw_events` ACCEPTED **vẫn còn** (ADR-045: bằng chứng gốc giữ vô hạn). Banner "orphans" trên dashboard **không** báo động vì các raw cũ đó (orphans loại raw > N ngày).
> `CLEANUP_INTERVAL_MS` **không** được `docker-compose.yml` truyền vào worker, nên đặt trong `.env.verify` không có tác dụng.

### B6. Seed demo S12

```bash
npm run verify:reset
q "select slug, environment from hub.projects order by slug"
q "select p.slug, s.source_key from hub.sources s join hub.projects p on p.id=s.tenant_id where s.provider<>'api' order by 1,2"
```

✅ Có `bookstore` (live), `cafe` (test), `default` (test). Source: `default` có `src_github_main`, `src_payos_main`, `src_sepay_main` (MS-P2-2 đã sửa: seed default không bị seed demo chặn); `cafe` có `src_sepay_cafe`; `bookstore` có `src_payos_bookstore`. Mỗi project demo có key `<slug>-be`, endpoint `<slug>-endpoint` (trên hubv trỏ `http://sink:4100/<slug>`), subscription `payment.*`. Seed **không in key** (chỉ prefix). Đọc `docs/DEMO-MULTI-PROJECT.md` và làm theo đúng từng chữ: một người lạ phải chạy được.

### B7. Hồi quy cuối (T14)

```bash
export $(grep -E '^(HUB_SIGNING_SECRET|GITHUB_WEBHOOK_SECRET|DEMO_SEPAY_APIKEY)=' .env.verify | xargs)
HUB_URL=$API PG_CONTAINER=$($DC ps -q postgres) bash scripts/e2e-smoke.sh   # OK (smoke đã sửa theo X10: không còn x-hub-*)
npm run verify                                                               # L0/L1/L2 xanh, skip = 0
```

Mở dashboard `http://localhost:13000/login` (cần `VERIFY_WITH_WEB=1 npm run verify:reset`; web của hubv proxy `/api/*`, `/auth/*` sang hub-api của hubv), đăng nhập `operator@verify.local` / `VERIFY_ONLY_admin_password`: trang Overview, Events, Subscriptions, Flow không vỡ; đổi project ở bộ chọn project thấy dữ liệu đổi theo.

---

## 4b. Chặng C — Kết nối hai đầu (SPEC-ket-noi KN1–KN4, ADR-142/146/149/150)

> **Điều kiện:** image `hubv` build lại SAU commit KN4, và `.env.verify` có `PAYOS_FAKE_BASE_URL=http://sink:4100/_fake/payos`, `STRIPE_FAKE_BASE_URL=http://sink:4100/_fake/stripe`, `CONNECTOR_INGEST_BASE_URL=http://hub-api:4000` (CHỈ ngoài production — production có các biến này thì hub-api không khởi động). Fake PayOS của sink nhận `clientId=fake-payos-client-id`, `apiKey=fake-payos-api-key`, `checksumKey=fake-payos-checksum-key` (đổi bằng env `FAKE_PAYOS_*` của sink). Không gọi PayOS/Stripe thật.
> Cần `PA`, `PB`, `H` (A1), `SINK_IN`, `verify_sig` (§1).

### C1. Console tạo endpoint — hub sinh `whsec_` (T1)

```bash
R=$(curl -s -X POST "$API/api/v1/endpoints?projectId=$PA" "${H[@]}" -H "$CT" \
  -d "{\"name\":\"c1-$RUN\",\"url\":\"$SINK_IN/c1-$RUN\",\"eventTypes\":[\"payment.*\"]}"); echo "$R"
EC=$(echo "$R" | jget .endpoint.id); SECC=$(echo "$R" | jget .signingSecret)
call "$API/api/v1/endpoints/$EC?projectId=$PA" "${H[@]}"                                   # chi tiết: KHÔNG có secret
call -X POST "$API/api/v1/destinations?projectId=$PA" "${H[@]}" -H "$CT" -d '{"name":"x","type":"webhook","config":{"url":"https://a.example"}}'
call -X POST "$API/api/v1/endpoints?projectId=$PA" "${H[@]}" -H "$CT" \
  -d "{\"name\":\"x\",\"url\":\"$SINK_IN/x\",\"eventTypes\":[\"payment.*\"],\"sourceIds\":[\"00000000-0000-4000-8000-000000000000\"]}"
```

✅ Phải thấy: 201 `{endpoint:{verification:"VERIFIED"}, subscription:{eventTypes:["payment.*"]}, verification:"VERIFIED", signingSecret:"whsec_…"}`; chi tiết 200 không có `signingSecret`; `/destinations` webhook → **422 `use_endpoints_route`** có `fix`; sourceId lạ → **404** và không có endpoint `x` mới (GET `/api/v1/destinations`). Publish `payment.received` (A6) rồi `verify_sig "$SECC" /c1-$RUN` → ✅ chữ ký ĐÚNG.

### C2. "Kết nối PayOS" với fake (T2)

```bash
call -X POST "$API/api/v1/sources/connect?projectId=$PA" "${H[@]}" -H "$CT" \
  -d '{"provider":"payos","name":"thieu-ack","credentials":{"clientId":"fake-payos-client-id","apiKey":"fake-payos-api-key","checksumKey":"fake-payos-checksum-key"}}'
R=$(curl -s -X POST "$API/api/v1/sources/connect?projectId=$PA" "${H[@]}" -H "$CT" \
  -d '{"provider":"payos","name":"c2","acknowledgeOverwrite":true,"credentials":{"clientId":"fake-payos-client-id","apiKey":"fake-payos-api-key","checksumKey":"fake-payos-checksum-key"}}'); echo "$R"
SP=$(echo "$R" | jget .source.id)
curl -s -X POST $SINK/_fake/payos/send-payment -H "$CT" -d '{"amount":2000,"description":"C2 test"}'
call "$API/api/v1/sources/$SP/connection?projectId=$PA" "${H[@]}"
```

✅ Thiếu ack → **422 `overwrite_not_acknowledged`**; có ack → 201 `connection.status:"CONNECTED"`, `display:"CAFE TEST · ****1234"`; sink ghi `POST /_fake/payos/confirm-webhook` có `x-client-id`; giao dịch giả tới ingest 200 và (subscription `payment.*` của C1) sink nhận `payment.received` amount 2000. GET connection: `hasCredentials:true`, `credentialHints` chỉ `****` + 4 ký tự, **không** có `apiKey`/`checksumKey`, `manualDisconnect` nói đổi URL ở dashboard PayOS.
⚠ KQ1 chưa xử lý: request KIỂM TRA (orderCode 123, `VQRIO123`) cũng đi như giao dịch 3.000đ — đúng hiện trạng, xem CAN-ADMIN-QUYET-KN.md.

### C3. "Kết nối Stripe" với fake (T3)

```bash
R=$(curl -s -X POST "$API/api/v1/sources/connect?projectId=$PA" "${H[@]}" -H "$CT" \
  -d '{"provider":"stripe","name":"c3","credentials":{"secretKey":"rk_test_c3"}}'); echo "$R"; SS=$(echo "$R" | jget .source.id)
call -X POST "$API/api/v1/sources/$SS/connection/retry?projectId=$PA" "${H[@]}" -H "$CT" -d '{}'
call -X DELETE "$API/api/v1/sources/$SS/connection?projectId=$PA" "${H[@]}"
curl -s "$SINK/_requests" | jget '.filter(r=>r.path.startsWith("/_fake/stripe")).map(r=>r.method+" "+r.path)'
```

✅ 201 CONNECTED `display:"Stripe (test) · we_test…"`; retry 200 CONNECTED với `we_` MỚI; sink thấy `POST`, `POST`, `DELETE <we cũ>`, `DELETE <we mới>`; ngắt → `{remoteDeleted:true, connection:{status:"DISCONNECTED"}}`.

### C4. Cô lập + quyền (T4)

```bash
call "$API/api/v1/sources/$SP/connection?projectId=$PB" "${H[@]}"                                   # nguồn của A, hỏi bằng project B
call "$API/api/v1/sources/00000000-0000-4000-8000-000000000000/connection?projectId=$PB" "${H[@]}"  # id lạ
call -X POST "$API/api/v1/sources/connect?projectId=$PA" "${H[@]}" -H "$CT" -d '{"provider":"sepay","name":"x","credentials":{}}'
```

✅ Hai lệnh đầu **404 giống hệt** (trừ `requestId`); sepay → **422 `connector_unsupported`**. Viewer (A3) gọi bất kỳ route `/sources/*/connection*` hay `/sources/connect` → **403 `missing_scope` `required:"manage:sources"`**.

## 5. Khi một bước đỏ

1. Chép **nguyên văn** lệnh + output vào cột "Ghi chú" ở §6.
2. Đối chiếu DINH-CHINH §7 / §7b. Nếu agent đã ghi "lệch có chủ đích" (tên trường hay mã lỗi khác) thì đó **không phải lỗi**: sửa lệnh trong file này cho khớp.
3. Còn lại là lỗi: báo phiên dev kèm đúng mã bước (ví dụ `A2: hai body 404 khác nhau`).
4. Đỏ ở 0.1, A2, A6 (`verify_sig`), A8, A9 hoặc B2 nghĩa là **lời hứa cốt lõi bị phá**, chặn demo.
5. Đỏ ở §7 (production): **dừng**, không thử lại dồn dập (quota Render/Upstash), ghi lại, kiểm cùng bước đó trên `hubv` trước.

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
| P1–P9 | production (§7) | | | |

---

## 7. Test trên production (an toàn)

> Mục đích: chứng minh **online thật** (ADR-019). **Không** đo p95, không đo gì cho báo cáo ở đây.
> **Cấm** trên production: dừng/kill/restart service, k6 hay vòng lặp bắn dồn (Render free + quota Upstash/CloudAMQP), xoá hay sửa dữ liệu seed (`default`, `src_*_main`, đích của operator), bắn bất cứ gì có thể tới Telegram/Discord thật, dán secret thật vào file này hay vào lịch sử chat.
> Secret chỉ ở dạng chỗ trống `<…>`; lấy giá trị từ chỗ anh cất (vd `KEYS-CAN-LAY.md`), gõ thẳng vào terminal.
> Render free ngủ sau ~15 phút: lệnh đầu có thể mất 30–60s (`-m 90`). Đừng tưởng là lỗi rồi bắn lại liên tục.

**Biến** (terminal MỚI, **không** `export MSYS_NO_PATHCONV=1` để curl của Git Bash ghi được cookie jar):

```bash
HUB=https://hub-api-c9hg.onrender.com
WEB=https://webhook-hub-rouge.vercel.app          # web proxy /api/* và /auth/* sang hub (cookie first-party)
SHOP=https://shop-o398.onrender.com
CT='content-type: application/json'
D=$(date +%m%d%H%M); QA=qa-a-$D; QB=qa-b-$D     # project test riêng, tên có ngày giờ
JAR="$(cygpath -m /tmp)/hub-prod-jar.txt"         # cookie jar NGOÀI repo; xoá ở P9
jget() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s);const v=eval("o"+process.argv[1]);console.log(typeof v==="object"?JSON.stringify(v):v)})' "$1"; }
call() { curl -s -m 90 -w '\n→ HTTP %{http_code}\n' "$@"; }
```

### P1. Sống

```bash
call $HUB/health                                   # 200 {"status":"healthy","dependencies":{postgres,redis,rabbitmq:"up"}}
curl -s -m 90 -o /dev/null -w '%{http_code}\n' $WEB/login      # 200
curl -s -m 90 -o /dev/null -w '%{http_code}\n' $SHOP/products  # 200
call $HUB/api/v1/projects                          # 401 {"error":"unauthenticated"}
call $WEB/api/v1/projects                          # 401 y hệt (đi qua proxy web)
```

✅ Đã chạy ngày 11/10: đúng cả năm dòng.

### P2. Đăng nhập

1. Trình duyệt: mở `$WEB/login`, đăng nhập operator (`<OPERATOR_EMAIL>` / `<OPERATOR_PASSWORD>` — biến `OPERATOR_EMAIL` của Render, mật khẩu anh giữ). Vào được dashboard, Overview có số liệu, bộ chọn project có `default`.
2. Terminal (cho các bước sau):

```bash
rm -f "$JAR"
call -c "$JAR" -X POST $WEB/auth/login -H "$CT" -d '{"email":"<OPERATOR_EMAIL>","password":"<OPERATOR_PASSWORD>"}'
CSRF=$(awk '$6=="hub_csrf"{print $7}' "$JAR"); echo "CSRF: ${CSRF:0:8}…"
A=(-b "$JAR" -c "$JAR"); AW=(-b "$JAR" -c "$JAR" -H "x-csrf-token: $CSRF")   # A = đọc, AW = ghi
call $WEB/auth/me "${A[@]}"
```

✅ Login 200 `{"user":{…},"memberships":[…]}`, CSRF không rỗng, `/auth/me` 200. Cookie access sống 15 phút: hết thì chạy lại khối này. Nhập sai mật khẩu nhiều lần → 429 (`Retry-After`), **đừng** thử dồn.
> Nếu login qua `$WEB` không ra cookie trong jar thì thử `$HUB/auth/login` (cookie gắn domain hub, mọi lệnh sau đổi `$WEB` thành `$HUB`).

### P3. Tạo project, key, source qua console

```bash
call -X POST $WEB/api/v1/projects "${AW[@]}" -H "$CT" -d "{\"slug\":\"$QA\",\"name\":\"QA A\",\"environment\":\"test\"}"   # 201
call -X POST $WEB/api/v1/projects "${AW[@]}" -H "$CT" -d "{\"slug\":\"$QB\",\"name\":\"QA B\",\"environment\":\"test\"}"   # 201
PA=$(curl -s -m 90 $WEB/api/v1/projects "${A[@]}" | jget ".find(p=>p.slug===\"$QA\").id")
PB=$(curl -s -m 90 $WEB/api/v1/projects "${A[@]}" | jget ".find(p=>p.slug===\"$QB\").id")
R=$(curl -s -m 90 -X POST $WEB/api/v1/projects/$PA/keys "${AW[@]}" -H "$CT" -d '{"serviceName":"qa-a","scopes":["publish:events","read:events","manage:sources"]}')
KA=$(echo "$R" | jget .key); KA_ID=$(echo "$R" | jget .id); echo "KA: ${KA:0:12}… $(echo "$R" | jget .connectionString | sed -E 's/hk_[a-z]+_[A-Za-z0-9_]+/hk_…/')"
R=$(curl -s -m 90 -X POST $WEB/api/v1/projects/$PB/keys "${AW[@]}" -H "$CT" -d '{"serviceName":"qa-b","scopes":["read:events"]}')
KB=$(echo "$R" | jget .key); KB_ID=$(echo "$R" | jget .id)
# Source SePay của project QA, secret do MÌNH chọn (không phải key SePay thật)
QSEC=qa_sepay_$D$RANDOM
R=$(curl -s -m 90 -X POST "$WEB/api/v1/sources?projectId=$PA" "${AW[@]}" -H "$CT" -d "{\"provider\":\"sepay\",\"name\":\"QA SePay\",\"secret\":\"$QSEC\"}")
echo "$R"; URL_Q=$(echo "$R" | jget .webhookUrl)
```

✅ Project 201 (operator không bị trần số project; tài khoản thường tối đa 3/10). Key 201, `hk_test_…`, `connectionString` có host production. Source trả `webhookUrl:"/hooks/sepay/src_sepay_…"`, **không** có secret. Trên dashboard (chọn project `qa-a-…`): trang Sources thấy source mới.
> Project **không xoá được** qua API (không có route). Đặt tên `qa-…` để nhận ra; key sẽ revoke ở P9.

### P4. Ingest: chữ ký sai → 401, đúng → 200, gửi lại → trùng

```bash
SEPAY_BODY="{\"id\":7$D,\"gateway\":\"MBBank\",\"transactionDate\":\"2026-10-11 10:00:00\",\"accountNumber\":\"0000\",\"code\":null,\"content\":\"QA $D\",\"transferType\":\"in\",\"transferAmount\":1000,\"accumulated\":0,\"referenceCode\":\"QA$D\",\"description\":\"QA $D\"}"
call -X POST "$HUB$URL_Q" -H "$CT" -H "Authorization: Apikey sai_key_123" --data-binary "$SEPAY_BODY"   # 401
call -X POST "$HUB$URL_Q" -H "$CT" -H "Authorization: Apikey $QSEC"      --data-binary "$SEPAY_BODY"   # 200 {"success":true}
call -X POST "$HUB$URL_Q" -H "$CT" -H "Authorization: Apikey $QSEC"      --data-binary "$SEPAY_BODY"   # 200 (trùng, không sinh event thứ hai)
```

✅ 401 → 200 → 200. Ở P7 chỉ thấy **một** `payment.received` amount 1000 trong project QA. Project QA không có subscription Telegram/Discord nên không gửi gì ra ngoài.

**Test ký thật từ dashboard provider (tuỳ chọn, có cổng an toàn).** Nút "gửi thử"/đăng ký webhook ở dashboard SePay/PayOS bắn vào source thật của project `default` (`/hooks/sepay/src_sepay_main`, `/hooks/payos/src_payos_main`). Event sinh ra đi tới **mọi** subscription khớp của `default`, có thể gồm Telegram/Discord thật. **Trước khi bấm**:

```bash
curl -s -m 90 "$WEB/api/v1/subscriptions?projectId=00000000-0000-0000-0000-000000000001" "${A[@]}" \
 | jget '.filter(s=>s.isActive&&["telegram","discord"].includes(s.destination?.type)).map(s=>s.name+" | "+s.eventTypes)'
```

✅ Ra `[]` (hoặc không subscription nào khớp `payment.*`) thì mới bấm "gửi thử" trên dashboard provider; xem kết quả ở dashboard trang Events (project `default`): một event `payment.received`, `normalized`. ❌ Có dòng nào → **bỏ qua** bước này (tắt/bật subscription của operator là quyết định của Admin, không thuộc kịch bản an toàn).

### P5. Cô lập 404 giữa project

```bash
call "$HUB/v1/p/$QA/events?after=0" -H "Authorization: Bearer $KB"           # 404 {"error":"not_found"}
call "$HUB/v1/p/khongco-$D/events?after=0" -H "Authorization: Bearer $KB"    # 404, body Y HỆT
call "$HUB/v1/p/default/me" -H "Authorization: Bearer $KB"                   # 404 (key QA B không thấy default)
call "$HUB/v1/p/$QB/me" -H "Authorization: Bearer $KB"                       # 200
```

✅ Ba dòng 404 giống hệt từng ký tự; dòng cuối 200 `{project:{slug:"qa-b-…"},serviceName:"qa-b",scopes:["read:events"]}`.

### P6. Publish + chống trùng

```bash
call -X POST $HUB/v1/p/$QA/events -H "Authorization: Bearer $KA" -H "$CT" -d "{\"type\":\"qa.ping\",\"data\":{\"d\":\"$D\"},\"idempotencyKey\":\"qa-$D\"}"   # 202
call -X POST $HUB/v1/p/$QA/events -H "Authorization: Bearer $KA" -H "$CT" -d "{\"type\":\"qa.ping\",\"data\":{\"d\":\"$D\"},\"idempotencyKey\":\"qa-$D\"}"   # 200 {"duplicate":true}
call -X POST $HUB/v1/p/$QB/events -H "Authorization: Bearer $KB" -H "$CT" -d '{"type":"qa.ping","data":{},"idempotencyKey":"x"}'                            # 403 missing_scope
```

✅ 202 → 200 duplicate → 403. (Không tạo endpoint push trên production: cần một URL công khai biết trả challenge; push đã chứng minh ở A4/A6 trên hubv. Polling P7 thay cho push.)

### P7. Polling

```bash
call "$HUB/v1/p/$QA/events?after=0&limit=10" -H "Authorization: Bearer $KA"   # qa.ping (1 lần) + payment.received (sepay, amount 1000, 1 lần)
CUR=$(curl -s -m 90 "$HUB/v1/p/$QA/events?after=latest" -H "Authorization: Bearer $KA" | jget .nextCursor); echo "CUR=$CUR"
time curl -s -m 90 "$HUB/v1/p/$QA/events?after=$CUR&wait=3" -H "Authorization: Bearer $KA"   # rỗng sau ~3s
```

✅ Đúng hai event, mỗi cái một lần, `cursor`/`nextCursor` là chuỗi; long-poll trả rỗng sau ~3s. **Một** lệnh long-poll, đừng lặp (mỗi giây chờ là một truy vấn Neon).

### P8. Shop: đơn hàng → thanh toán → PAID

Shop production dùng project `default`; tiền vào qua `src_sepay_main` / `src_payos_main` (subscription của Shop ghim hai source này). **Cổng an toàn của P4 phải ra `[]`** trước khi làm bước 3, vì `payment.received` của `default` cũng tới mọi subscription khớp của operator.

1. Trình duyệt: `$WEB/shop`, thêm 1 món, đặt hàng, thấy mã đơn `DH…` + QR. Hoặc terminal:

   ```bash
   R=$(curl -s -m 90 -X POST $SHOP/orders -H "$CT" -d '{"items":[{"id":"m1","qty":1}],"customer":{"name":"QA test","phone":"0900000000"},"paymentProvider":"sepay"}')
   echo "$R"; OC=$(echo "$R" | jget .order.orderCode); AMT=$(echo "$R" | jget .order.amount)
   ```
   ✅ `{"success":true,"order":{"orderCode":"DH…","amount":69000,"status":"PENDING",…}}` (server tự tính tổng, ADR-024).
2. `call $SHOP/orders/$OC` → `status:"PENDING"`.
3. Thanh toán, chọn **một** trong hai:
   - **Thật:** chuyển khoản đúng `AMT` với nội dung `OC` vào tài khoản đã nối SePay (tiền thật, Admin quyết định);
   - **Giả lập có chữ ký đúng** (một request, không vòng lặp):
     ```bash
     call -X POST $HUB/hooks/sepay/src_sepay_main -H "$CT" -H "Authorization: Apikey <SEPAY_API_KEY từ KEYS-CAN-LAY.md>" --data-binary \
       "{\"id\":8$D,\"gateway\":\"MBBank\",\"transactionDate\":\"2026-10-11 10:00:00\",\"accountNumber\":\"0000\",\"code\":null,\"content\":\"$OC\",\"transferType\":\"in\",\"transferAmount\":$AMT,\"accumulated\":0,\"referenceCode\":\"QAPAY$D\",\"description\":\"$OC\"}"
     ```
     ✅ 200 `{"success":true}`.
4. Sau 5–20s: `call $SHOP/orders/$OC` → `status:"PAID"`; trên `$WEB/shop` modal thanh toán tự chuyển "đã thanh toán". Dashboard (project `default`): Events có `payment.received` nguồn `sepay`, Deliveries tới đích `shop` `SUCCEEDED`.
5. Gửi lại **đúng** request ở 3 một lần nữa → 200, đơn vẫn PAID, không cộng tiền hai lần (dedupe ở hub + `processed_hub_events` ở Shop).

❌ Đơn PENDING mãi: xem Deliveries của đích `shop` (lỗi 401 = lệch `HUB_SIGNING_SECRET` giữa Shop và endpoint, MS-R4; Shop cold start thì đợi rồi xem lại, **không** bắn thêm).

### P9. Dọn

```bash
call -X DELETE $WEB/api/v1/projects/$PA/keys/$KA_ID "${AW[@]}"    # 204
call -X DELETE $WEB/api/v1/projects/$PB/keys/$KB_ID "${AW[@]}"    # 204
call "$HUB/v1/p/$QA/me" -H "Authorization: Bearer $KA"            # 401
call -X POST $WEB/auth/logout "${AW[@]}"                          # 204
rm -f "$JAR"; unset KA KB QSEC CSRF
```

✅ Key QA bị thu hồi, phiên đăng xuất, jar đã xoá. Project/source/event QA còn lại (không có route xoá) — vô hại, tên `qa-…`.

---

## 8. Nhật ký sửa file

| Ngày | Ai | Sửa |
|---|---|---|
| 2026-10-10 | party mode `webhook-hub-54` | Bản nháp theo SPEC, trước khi có code đa service |
| 2026-10-11 | agent docs/QA | Đối route với code HEAD `9f14d54` + chạy thật trên `hubv` (xem "Trạng thái đối route"); đăng nhập cookie + CSRF; slug/sink theo `RUN`; sửa SQL theo schema thật; B2 tự chứa; thêm §7 production an toàn |
