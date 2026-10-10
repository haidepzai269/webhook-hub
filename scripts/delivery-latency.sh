#!/usr/bin/env bash
# R-4 (ADR-119): độ trễ đường giao của một lượt k6/delivery-e2e.js, đọc từ Postgres của hubv (owner, chỉ đọc).
#   bash scripts/delivery-latency.sh <RUN>
# e2e   = raw_events.received_at (hub nhận, đã COMMIT) -> deliveries.updated_at khi SUCCEEDED
# giao  = deliveries.created_at (normalize tạo delivery) -> SUCCEEDED   (chặng outbox + delivery consumer + HTTP tới sink)
set -eu
RUN="${1:?thiếu RUN (in ra ở cuối lượt k6)}"
PG=${PG_CONTAINER:-$(docker compose -p hubv -f docker-compose.yml -f docker-compose.verify.yml --env-file .env.verify ps -q postgres)}
docker exec "$PG" psql -U hub_user -d webhook_hub -tA -F ' | ' -c "
WITH d AS (
  SELECT extract(epoch FROM (dl.updated_at - r.received_at)) * 1000 AS e2e_ms,
         extract(epoch FROM (dl.updated_at - dl.created_at)) * 1000 AS giao_ms,
         dl.status
  FROM hub.events e
  JOIN hub.raw_events r ON r.id = e.raw_event_id
  JOIN hub.deliveries dl ON dl.event_id = e.id
  WHERE e.data->>'run' = '$RUN'
)
SELECT 'n=' || count(*) || ' succeeded=' || count(*) FILTER (WHERE status = 'SUCCEEDED'),
       'e2e p50=' || round(percentile_cont(0.5) WITHIN GROUP (ORDER BY e2e_ms)::numeric, 1)
         || ' p95=' || round(percentile_cont(0.95) WITHIN GROUP (ORDER BY e2e_ms)::numeric, 1)
         || ' p99=' || round(percentile_cont(0.99) WITHIN GROUP (ORDER BY e2e_ms)::numeric, 1),
       'giao p50=' || round(percentile_cont(0.5) WITHIN GROUP (ORDER BY giao_ms)::numeric, 1)
         || ' p95=' || round(percentile_cont(0.95) WITHIN GROUP (ORDER BY giao_ms)::numeric, 1)
         || ' p99=' || round(percentile_cont(0.99) WITHIN GROUP (ORDER BY giao_ms)::numeric, 1)
FROM d WHERE status = 'SUCCEEDED';"
