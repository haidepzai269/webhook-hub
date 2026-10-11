#!/usr/bin/env bash
# ADR-129 [AU:HA4] — kiểm chế độ `docker-entrypoint.sh hub-all` bằng IMAGE THẬT trên stack hubv (Linux):
#   1. spec supervisor (HA1–HA3) chạy trong container node:22 (tín hiệu POSIX thật — Windows không có SIGTERM thật)
#   2. dựng hubv biến thể: hub-api chạy hub-all (mem_limit 512m), hub-worker tắt
#   3. đếm tiến trình Node trong container + RSS từng tiến trình / tổng container
#   4. e2e-smoke + Shop: tạo đơn -> SePay -> đơn PAID (đường giao do worker TRONG container chạy)
#   5. giết tiến trình worker -> supervisor dừng hết, container thoát ≠ 0 và được khởi động lại (RestartCount tăng)
#   6. docker stop (SIGTERM) -> cả hai drain, ExitCode 0, trong < 30 s
#   7. trả hubv về hai service (hub-api + hub-worker) như cũ
# Chạy: bash scripts/hub-all-e2e.sh   (cần hubv đang chạy: npm run verify:up)
set -u
export MSYS_NO_PATHCONV=1
NULLF=$(mktemp)  # MSYS_NO_PATHCONV: curl -o "$NULLF" hỏng trên Git Bash -> ghi bỏ vào file tạm
cd "$(dirname "$0")/.."
BASE="docker compose -p hubv -f docker-compose.yml -f docker-compose.verify.yml --env-file .env.verify"
ALL="$BASE -f docker-compose.verify-allinone.yml"
API=${API:-http://localhost:14000}
SHOP=${SHOP:-http://localhost:14001}
FAILED=0
fail() { echo "FAIL: $*"; FAILED=1; }
jget() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const o=JSON.parse(s);const v=eval("o"+process.argv[1]);console.log(typeof v==="object"?JSON.stringify(v):v)}catch{console.log("")}})' "$1"; }
wait_health() { for _ in $(seq 1 120); do curl -fsS -o "$NULLF" "$API/health" 2>/dev/null && return 0; sleep 2; done; return 1; }
cid() { $ALL ps -q hub-api; }
node_procs() { docker exec "$(cid)" sh -c 'for p in /proc/[0-9]*; do c=$(tr "\0" " " < $p/cmdline 2>/dev/null); case "$c" in *dist/apps*|*hub-all.js*) echo "$(basename $p) $(awk "/VmRSS/{print \$2}" $p/status) $c";; esac; done' | grep -aE ' (/usr/local/bin/)?node '; }

echo "== 1. spec supervisor trong Linux (node:22-alpine)"
docker run --rm -v "$(pwd -W 2>/dev/null || pwd):/w" -w /w node:22-alpine node node_modules/jest/bin/jest.js -w 1 --runTestsByPath apps/hub-api/test/hub-all-supervisor.spec.ts 2>&1 | grep -E "✓|✕|Tests:" || fail "không chạy được spec supervisor"

echo "== 2. hubv biến thể hub-all"
$BASE stop hub-worker >/dev/null 2>&1
$ALL up -d --no-deps --force-recreate hub-api >/dev/null 2>&1 || fail "không dựng được hub-api hub-all"
wait_health || fail "hub-all không lên /health"
echo "-- tiến trình Node trong container (pid RSS_kB cmd):"
node_procs | sed 's/^/   /'
n=$(node_procs | grep -ac "dist/apps/hub-")
[ "$n" = "2" ] || fail "mong 2 tiến trình hub (api + worker), thấy $n"

