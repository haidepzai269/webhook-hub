# Quickstart — event đầu tiên trong 60 giây

> Từ lúc có connection string tới lúc app của bạn in ra event đầu tiên. Không cần ngrok, không cần provider thật.
> Lệnh viết cho bash; PowerShell thay `export X=…` bằng `$env:X="…"`.

## 1. Lấy connection string

Console → **Project → Keys → Tạo key**, chọn scope `read:events` (thêm `publish:events` để bắn thử ở bước 5). Key chỉ hiện **một lần**.

```bash
export HUB_URL="hub://hk_test_…@localhost:4000/cafe"        # local (docker compose): hub:// = http
# export HUB_URL="hubs://hk_live_…@<hub-api>.onrender.com/<project>"   # bản deploy: hubs:// = https
```

## 2. Cài SDK

SDK chưa publish lên npm — cài từ repo (một lần):

```bash
npm install && npm run build -w libs/common -w libs/hub-sdk          # ở gốc repo
cd examples/quickstart-node && npm install                          # app mẫu: @hub/sdk = file:../../libs/hub-sdk
```

## 3. Mở `hub listen` (trong `examples/quickstart-node`)

```bash
npx hub listen --forward http://localhost:3000/webhooks
# Connected to project "cafe" as service "…" (key hk_test_••••abcd)
# Your local signing secret: whsec_… (set HUB_LISTEN_SECRET to keep it stable)
```

Copy dòng `whsec_…` (hoặc đặt sẵn `export HUB_LISTEN_SECRET=whsec_…` trước khi chạy để secret không đổi mỗi lần).
Stack local build trước DX3 (chưa có `after=latest`) → `docker compose up -d --build hub-api`, hoặc tạm thêm `--from 0` (forward cả lịch sử của project).

## 4. Chạy app mẫu (terminal khác)

```bash
cd examples/quickstart-node && HUB_LISTEN_SECRET="whsec_…" node index.js
# Listening on http://localhost:3000/webhooks
```

## 5. Bắn thử (terminal thứ ba, trong `examples/quickstart-node`, cùng `HUB_URL`)

```bash
npx hub trigger payment.received --data '{"amount":50000}'     # cần scope publish:events
# app mẫu in:  payment.received 50000 evt_01…
# listen in:   14:02:37  payment.received  evt_01…  → 200 (12 ms)
```

Không có `publish:events`? Bắn mock SePay vào source của project (vd `docs/DEMO-MULTI-PROJECT.md`) — kết quả như nhau.

---

- **Bản deploy (`hubs://…`)**: bước 3–5 y hệt — `listen` kéo sự kiện qua https về máy bạn, không cần mở cổng. Khi service
  của bạn đã có URL công khai thì đăng ký endpoint thật (`hub.endpoints.ensure`, push Standard Webhooks) và đổi
  `HUB_LISTEN_SECRET` thành `HUB_SIGNING_SECRET` của endpoint. Đừng đăng ký `localhost` — hub chặn (`ssrf_blocked`).
- Gặp lỗi: mọi lỗi có `error` + `fix` + `requestId` — tra `docs/ERRORS.md`.
- Tò mò bên trong: `docs/ARCHITECTURE.md` (mục "Trải nghiệm dev").
