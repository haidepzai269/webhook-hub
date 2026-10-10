#!/usr/bin/env bash
# Kịch bản demo đa project (SPEC đa service §7.3, docs/DEMO-MULTI-PROJECT.md) — chạy được nhiều lần.
#
#   bash scripts/demo-multi-project.sh            # tự tạo key cho cafe/bookstore qua console admin
#   KA=hk_test_… KB=hk_live_… bash scripts/…      # hoặc dùng key có sẵn
#
# Seed không bao giờ in key ra log (MS-R6). Mặc định chạy trên hubv (API 14000, sink 14100, operator@verify.local /
# VERIFY_ONLY_admin_password). Stack dev:
#   API=http://localhost:4000 SINK= OPERATOR_EMAIL=admin@hub.local OPERATOR_PASSWORD=<mật khẩu> PG_CONTAINER=webhook-hub-postgres …
# Không bắn gì vào Telegram/Discord (chỉ source của cafe/bookstore; subscription của chúng trỏ endpoint mock).
set -u
export MSYS_NO_PATHCONV=1
API=${API:-http://localhost:14000}
SINK=${SINK-http://localhost:14100}
OPERATOR_EMAIL=${OPERATOR_EMAIL:-operator@verify.local}
OPERATOR_PASSWORD=${OPERATOR_PASSWORD:-VERIFY_ONLY_admin_password}
PG_CONTAINER=${PG_CONTAINER:-$(docker compose -p hubv -f docker-compose.yml -f docker-compose.verify.yml --env-file .env.verify ps -q postgres 2>/dev/null)}
SEPAY_KEY=${SEPAY_KEY:-demo_sepay_cafe_key_local_only}
PAYOS_KEY=${PAYOS_KEY:-demo_payos_bookstore_checksum_local_only}
RUN=$(date +%s)
CT='content-type: application/json'
jget() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s);const v=eval("o"+process.argv[1]);console.log(typeof v==="object"?JSON.stringify(v):v)})' "$1"; }
# Biểu thức JS trên JSON đọc từ stdin, biến `o`: echo '{"a":1}' | jexpr '"a="+o.a'
jexpr() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s);console.log(eval(process.argv[1]))})' "$1"; }
q() { docker exec "$PG_CONTAINER" psql -U hub_user -d webhook_hub -tA -F ' | ' -c "$1"; }
step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
sepay() { # sepay <id> <amount> <content>
  curl -s -o /dev/null -w '%{http_code}' -X POST "$API/hooks/sepay/src_sepay_cafe" -H "$CT" -H "Authorization: Apikey $SEPAY_KEY" \
    --data-binary "{\"id\":$1,\"gateway\":\"MBBank\",\"transactionDate\":\"2026-10-10 10:00:00\",\"accountNumber\":\"0123456789\",\"code\":null,\"content\":\"$3\",\"transferType\":\"in\",\"transferAmount\":$2,\"accumulated\":0,\"referenceCode\":\"SP$1\",\"description\":\"$3\"}"
}
# AU1 (SPEC-auth §5.3/§5.4): đăng nhập bằng cookie (không còn Bearer trong body). Ghép Cookie từ Set-Cookie và gửi
# x-csrf-token = cookie hub_csrf cho POST/DELETE. Không dùng cookie jar của curl: tiền tố __Host- + Secure trên http.
LOGIN_HDRS=$(curl -s -D - -o /dev/null "$API/auth/login" -H "$CT" -d "{\"email\":\"$OPERATOR_EMAIL\",\"password\":\"$OPERATOR_PASSWORD\"}" | tr -d '\r')
COOKIE=$(printf '%s\n' "$LOGIN_HDRS" | grep -i '^set-cookie:' | sed -E 's/^[Ss]et-[Cc]ookie: ([^;]+);.*/\1/' | paste -sd ';' -)
CSRF=$(printf '%s\n' "$COOKIE" | tr ';' '\n' | sed -n 's/^ *hub_csrf=//p')
[ -n "$CSRF" ] || { echo "Đăng nhập operator thất bại ($OPERATOR_EMAIL) — kiểm OPERATOR_EMAIL/OPERATOR_PASSWORD"; exit 1; }
AUTH=(-H "Cookie: $COOKIE" -H "x-csrf-token: $CSRF")
newkey() { # newkey <slug> -> key đủ 4 scope (đi kèm source api)
  local P; P=$(curl -s "$API/api/v1/projects" "${AUTH[@]}" | jget ".find(p=>p.slug===\"$1\").id")
  curl -s -X POST "$API/api/v1/projects/$P/keys" "${AUTH[@]}" -H "$CT" -d "{\"serviceName\":\"$1-demo-$RUN\",\"scopes\":[\"publish:events\",\"read:events\",\"manage:endpoints\",\"manage:sources\"]}" | jget .key
}
KA=${KA:-$(newkey cafe)}; KB=${KB:-$(newkey bookstore)}

