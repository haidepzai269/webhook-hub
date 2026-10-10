# k6 — đo tải ingest (S3-4)

**Mọi số liệu báo cáo lấy ở LOCAL** (`docker compose`), không qua tunnel, không trên Render (ADR-019, CLAUDE.md cạm bẫy 5).

## Chuẩn bị

Trần rate limit mặc định là 100 request/phút/source — k6 sẽ nhận 429. Nâng trần cho lần đo:

```bash
INGEST_RATE_LIMIT_PER_MIN=100000 docker compose up -d hub-api
```

Đo xong trả về mặc định: `docker compose up -d hub-api`.

## Chạy

```bash
# Linux / máy có --network host:
docker run --rm -i --network host -e HUB_URL=http://localhost:4000 grafana/k6:0.54.0 run - < k6/ingest-github.js

# Docker Desktop Windows/macOS (vào thẳng mạng compose, vẫn là local):
docker run --rm -i --network webhook-hub_default -e HUB_URL=http://hub-api:4000 grafana/k6:0.54.0 run - < k6/ingest-github.js

# Chạy ngắn (mỗi bậc 20s thay vì 60s):
docker run --rm -i --network webhook-hub_default -e HUB_URL=http://hub-api:4000 -e STAGE_S=20 grafana/k6:0.54.0 run - < k6/ingest-github.js
```

Ba bậc 10 → 50 → 100 RPS (`ramping-arrival-rate`). Ngưỡng: `http_req_duration p(95) < 200ms`, `http_req_failed < 1%`.
k6 in bảng tổng kết cuối lượt; exit ≠ 0 nếu vượt ngưỡng.

Sự kiện mặc định `X-GitHub-Event: k6_load` → kiểu `github.k6_load` (`normalized:false`) không khớp subscription nào,
nên chỉ đo chặng ingest và **không** gửi Discord/Telegram. Muốn đo cả chặng gửi: tạo subscription `github.k6_load` tới
một đích mock (`http://hub-api:4000/mock/discord`).

## Đọc kết quả

- Bảng tổng kết của k6 (p95, tỉ lệ lỗi).
- Grafana `http://localhost:3001` (admin/admin) → thư mục **Webhook Hub** → dashboard **Webhook Hub**: RPS theo provider,
  p50/p95/p99 ingest, ACCEPTED/REJECTED/DUPLICATE, delivery theo trạng thái, outbox lag, circuit.
- Thô: `curl -s localhost:4000/metrics | grep hub_ingest`.

## Đường giao (R-4, ADR-119)

```bash
# stack hubv (npm run verify:up), k6 trên máy (bắn localhost — không qua tunnel):
HUB_URL=http://localhost:14000 RPS=30 DURATION_S=60 k6 run k6/delivery-e2e.js   # in RUN=<id> ở cuối
bash scripts/delivery-latency.sh <RUN>                                           # p50/p95/p99 event → SUCCEEDED (Postgres hubv)
# Thời gian worker xử lý một message (histogram trong bộ nhớ, đọc trong mạng compose):
docker compose -p hubv -f docker-compose.yml -f docker-compose.verify.yml --env-file .env.verify exec -T hub-worker \
  node -e 'fetch("http://127.0.0.1:9101/metrics").then(r=>r.text()).then(t=>console.log(t.split("\n").filter(l=>l.startsWith("hub_delivery_handle_seconds_")).join("\n")))'
```

So sánh chế độ: khởi động lại hub-worker (xoá histogram) với `RLS_HOT_BATCH=0` (transaction tương tác) hoặc mặc định (batch).
