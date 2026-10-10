#!/usr/bin/env bash
# S1-8 — Smoke e2e trên docker LOCAL (chạy được trên Git Bash Windows).
#
#   bash scripts/e2e-smoke.sh            -> in bảng events × deliveries, "OK" và exit 0 nếu mọi thứ đúng
#
# Bắn: 1 GitHub ký đúng · 1 GitHub ký sai · 1 SePay "Apikey" đúng · gửi lại đúng SePay đó lần nữa.
# ⚠ SePay ra `payment.received` -> khớp MỌI subscription `payment.*` (seed: Telegram). Không muốn gửi
#   Telegram thật thì tắt subscription Telegram (PATCH isActive=false) trước khi chạy.
# Exit ≠ 0 nếu: có delivery không SUCCEEDED · ký sai mà không nhận 401 · gửi lại sinh event thứ hai ·
# hub.outbox có chuỗi giống secret.
#
# Biến môi trường (mặc định đọc từ env, rồi .env, rồi giá trị seed mặc định):
#   HUB_URL (http://localhost:4000) · GITHUB_WEBHOOK_SECRET · DEMO_SEPAY_APIKEY · HUB_SIGNING_SECRET
#   PG_CONTAINER (webhook-hub-postgres) · SMOKE_TIMEOUT_S (20)
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HUB_URL="${HUB_URL:-http://localhost:4000}"
PG_CONTAINER="${PG_CONTAINER:-webhook-hub-postgres}"
TIMEOUT_S="${SMOKE_TIMEOUT_S:-20}"

# Đọc KEY từ env, nếu rỗng thì từ .env (bỏ ngoặc kép), nếu vẫn rỗng thì dùng mặc định.
envval() {
  local key="$1" def="$2" v="${!1:-}"
  if [ -z "$v" ] && [ -f "$ROOT/.env" ]; then
    v="$(grep -E "^${key}=" "$ROOT/.env" | tail -1 | cut -d= -f2- | tr -d '\r' | sed -e 's/^"//' -e 's/"$//')"
  fi
  printf '%s' "${v:-$def}"
}

GH_SECRET="$(envval GITHUB_WEBHOOK_SECRET gh_webhook_secret_test_123)"
SEPAY_KEY="$(envval DEMO_SEPAY_APIKEY demo_sepay_simulate_key_local_only)"
HUB_SIGNING_SECRET="$(envval HUB_SIGNING_SECRET hub_outbound_signing_secret_999)"

psql_q() { docker exec "$PG_CONTAINER" psql -U hub_user -d webhook_hub -tA -F '|' -c "$1"; }
uuid() { node -e "console.log(require('crypto').randomUUID())"; }
fail() { echo "FAIL: $*"; FAILED=1; }
FAILED=0

RUN_ID="$(date +%s)$RANDOM"
GH_DELIVERY="$(uuid)"
GH_BAD_DELIVERY="$(uuid)"
SEPAY_ID="$RUN_ID"

echo "== Smoke run $RUN_ID -> $HUB_URL"

# ---------- 1. GitHub ký đúng ----------
# S3-2: đủ trường để ra kiểu chuẩn repo.push (html_url, commits) — thiếu thì validator catalog từ chối.
GH_BODY="{\"ref\":\"refs/heads/main\",\"after\":\"smoke$RUN_ID\",\"commits\":[],\"repository\":{\"name\":\"smoke_repo\",\"full_name\":\"smoke/smoke_repo\",\"html_url\":\"https://github.com/smoke/smoke_repo\"},\"sender\":{\"login\":\"smoke_bot\"}}"
GH_SIG="sha256=$(printf '%s' "$GH_BODY" | openssl dgst -sha256 -hmac "$GH_SECRET" | awk '{print $NF}')"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$HUB_URL/hooks/github/src_github_main" \
  -H 'content-type: application/json' -H 'X-GitHub-Event: push' -H "X-GitHub-Delivery: $GH_DELIVERY" \
  -H "X-Hub-Signature-256: $GH_SIG" --data-binary "$GH_BODY")
echo "GitHub ký đúng          -> $code"
[ "$code" = "200" ] || fail "GitHub ký đúng trả $code (mong 200)"

# ---------- 2. GitHub ký sai ----------
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$HUB_URL/hooks/github/src_github_main" \
  -H 'content-type: application/json' -H 'X-GitHub-Event: push' -H "X-GitHub-Delivery: $GH_BAD_DELIVERY" \
  -H "X-Hub-Signature-256: sha256=$(printf '0%.0s' $(seq 1 64))" --data-binary "$GH_BODY")
echo "GitHub ký sai           -> $code"
[ "$code" = "401" ] || fail "GitHub ký sai trả $code (mong 401)"

