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
