# Việc cần làm tay để Stripe adapter hoạt động thật

`StripeAdapter` đã code xong, build + test pass (`libs/providers/src/stripe.adapter.ts`, đăng ký ở
`provider.registry.ts`). Còn 2 việc **không thể tự động hoá từ phiên làm việc này** — cần bạn chạy tay.

## 1. Áp dụng enum `stripe` mới vào Postgres thật

`ProviderEnum` trong `libs/database/prisma/schema.prisma` đã thêm giá trị `stripe`, và
`prisma generate` đã chạy (chỉ update TS types, không chạm DB). Nhưng Postgres thật **chưa biết**
giá trị enum mới này vì Docker không chạy trong phiên vừa rồi (`docker ps` không kết nối được daemon).

```bash
docker compose up -d          # bật lại hạ tầng (postgres/redis/rabbitmq/...)
npm run prisma:migrate --workspace=libs/database
# nếu lệnh trên đòi migration history mà repo chưa có (không có thư mục
# libs/database/prisma/migrations/), dùng thay:
npx prisma db push --schema=libs/database/prisma/schema.prisma
```

Không làm bước này thì tạo `Source` với `provider: stripe` sẽ bị Postgres từ chối (enum không hợp lệ).

## 2. Tạo `Source` + `SourceSecret` cho Stripe để test thật

Giống 3 provider kia (payos/sepay/github) — hiện Stripe **chưa có source mẫu nào trong seed**. Cần:

1. Tạo `Source` với `provider: 'stripe'`, `sourceKey` tuỳ chọn (dùng trong URL ingest:
   `POST /hooks/stripe/<sourceKey>`).
2. Tạo `SourceSecret` với `secretEncrypted` = mã hoá AES-256-GCM (bằng `MASTER_KEY`) của
   **signing secret** Stripe cấp khi tạo webhook endpoint trên dashboard/CLI (dạng `whsec_...`).
   Đây chính là secret truyền vào `stripeClient.webhooks.constructEvent()` bên trong adapter.
3. Test nhanh không cần tài khoản Stripe thật: dùng Stripe CLI (`stripe listen --forward-to
   localhost:4000/hooks/stripe/<sourceKey>`) hoặc `stripe trigger payment_intent.succeeded` — CLI
   tự cấp `whsec_...` tạm và tự ký request, không cần key thật/không tốn tiền.

Chưa làm bước này thì `StripeAdapter` có tồn tại trong registry nhưng **không có source nào trỏ tới
nó** — mọi request `/hooks/stripe/...` sẽ bị 404 ở bước tìm source (`ingest.service.ts:54-57`).
