#!/usr/bin/env bash
# Thử cảnh báo Telegram LOCAL (ADR-257) — Admin chạy trên máy mình, KHÔNG phải agent.
#
#   bash infra/alertmanager/test-telegram.sh            # cảnh báo giả mức warning (mặc định)
#   bash infra/alertmanager/test-telegram.sh critical   # cảnh báo giả mức critical
#   bash infra/alertmanager/test-telegram.sh that       # sự cố thật: tắt redis-exporter -> TargetDown
#   bash infra/alertmanager/test-telegram.sh doi-token  # nhập lại token / chat_id rồi thử warning
#
# Token và chat_id được HỎI khi chạy (token gõ không hiện), ghi vào infra/alertmanager/secrets/ (gitignored),
# chown 65534 + chmod 600 như MONITORING.md §4. Script không bao giờ in giá trị secret.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SEC="$ROOT/infra/alertmanager/secrets"
TOKEN_F="$SEC/telegram_bot_token"
CHAT_F="$SEC/telegram_chat_id"
AM=webhook-hub-alertmanager
AM_URL=http://127.0.0.1:9093
MODE="${1:-warning}"

say() { printf '\n\033[1m▶ %s\033[0m\n' "$*"; }
die() { printf '\n\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

case "$MODE" in warning | critical | that | doi-token) ;; *) die "Chế độ không hiểu: $MODE (warning | critical | that | doi-token)" ;; esac
command -v docker >/dev/null || die "Chưa có docker"
command -v curl >/dev/null || die "Chưa có curl"
cd "$ROOT"

# --- 1. Secret ---------------------------------------------------------------------------------------------
have_secrets() { sudo test -s "$TOKEN_F" && sudo test -s "$CHAT_F"; }
if [ "$MODE" = doi-token ] || ! have_secrets; then
  say "Nhập Telegram (token gõ sẽ KHÔNG hiện trên màn hình)"
  read -r -p "Chat ID (số; nhóm thì có dấu -): " CHAT_ID
  read -r -s -p "Bot token (dạng 123456789:AA...): " TOKEN
  echo
  [[ "$CHAT_ID" =~ ^-?[0-9]+$ ]] || die "Chat ID phải là số"
  [[ "$TOKEN" =~ ^[0-9]+:[A-Za-z0-9_-]+$ ]] || die "Token sai định dạng (cần dạng 123456789:AA...)"
  echo "Cần sudo để chown file cho user nobody (65534) của container:"
  sudo rm -f "$TOKEN_F" "$CHAT_F"
  (umask 077 && printf '%s\n' "$TOKEN" >"$TOKEN_F" && printf '%s\n' "$CHAT_ID" >"$CHAT_F")
  unset TOKEN
  sudo chown 65534 "$TOKEN_F" "$CHAT_F"
  sudo chmod 600 "$TOKEN_F" "$CHAT_F"
  echo "✓ Đã ghi secret (chmod 600, chủ 65534)"
  [ "$MODE" = doi-token ] && MODE=warning
else
  echo "✓ Dùng lại token/chat_id đã có trong infra/alertmanager/secrets/ (muốn đổi: chạy với 'doi-token')"
fi

# --- 2. Dựng Alertmanager (+ alert-sink), recreate để đọc secret mới --------------------------------------
say "Dựng Alertmanager"
SERVICES=(alertmanager alert-sink)
[ "$MODE" = that ] && SERVICES+=(redis redis-exporter prometheus)
docker compose --profile monitoring up -d --force-recreate "${SERVICES[@]}" >/dev/null
for _ in $(seq 1 30); do curl -fsS "$AM_URL/-/ready" >/dev/null 2>&1 && break; sleep 1; done
curl -fsS "$AM_URL/-/ready" >/dev/null 2>&1 || die "Alertmanager không lên sau 30s — xem: docker logs $AM"

ENTRY="$(docker logs "$AM" 2>&1 | grep '\[entrypoint\]' | tail -5)"
echo "$ENTRY"
grep -q 'Telegram BẬT' <<<"$ENTRY" || die "Telegram đang TẮT — lý do ở dòng [entrypoint] phía trên (entrypoint không in secret)."
echo "✓ Telegram BẬT"

# --- 3a. Cảnh báo giả --------------------------------------------------------------------------------------
if [ "$MODE" != that ]; then
  NAME="ThuNghiemTelegram_$(date +%H%M%S)" # tên mới mỗi lần -> nhóm mới -> gửi sau group_wait 30s, không chờ 5 phút
  END="$(date -u -d '+2 min' +%Y-%m-%dT%H:%M:%SZ)"
  say "Bắn cảnh báo giả $NAME (mức $MODE)"
  docker exec "$AM" amtool alert add "alertname=$NAME" "severity=$MODE" \
    --annotation='summary="Cảnh báo giả lập"' \
    --annotation='description="Admin chạy test-telegram.sh để kiểm đường Telegram"' \
    --end="$END" --alertmanager.url=http://localhost:9093
  cat <<EOF

✓ Đã bắn. Xem Telegram:
  • khoảng 30 giây  -> tin [ĐANG BÁO] $NAME - mức: $MODE
  • sau 2 phút cảnh báo hết hạn; tin [ĐÃ HẾT] tới ở nhịp gom kế tiếp (group_interval 5 phút) -> chậm nhất ~7 phút
  • Đối chiếu bản sao đã gửi alert-sink:  docker logs webhook-hub-alert-sink 2>&1 | grep -c $NAME
Không thấy tin sau 1 phút:  docker logs $AM 2>&1 | grep -i telegram | tail
EOF
  exit 0
fi

# --- 3b. Sự cố thật: tắt redis-exporter -> Prometheus thấy up==0 -> TargetDown (critical, for 1m) -------------
say "Chờ Prometheus thấy redis-exporter UP"
for _ in $(seq 1 60); do
  curl -fsS 'http://127.0.0.1:9090/api/v1/query?query=up%7Bjob%3D%22redis%22%7D' 2>/dev/null | grep -q '"1"\]' && break
  sleep 2
done
docker stop webhook-hub-redis-exporter >/dev/null
cat <<EOF
✓ Đã TẮT redis-exporter lúc $(date +%H:%M:%S).
  Chờ khoảng 2–3 phút (scrape + 'for: 1m' + group_wait 30s) -> Telegram nhận [ĐANG BÁO] TargetDown - mức: critical
EOF
read -r -p "Thấy tin trên Telegram rồi thì bấm Enter để BẬT lại exporter... " _
docker start webhook-hub-redis-exporter >/dev/null
echo "✓ Đã bật lại. Tin [ĐÃ HẾT] TargetDown tới trong khoảng 1–6 phút (nhịp gom 5 phút)."
