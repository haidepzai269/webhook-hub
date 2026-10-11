#!/usr/bin/env bash
# S1-8 — Smoke e2e. VF4 (SPEC-verification §7.2): bản bash cũ đã được thay bằng runner L2 viết bằng TypeScript
# (verify/scenarios/ingest-e2e.ts, tag `smoke`). File này giữ làm VỎ để lệnh cũ trong tài liệu vẫn chạy.
#
#   bash scripts/e2e-smoke.sh      == npm run verify:e2e -- --tag smoke
#
# Chạy vào stack kiểm chứng `hubv` (npm run verify:up), KHÔNG vào stack dev: kịch bản đăng ký dev mới qua mail
# capture, tạo source/endpoint riêng mỗi lượt, bắn fixture hub-sim, kiểm ký sai 401 · gửi lại 3 lần → 1 event ·
# push Standard Webhooks verify độc lập · delivery SUCCEEDED · outbox sạch secret · shop_user không đọc được hub.
set -eu
cd "$(dirname "$0")/.."
exec npm run -s verify:e2e -- --tag smoke "$@"