# ---------- 3 + 4. SePay Apikey đúng, rồi gửi lại y hệt ----------
SEPAY_BODY="{\"id\":$SEPAY_ID,\"gateway\":\"MBBank\",\"transactionDate\":\"2026-10-10 10:00:00\",\"accountNumber\":\"0123456789\",\"code\":null,\"content\":\"SMOKE $RUN_ID _a_b*c\",\"transferType\":\"in\",\"transferAmount\":10000,\"accumulated\":0,\"referenceCode\":\"SMK$RUN_ID\",\"description\":\"smoke test _a_b*c\"}"
for attempt in 1 2; do
  code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$HUB_URL/hooks/sepay/src_sepay_main" \
    -H 'content-type: application/json' -H "Authorization: Apikey $SEPAY_KEY" --data-binary "$SEPAY_BODY")
  echo "SePay lần $attempt              -> $code"
  [ "$code" = "200" ] || fail "SePay lần $attempt trả $code (mong 200)"
done

KEYS="'github:$GH_DELIVERY','sepay:$SEPAY_ID'"

# ---------- Đợi tối đa TIMEOUT_S giây cho tới khi mọi delivery tới trạng thái cuối ----------
deadline=$(( $(date +%s) + TIMEOUT_S ))
while :; do
  state=$(psql_q "select count(*) filter (where d.id is not null), count(*) filter (where d.status in ('SUCCEEDED','DEAD')), count(distinct e.id)
    from hub.raw_events r join hub.events e on e.raw_event_id = r.id left join hub.deliveries d on d.event_id = e.id
    where r.idempotency_key in ($KEYS)")
  total=$(echo "$state" | cut -d'|' -f1); done_=$(echo "$state" | cut -d'|' -f2); evs=$(echo "$state" | cut -d'|' -f3)
  if [ "${evs:-0}" -ge 2 ] && [ "${total:-0}" -gt 0 ] && [ "$total" = "$done_" ]; then break; fi
  if [ "$(date +%s)" -ge "$deadline" ]; then echo "(hết ${TIMEOUT_S}s chờ: events=$evs deliveries=$total xong=$done_)"; break; fi
  sleep 1
done

echo
echo "== events × deliveries"
docker exec "$PG_CONTAINER" psql -U hub_user -d webhook_hub -c "
  select e.type, coalesce(dst.name,'-') as destination, coalesce(d.status::text,'(không có delivery)') as status,
         d.attempt_count, left(coalesce(d.last_error,''), 80) as last_error
  from hub.raw_events r join hub.events e on e.raw_event_id = r.id
  left join hub.deliveries d on d.event_id = e.id
  left join hub.subscriptions s on s.id = d.subscription_id
  left join hub.destinations dst on dst.id = s.destination_id
  where r.idempotency_key in ($KEYS) order by e.type, dst.name;"

# ---------- Kiểm ----------
bad=$(psql_q "select count(*) from hub.raw_events r join hub.events e on e.raw_event_id = r.id
  join hub.deliveries d on d.event_id = e.id where r.idempotency_key in ($KEYS) and d.status <> 'SUCCEEDED'")
[ "$bad" = "0" ] || fail "$bad delivery không SUCCEEDED"

ndel=$(psql_q "select count(*) from hub.raw_events r join hub.events e on e.raw_event_id = r.id
  join hub.deliveries d on d.event_id = e.id where r.idempotency_key in ($KEYS)")
[ "${ndel:-0}" -gt 0 ] || fail "không có delivery nào được tạo"

gh_events=$(psql_q "select count(*) from hub.raw_events r join hub.events e on e.raw_event_id = r.id where r.idempotency_key = 'github:$GH_DELIVERY'")
[ "$gh_events" = "1" ] || fail "GitHub ký đúng sinh $gh_events event (mong 1)"

sepay_raw=$(psql_q "select count(*) from hub.raw_events where idempotency_key = 'sepay:$SEPAY_ID'")
sepay_events=$(psql_q "select count(*) from hub.raw_events r join hub.events e on e.raw_event_id = r.id where r.idempotency_key = 'sepay:$SEPAY_ID'")
echo "SePay gửi 2 lần -> raw_events=$sepay_raw events=$sepay_events"
[ "$sepay_events" = "1" ] && [ "$sepay_raw" = "1" ] || fail "gửi lại SePay sinh raw_events=$sepay_raw events=$sepay_events (mong 1/1)"

bad_rejected=$(psql_q "select count(*) from hub.raw_events where status = 'REJECTED' and headers->>'x-github-delivery' = '$GH_BAD_DELIVERY'")
echo "Request ký sai đã lưu mẫu REJECTED: $bad_rejected (≤1)"

secrets=$(psql_q "select count(*) from hub.outbox where payload::text ~* 'signingSecret|botToken|webhookUrl|\"config\"'
  or strpos(payload::text, '$(printf '%s' "$HUB_SIGNING_SECRET" | sed "s/'/''/g")') > 0")
echo "hub.outbox chứa chuỗi giống secret: $secrets"
[ "$secrets" = "0" ] || fail "hub.outbox còn $secrets dòng chứa secret/config"

echo
if [ "$FAILED" = "0" ]; then
  echo "OK"
  exit 0
fi
echo "SMOKE FAILED"
exit 1
