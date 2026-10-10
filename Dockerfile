FROM node:22-slim

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
ARG NEXT_PUBLIC_DEMO_SIMULATE=""
ARG NEXT_PUBLIC_DEMO_SEPAY_APIKEY=""
ENV NEXT_PUBLIC_DEMO_SIMULATE=$NEXT_PUBLIC_DEMO_SIMULATE     NEXT_PUBLIC_DEMO_SEPAY_APIKEY=$NEXT_PUBLIC_DEMO_SEPAY_APIKEY
# S1-6 (ADR-047): lớp chặn thứ hai sau .dockerignore — không bao giờ build/nạp dist cũ (BB09 P0-1).
RUN rm -rf libs/*/dist apps/*/dist
RUN npm run build

# Entrypoint script
COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENTRYPOINT ["docker-entrypoint.sh"]
