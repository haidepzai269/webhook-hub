# Câu cần Admin quyết / làm — SPEC-ket-noi (phiên DEV KN, 2026-10-11)

Phiên dev không chờ: mỗi câu ghi mặc định đã làm. Admin đổi thì báo, phiên sau sửa.

## KQ1 — Request kiểm tra của PayOS lúc `confirm-webhook` có thành `payment.received` không? (CHẶN một phần KN3)

- **Đã có:** connector PayOS, cảnh báo ghi đè + `acknowledgeOverwrite`, fake PayOS (bắn request kiểm tra có chữ ký theo mẫu tài liệu).
- **Chưa có bằng chứng bản thật.** Tài liệu chính thức (payos.vn/docs/api, mục confirm-webhook) chỉ nói PayOS gửi "dữ liệu mẫu kèm thông tin giao dịch ngân hàng mẫu"; không có cờ/trường đánh dấu kiểm tra. Mẫu webhook trong tài liệu: `orderCode 123`, `amount 3000`, `description "VQRIO123"`, `accountNumber "12345678"`, `reference "TF230204212323"`, `paymentLinkId "124c33293c43417ab7879e14c8d9eb18"` — có thể chính là request đó, nhưng chưa ai thấy.
- **Mặc định đã làm:** hook `isPayosConfirmProbe()` trong `libs/providers/src/payos.adapter.ts` (BB-1: chỉ trong adapter), hiện LUÔN `false` + TODO. Hành vi hiện tại: request kiểm tra được lưu raw, trả 200, và **đi tiếp như giao dịch thường** (sẽ ra `payment.received` 3.000đ với memo `VQRIO123` nếu chữ ký đúng). Shop an toàn (tra theo mã đơn `DH…` + allowlist), service khác subscribe `payment.received` thì có thể thấy "tiền ma" 3.000đ.
- `[KN:U16]` để **mồ côi có lý do** trong `verify/spec-sources.json` (không `it.skip` — gate cấm).
- **Admin cần:** sau khi bấm "Kết nối PayOS" trên bản deployed (§8.4), cho coordinator lấy `raw_events` mới nhất của source PayOS đó (body đã che) → ghi §11. Nếu đúng là mẫu tài liệu thì phiên sau cài nhận diện theo bộ trường đó + ADR.
- **Câu kèm cần chốt khi cài:** request kiểm tra nên (a) normalize ra `[]` (không event — nhưng raw_event ACCEPTED không có event sẽ hiện ở danh sách "mồ côi" của renormalize, cần đánh dấu riêng), hay (b) ra một kiểu không thuộc catalog thanh toán, vd `payos.webhook_test` (`normalized:false`) — vẫn có event để truy vết, không ai subscribe `payment.*` nhận. Phiên dev nghiêng **(b)** vì không phải sửa lõi.

## Q2 — Env trên Render/Vercel cho KN (không đổi gì nếu không dùng)

- Không có env BẮT BUỘC mới. `HUB_PUBLIC_URL` (đã có) phải là URL https công khai của hub-api — "Kết nối PayOS" từ chối localhost/IP nội bộ.
- **KHÔNG** đặt trên production: `PAYOS_FAKE_BASE_URL`, `STRIPE_FAKE_BASE_URL`, `GITHUB_FAKE_BASE_URL`, `CONNECTOR_INGEST_BASE_URL`, `PAYOS_BASE_URL` (hub-api không khởi động nếu có một trong bốn biến đầu; biến cuối hub không đọc nhưng SDK PayOS thì đọc).
- Migration mới `20261012010000_source_connections` chạy ở lần deploy tới (entrypoint `migrate deploy`), có GRANT cho `hub_app` (Neon: role do Admin tạo trong console — GRANT trong migration chạy nếu role tồn tại).

## Q3 — L2 `[KN:T1..T4]` chưa chạy

Cần image hub-api/web mới cho stack `hubv` + đặt trong `.env.verify`: `PAYOS_FAKE_BASE_URL=http://sink:4100/_fake/payos`, `STRIPE_FAKE_BASE_URL=http://sink:4100/_fake/stripe`, `CONNECTOR_INGEST_BASE_URL=http://hub-api:4000`, và env của sink `FAKE_PAYOS_CLIENT_ID/API_KEY/CHECKSUM_KEY` (mặc định giả có sẵn). Phiên dev không được rebuild/restart hubv (VF đang chaos). Mặc định: các mã T để mồ côi có lý do; phiên sau (hoặc VF) viết kịch bản `verify/scenarios` khi hubv được rebuild.
