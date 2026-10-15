# catchnet-spike — Worker nháp `hub-hooks-spike` (LH-S)

Spike vứt đi được cho SPEC-hub-sap §7b. **Không** thuộc npm workspaces của hub, không vào build/CI.
Tên Worker cố định `hub-hooks-spike` — **không bao giờ** dùng tên thật `hub-hooks`.

Route:
- `ANY /hooks/*` → ghi D1 (method, URL đầy đủ, header JSON, độ dài, sha256, body ≤ 1MB) → `200 {"ok":true}`; `/hooks/momo/*` → `204`.
- `GET /_spike/dump?token=…[&kind=hook|cron_tick][&limit=50]` → các dòng, body base64.
- `GET /_spike/latency?token=…&target=<HUB_ORIGIN_URL…>&n=20` → p50/max (S7). Chỉ nhận target cùng origin với `HUB_ORIGIN_URL`.
- `GET /_spike/noop` → `200` (đích fan-out S6).
- Cron mỗi phút → dòng `cron_tick`; đặt `SPIKE_FANOUT_URL` thì thêm 25 fetch và ghi số thành công/lỗi vào `note`.

## Chạy local

```sh
cd spikes/catchnet-spike
npm ci
echo "SPIKE_DUMP_TOKEN=$(openssl rand -hex 32)" > .dev.vars   # .dev.vars đã .gitignore
npm run db:local
npx wrangler dev --local --port 8787
# máy khác: curl --data-binary @file http://127.0.0.1:8787/hooks/x/y ; curl "http://127.0.0.1:8787/_spike/dump?token=…"
```

## Deploy (cần `npx wrangler whoami` đã đăng nhập)

```sh
npx wrangler d1 create hub-hooks-spike-db        # chép database_id vào wrangler.toml
npm run db:remote
npx wrangler secret put SPIKE_DUMP_TOKEN         # dán từ stdin
npx wrangler deploy
```

## Dọn

```sh
npx wrangler delete hub-hooks-spike
npx wrangler d1 delete hub-hooks-spike-db
```
Xoá webhook nháp ở Stripe/GitHub/SePay; ghi lại vào `_bmad-output/planning-artifacts/hub-sap/SPIKE-workers-dev.md` mục "Đã dọn".
