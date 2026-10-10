#!/bin/sh
set -e

SERVICE="$1"
[ "$#" -gt 0 ] && shift

echo "==> [Webhook Hub Entrypoint] Starting service: $SERVICE"

if [ "$SERVICE" = "seed" ]; then
  # Lệnh seed thủ công riêng: docker-entrypoint.sh seed [--sync-destinations]
  #   seed                      : idempotent, chỉ tạo dữ liệu nếu DB đang rỗng
  #   seed --sync-destinations  : mã hoá lại config các đích seed từ env hiện tại (S1-7), không đụng bảng khác.
  #                               Thiếu HUB_SIGNING_SECRET/SHOP_WEBHOOK_URL/MOCK_BASE_URL... -> exit 2, trừ khi thêm --allow-defaults
  # Gọi thẳng workspace để cờ đi tới ts-node, không bị npm gốc nuốt mất.
  echo "==> [seed] Chạy seed thủ công $*"
  npm run prisma:seed --workspace=libs/database -- "$@"
elif [ "$SERVICE" = "hub-api" ]; then
  # S1-6 (ADR-047): migrations có phiên bản, KHÔNG BAO GIỜ `db push` (cờ chấp nhận mất dữ liệu) — lệnh đó
  # từng xoá dữ liệu khi image nạp nhầm bản build cũ (BB09 P0-1). migrate deploy chỉ chạy migration
  # chưa áp dụng, không tự sinh thay đổi phá dữ liệu. Neon: dùng DIRECT_URL (directUrl trong schema).
  echo "==> [hub-api] Applying database migrations (prisma migrate deploy)..."
  npx prisma migrate deploy --schema=libs/database/prisma/schema.prisma
  # Seed chạy khi RUN_SEED=true (docker-compose local mặc định true — review #7, ADR-066). Seed idempotent:
  # DB đã có source thì bỏ qua NGAY, không tạo thêm, không ghi đè, không xoá (BB-2). Deployed (Render) không
  # đặt RUN_SEED -> không chạy; gọi riêng: docker-entrypoint.sh seed
  if [ "$RUN_SEED" = "true" ]; then
    echo "==> [hub-api] RUN_SEED=true, chạy seed (idempotent, chỉ tạo dữ liệu nếu DB đang rỗng)..."
    npm run prisma:seed || true
  else
    echo "==> [hub-api] Bỏ qua seed (RUN_SEED không phải 'true'). Dùng RUN_SEED=true hoặc 'docker-entrypoint.sh seed' để seed thủ công."
  fi
  echo "==> [hub-api] Starting Webhook Hub API..."
  # Chạy bản đã build (dist/main.js) chứ không phải `npm run start:api` (root script
  # đó trỏ ts-node/start:dev, dùng cho hot-reload LOCAL ngoài container) -- container
  # đã build sẵn ở bước docker build, chạy dev server lại vừa lãng phí vừa sai tinh
  # thần "image production, mở lên là chạy".
  exec npm run start --workspace=apps/hub-api
elif [ "$SERVICE" = "hub-worker" ]; then
  echo "==> [hub-worker] Starting Webhook Hub Worker..."
  # node phai la PID 1 de NHAN SIGTERM truc tiep (graceful shutdown cho handler dang chay xong,
  # review SPEC-1 #3). `npm run` boc qua npm + sh: SIGTERM giet sh/node truoc khi handler kip chay.
  cd apps/hub-worker && exec node dist/apps/hub-worker/src/main.js
elif [ "$SERVICE" = "shop" ]; then
  echo "==> [shop] Starting Demo Shop..."
  exec npm run start --workspace=apps/shop
elif [ "$SERVICE" = "web" ]; then
  echo "==> [web] Starting Web Dashboard..."
  exec npm run start --workspace=apps/web
else
  exec "$SERVICE" "$@"
fi