echo "== 3. smoke + Shop PAID"
set -a; . ./.env.verify; set +a
HUB_URL="$API" PG_CONTAINER="$($BASE ps -q postgres)" bash scripts/e2e-smoke.sh > /tmp/hub-all-smoke.log 2>&1 && echo "   smoke OK" || { tail -5 /tmp/hub-all-smoke.log; fail "smoke"; }
ORDER=$(curl -s -X POST "$SHOP/orders" -H 'content-type: application/json' -d '{"items":[{"id":"m1","qty":1}],"customer":{"name":"Hub All","phone":"0900000000","address":"HCM"}}')
CODE=$(echo "$ORDER" | jget .order.orderCode); AMOUNT=$(echo "$ORDER" | jget .order.amount)
[ -n "$CODE" ] || fail "không tạo được đơn: $ORDER"
SID="$(date +%s)$RANDOM"
curl -s -o "$NULLF" -w "   SePay -> %{http_code}\n" -X POST "$API/hooks/sepay/src_sepay_main" -H 'content-type: application/json' -H "Authorization: Apikey ${DEMO_SEPAY_APIKEY:-demo_sepay_simulate_key_local_only}" \
  --data-binary "{\"id\":$SID,\"gateway\":\"MBBank\",\"transactionDate\":\"2026-10-12 10:00:00\",\"accountNumber\":\"0123456789\",\"code\":null,\"content\":\"$CODE\",\"transferType\":\"in\",\"transferAmount\":$AMOUNT,\"accumulated\":0,\"referenceCode\":\"HA$SID\",\"description\":\"$CODE\"}"
ST=""
for _ in $(seq 1 30); do ST=$(curl -s "$SHOP/orders/$CODE" | jget .status); [ "$ST" = "PAID" ] && break; sleep 1; done
echo "   đơn $CODE ($AMOUNT) -> $ST"
[ "$ST" = "PAID" ] || fail "đơn không PAID (worker trong container không giao?)"
echo "-- bộ nhớ sau tải nhẹ:"
node_procs | awk '{printf "   pid %s RSS %.1f MB %s %s\n",$1,$2/1024,$4,$5}'
docker stats --no-stream --format "   container {{.Name}}: {{.MemUsage}} ({{.MemPerc}})" "$(cid)"

echo "== 4. worker chết -> supervisor dừng hết, container khởi động lại"
C=$(cid); RC0=$(docker inspect -f '{{.RestartCount}}' "$C")
WPID=$(node_procs | awk '/hub-worker/{print $1; exit}')
docker exec "$C" sh -c "kill -9 $WPID"
for _ in $(seq 1 40); do RC=$(docker inspect -f '{{.RestartCount}}' "$C"); [ "$RC" != "$RC0" ] && break; sleep 1; done
echo "   RestartCount $RC0 -> $RC; log supervisor:"
docker logs --since 2m "$C" 2>&1 | grep '"proc":"supervisor"' | tail -4 | sed 's/^/   /'
[ "$RC" != "$RC0" ] || fail "container không khởi động lại sau khi worker chết"
docker logs --since 2m "$C" 2>&1 | grep -q 'worker thoát ngoài ý muốn' || fail "supervisor không báo worker chết"
wait_health || fail "hub-all không lên lại sau restart"

echo "== 5. docker stop (SIGTERM) -> drain, ExitCode 0"
T0=$(date +%s); docker stop -t 30 "$C" >/dev/null; T1=$(date +%s)
EC=$(docker inspect -f '{{.State.ExitCode}}' "$C")
echo "   dừng trong $((T1 - T0)) s, ExitCode $EC"
docker logs --since 1m "$C" 2>&1 | grep '"proc":"supervisor"' | tail -4 | sed 's/^/   /'
[ "$EC" = "0" ] || fail "ExitCode $EC (mong 0)"
[ $((T1 - T0)) -lt 30 ] || fail "dừng quá 30 s"

echo "== 6. trả hubv về hai service"
$BASE up -d --no-deps --force-recreate hub-api hub-worker >/dev/null 2>&1
wait_health || fail "hubv hai service không lên lại"

[ "$FAILED" = "0" ] && echo "HUB-ALL E2E OK" || { echo "HUB-ALL E2E FAILED"; exit 1; }
