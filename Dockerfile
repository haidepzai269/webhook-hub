FROM node:22-slim

# EG1 (ADR-175): nginx (gói Debian, bản thường — không Lua) + envsubst (gettext-base) cho cửa vào `edge`.
# Chỉ chạy khi EDGE_NGINX=1 (hub-all) hoặc service `edge` (compose); không bật thì không tiến trình nào dùng.
RUN apt-get update \
    && apt-get install -y --no-install-recommends nginx gettext-base \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy dependency manifests
COPY package*.json ./
COPY apps/hub-api/package.json ./apps/hub-api/
COPY apps/hub-worker/package.json ./apps/hub-worker/
COPY apps/shop/package.json ./apps/shop/
COPY apps/web/package.json ./apps/web/
COPY libs/common/package.json ./libs/common/
COPY libs/crypto/package.json ./libs/crypto/
COPY libs/database/package.json ./libs/database/
COPY libs/messaging/package.json ./libs/messaging/
COPY libs/providers/package.json ./libs/providers/
COPY libs/hub-sdk/package.json ./libs/hub-sdk/

# Install dependencies
RUN npm install

# Copy source code
COPY . .

# Generate Prisma client & build all monorepo workspaces
RUN npm run prisma:generate

# Chỉ service `web` truyền giá trị (docker-compose build.args); các service khác để rỗng
ARG HUB_API_INTERNAL_URL=""
ARG NEXT_PUBLIC_DEMO_SIMULATE=""
ARG NEXT_PUBLIC_DEMO_SEPAY_APIKEY=""
# URL hub-api / shop mà TRÌNH DUYỆT gọi (socket, URL webhook hiển thị). Rỗng -> lib/env.ts rơi về localhost:4000/4001
# (stack dev); stack verify `hubv` đặt :14000/:14001 (docker-compose.verify.yml).
ARG NEXT_PUBLIC_HUB_API_URL=""
ARG NEXT_PUBLIC_SHOP_API_URL=""
ENV HUB_API_INTERNAL_URL=$HUB_API_INTERNAL_URL NEXT_PUBLIC_DEMO_SIMULATE=$NEXT_PUBLIC_DEMO_SIMULATE     NEXT_PUBLIC_DEMO_SEPAY_APIKEY=$NEXT_PUBLIC_DEMO_SEPAY_APIKEY     NEXT_PUBLIC_HUB_API_URL=$NEXT_PUBLIC_HUB_API_URL NEXT_PUBLIC_SHOP_API_URL=$NEXT_PUBLIC_SHOP_API_URL
# S1-6 (ADR-047): lớp chặn thứ hai sau .dockerignore — không bao giờ build/nạp dist cũ (BB09 P0-1).
RUN rm -rf libs/*/dist apps/*/dist
# ADR-253: mặc định KHÔNG build apps/web (Next build OOM >8GB trên Render; web deploy ở Vercel).
# Local compose (service `web`) truyền BUILD_WEB=1.
ARG BUILD_WEB=0
RUN npm run build:server     && if [ "$BUILD_WEB" = "1" ]; then npm run build --workspace=apps/web; fi

# Entrypoint script
COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENTRYPOINT ["docker-entrypoint.sh"]