step "1. SePay vào source của cafe: cafe sáng lên, bookstore im lặng"
[ -n "$SINK" ] && curl -s -X DELETE "$SINK/_requests" >/dev/null
echo "SePay -> HTTP $(sepay 1$RUN 50000 "DEMO $RUN")"
sleep 6
q "select p.slug, e.type, e.data->>'amount' amount from hub.events e join hub.projects p on p.id=e.tenant_id where e.data->'raw'->>'referenceCode'='SP1$RUN'"
if [ -n "$SINK" ]; then
  echo "sink /cafe: $(curl -s "$SINK/_requests?path=/cafe" | jget '.length') request · sink /bookstore: $(curl -s "$SINK/_requests?path=/bookstore" | jget '.length') request"
fi

step "2. bookstore dùng key của mình đòi sự kiện của cafe"
curl -s -w ' → HTTP %{http_code}\n' "$API/v1/p/cafe/events?after=0" -H "Authorization: Bearer $KB"
curl -s -w ' → HTTP %{http_code}\n' "$API/v1/p/khongtontai/events?after=0" -H "Authorization: Bearer $KB"

step "3. endpoint của cafe chết -> lấy lại sự kiện bị lỡ bằng poll status=failed"
if [ -n "$SINK" ]; then
  # R-11 (review AU): poll status=failed&endpointId= chỉ nhận endpoint do CHÍNH key gọi tạo (ADR-094), mà KA mới tạo mỗi
  # lần chạy -> KA tự tạo endpoint + subscription của mình (sink đang sống để qua challenge), rồi mới tắt sink.
  EP_CAFE=$(curl -s -X POST "$API/v1/p/cafe/endpoints" -H "Authorization: Bearer $KA" -H "$CT" -d "{\"name\":\"cafe-demo-$RUN\",\"url\":\"http://sink:4100/cafe\"}" | jget .id)
  SUB_CAFE=$(curl -s -X POST "$API/v1/p/cafe/subscriptions" -H "Authorization: Bearer $KA" -H "$CT" -d "{\"name\":\"cafe-demo-$RUN\",\"endpointId\":\"$EP_CAFE\",\"eventTypes\":[\"payment.received\"],\"sourceKeys\":[\"src_sepay_cafe\"]}" | jget .id)
  echo "endpoint của key demo: $EP_CAFE · subscription: $SUB_CAFE"
  docker compose -p hubv -f docker-compose.yml -f docker-compose.verify.yml --env-file .env.verify stop sink >/dev/null 2>&1
  for i in 1 2 3; do sepay 3$i$RUN 1000$i "MISS $i" >/dev/null; done
  sleep 8
  curl -s "$API/v1/p/cafe/events?after=0&status=failed&endpointId=$EP_CAFE&limit=100" -H "Authorization: Bearer $KA" \
    | jexpr '"bị lỡ: "+o.events.length+" sự kiện ["+o.events.map(e=>e.data.amount).join(", ")+"]"'
  docker compose -p hubv -f docker-compose.yml -f docker-compose.verify.yml --env-file .env.verify start sink >/dev/null 2>&1
  # Tắt subscription demo để lần chạy sau không cộng dồn delivery.
  curl -s -o /dev/null -w "tắt subscription demo -> %{http_code}\n" -X PATCH "$API/v1/p/cafe/subscriptions/$SUB_CAFE" -H "Authorization: Bearer $KA" -H "$CT" -d '{"isActive":false}'
else
  echo "(bỏ qua trên stack dev: cần tắt được endpoint)"
fi

