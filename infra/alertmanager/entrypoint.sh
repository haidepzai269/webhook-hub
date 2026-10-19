#!/bin/sh
# ADR-257. Render alertmanager.yml (template trong git) -> /tmp/alertmanager.yml rồi chạy Alertmanager.
# Đủ token + chat_id hợp lệ (file gitignored) thì giữ khối TELEGRAM và điền chat_id; ngược lại cắt khối đó
# -> vẫn khởi động, chỉ còn alert-sink. Không bao giờ in giá trị secret.
set -u
SRC=/etc/alertmanager/alertmanager.yml
OUT=/tmp/alertmanager.yml
SEC=/etc/alertmanager/secrets
TOKEN_F="$SEC/telegram_bot_token"
CHAT_F="$SEC/telegram_chat_id"
log() { echo "[entrypoint] $*"; }

# In ra các dòng giá trị (bỏ dòng '#' và dòng trống, trim). Rỗng nếu file không đọc được.
values() { grep -Ev '^[[:space:]]*(#|$)' "$1" 2>/dev/null | tr -d '\r' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//'; }

# get <file> <regex> <tên>: thành công -> in giá trị; thất bại -> in LÝ DO (không bao giờ in giá trị) và return 1.
get() {
  f=$1; re=$2; name=$3
  if [ ! -e "$f" ]; then echo "$name: chưa có file"; return 1; fi
  if [ ! -r "$f" ]; then
    echo "$name: file TỒN TẠI nhưng KHÔNG ĐỌC ĐƯỢC (container chạy user nobody=65534). Sửa: sudo chown 65534 $name && chmod 600 $name"
    return 1
  fi
  v=$(values "$f"); n=$(printf '%s\n' "$v" | grep -c .)
  if [ "$n" -ne 1 ]; then echo "$name: cần ĐÚNG 1 dòng giá trị (không tính dòng # và dòng trống), đang có $n"; return 1; fi
  if ! printf '%s' "$v" | grep -Eq "$re"; then echo "$name: giá trị sai định dạng"; return 1; fi
  printf '%s' "$v"
}

cut_telegram() { # $1=vào $2=ra ; chỉ cắt khi marker đủ cặp, đúng thứ tự
  for k in ROUTE RECEIVER; do
    b=$(grep -c "# TELEGRAM-$k-BEGIN" "$1"); e=$(grep -c "# TELEGRAM-$k-END" "$1")
    bl=$(grep -n "# TELEGRAM-$k-BEGIN" "$1" | cut -d: -f1 | head -1); el=$(grep -n "# TELEGRAM-$k-END" "$1" | cut -d: -f1 | head -1)
    if [ "$b" != 1 ] || [ "$e" != 1 ] || [ "$bl" -ge "$el" ]; then return 1; fi
  done
  sed -e '/# TELEGRAM-ROUTE-BEGIN/,/# TELEGRAM-ROUTE-END/d' -e '/# TELEGRAM-RECEIVER-BEGIN/,/# TELEGRAM-RECEIVER-END/d' "$1" > "$2"
}

ENABLED=0; REASON=""
if TOKEN=$(get "$TOKEN_F" '^[0-9]+:[A-Za-z0-9_-]+$' telegram_bot_token); then
  if CHAT=$(get "$CHAT_F" '^-?[0-9]+$' telegram_chat_id); then
    if cut_telegram "$SRC" /tmp/probe.yml; then
      sed "s/chat_id: 1 # @CHAT_ID@/chat_id: $CHAT/" "$SRC" > "$OUT"
      if /bin/amtool check-config "$OUT" >/dev/null 2>&1; then ENABLED=1; else REASON="config render không qua amtool check-config"; fi
    else REASON="marker TELEGRAM trong template lệch"; fi
  else REASON=$CHAT; fi
else REASON=$TOKEN; fi
unset TOKEN CHAT

if [ "$ENABLED" = 1 ]; then
  log "Telegram BẬT"
else
  [ -n "$REASON" ] && log "Telegram TẮT - $REASON" || log "Telegram TẮT"
  if cut_telegram "$SRC" "$OUT" && /bin/amtool check-config "$OUT" >/dev/null 2>&1; then
    :
  else
    log "CẢNH BÁO: không cắt được khối Telegram an toàn -> dùng template gốc (Telegram sẽ lỗi gửi nếu có alert, nhưng Alertmanager vẫn lên)"
    cp "$SRC" "$OUT"
  fi
fi
exec /bin/alertmanager --config.file="$OUT" --storage.path=/alertmanager "$@"