step "4. revoke MỘT key: chỉ đúng service đó bị ngắt"
PA=$(curl -s "$API/api/v1/projects" "${AUTH[@]}" | jget '.find(p=>p.slug==="cafe").id')
R=$(curl -s -X POST "$API/api/v1/projects/$PA/keys" "${AUTH[@]}" -H "$CT" -d "{\"serviceName\":\"cafe-tam-$RUN\",\"scopes\":[\"read:events\"]}")
KT=$(echo "$R" | jget .key); KT_ID=$(echo "$R" | jget .id)
curl -s -o /dev/null -w "revoke -> %{http_code}\n" -X DELETE "$API/api/v1/projects/$PA/keys/$KT_ID" "${AUTH[@]}"
curl -s -o /dev/null -w "key vừa revoke gọi /me -> %{http_code}\n" "$API/v1/p/cafe/me" -H "Authorization: Bearer $KT"
curl -s -o /dev/null -w "key cafe-be vẫn chạy -> %{http_code}\n" "$API/v1/p/cafe/me" -H "Authorization: Bearer $KA"
curl -s -o /dev/null -w "key bookstore vẫn chạy -> %{http_code}\n" "$API/v1/p/bookstore/me" -H "Authorization: Bearer $KB"

step "5. thêm \"AB Bank\" bằng GenericAdapter + chế độ lắng nghe"
R=$(curl -s -X POST "$API/v1/p/cafe/sources" -H "Authorization: Bearer $KA" -H "$CT" -d '{"provider":"generic","name":"AB Bank demo","secret":"bank_secret_123","verificationConfig":{"scheme":"hmac-sha256","header":"x-signature","idempotency":{"field":"maGD"},"eventType":"payment.received","mapping":{"amount":"soTien","currency":{"const":"VND"},"method":{"const":"bank_transfer"},"reference":"maGD","memo":"noiDung","providerTxnId":"maGD","paidAt":"thoiGian"}}}')
URL_AB=$(echo "$R" | jget .webhookUrl); SRC_AB=$(echo "$R" | jget .id)
BAB="{\"soTien\":50000,\"maGD\":\"AB$RUN\",\"noiDung\":\"DEMO $RUN\",\"thoiGian\":\"2026-10-10 10:00:00\"}"
SIG=$(printf '%s' "$BAB" | openssl dgst -sha256 -hmac bank_secret_123 | awk '{print $NF}')
curl -s -o /dev/null -w "AB Bank gửi header SAI tên (x-sig) -> %{http_code}\n" "$API$URL_AB" -H "$CT" -H "x-sig: $SIG" --data-raw "$BAB"
curl -s "$API/v1/p/cafe/sources/$SRC_AB/inspect" -H "Authorization: Bearer $KA" | jexpr '"lắng nghe: "+JSON.stringify(o[0].diagnosis)'
curl -s -o /dev/null -w "sửa header (x-signature) -> %{http_code}\n" "$API$URL_AB" -H "$CT" -H "x-signature: $SIG" --data-raw "$BAB"
curl -s "$API/v1/p/cafe/sources/$SRC_AB/inspect" -H "Authorization: Bearer $KA" | jexpr '"lắng nghe: "+JSON.stringify(o[0].diagnosis)'

step "6. vào nhiều kiểu, ra một kiểu: PayOS (bookstore) · SePay (cafe) · AB Bank (cafe)"
PAYOS=$(node -e '
const {PayOS}=require("@payos/node");const k=process.argv[1];const p=new PayOS({clientId:"x",apiKey:"x",checksumKey:k});
const data={orderCode:Number(process.argv[2])%1e9,amount:50000,description:"DEMO",accountNumber:"0",reference:"PO"+process.argv[2],transactionDateTime:"2026-10-10 10:00:00",currency:"VND",paymentLinkId:"x",code:"00",desc:"success",counterAccountBankId:"",counterAccountBankName:"",counterAccountName:"",counterAccountNumber:"",virtualAccountName:"",virtualAccountNumber:""};
p.crypto.createSignatureFromObj(data,k).then(sig=>console.log(JSON.stringify({code:"00",desc:"success",success:true,data,signature:sig})));' "$PAYOS_KEY" "$RUN")
curl -s -o /dev/null -w "PayOS -> %{http_code}\n" -X POST "$API/hooks/payos/src_payos_bookstore" -H "$CT" --data-binary "$PAYOS"
echo "SePay -> HTTP $(sepay 6$RUN 50000 "ONE SHAPE $RUN")"
sleep 6
q "select p.slug, e.source, e.type, e.normalized, e.data->>'amount' amount,
          (select string_agg(k, ',' order by k) from jsonb_object_keys(e.data - 'raw') k) keys
   from hub.events e join hub.projects p on p.id=e.tenant_id
   where e.type='payment.received' and (e.data->>'providerTxnId' in ('6$RUN','AB$RUN') or e.data->'raw'->'data'->>'reference'='PO$RUN')
   order by e.source"
echo "(cột keys giống hệt nhau ở cả 3 dòng = service chỉ viết MỘT hàm xử lý payment.received)"
