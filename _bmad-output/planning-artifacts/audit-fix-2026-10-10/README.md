# Vá biên bản kiểm chứng 09/10 — bộ spec cho phiên dev

> Ngày 10/10/2026, phiên party mode (Winston, Amelia, Mary, John, Sally cùng Admin).
> **Nguồn vấn đề:** `_bmad-output/party-mode/kiem-chung-phu-luc-2026-10-09.html` (gọi tắt **BB09**).
> **Hiện trạng đối chiếu ngày 10/10:** bảng ở §3. Đọc code là chính, vì lúc kiểm Docker đang tắt.

## 1. Phạm vi (Admin chốt 10/10)

- **Làm:** vá mọi vấn đề BB09 nêu ra mà **chưa** được sửa.
- **KHÔNG làm (để phiên đa service sau, xem `planning-artifacts/hub-multi-service/HANDOFF-2026-10-09.md`, ADR-038..040):**
  - Câu 8 BB09 (polling): feed tăng dần, `types=`, API key `hk_…`, long-poll, script consumer mẫu. **Không sửa `GET /api/v1/events`**, kể cả phần `after` đi lùi. Dashboard vẫn dùng nó như hiện tại.
  - Câu 9 BB09 phần mô hình: bảng `tenants`, khoá ngoại ghép theo tenant, RLS, tenant thứ hai trong seed. Lý do: ADR-038 đổi nghĩa `tenant_id` thành project, làm bây giờ là làm hai lần.
  - Đổi header ký push sang Standard Webhooks (ADR-040) và challenge endpoint.
  - Lọc subscription theo source.
- **Vẫn làm dù nằm ở câu 9**, vì đây là lỗ BB-5 hiện tại, không phụ thuộc mô hình Project:
  - kiểm `destinationId` cùng tenant khi tạo subscription;
  - normalize đọc `raw_events` không qua repository;
  - tách user DB cho Shop.
- **Không làm vì cần tài khoản của Admin:** cloudflared named tunnel, seed source Stripe. Ghi vào báo cáo là việc của Admin.

## 2. Thứ tự làm — 3 đợt, mỗi đợt tự demo được

| Đợt | File | Chủ đề | Ước tính |
|---|---|---|---|
| 1 | [`SPEC-1-khong-mat-khong-lo.md`](SPEC-1-khong-mat-khong-lo.md) | Không mất sự kiện, không lộ secret, không xoá DB | ~1 ngày |
| 2 | [`SPEC-2-nhin-thay-duoc.md`](SPEC-2-nhin-thay-duoc.md) | Circuit thật, trace realtime, audit + replay hàng loạt, dashboard vẽ dữ liệu thật | ~1 ngày |
| 3 | [`SPEC-3-dung-chuan.md`](SPEC-3-dung-chuan.md) | Chữ ký, chuẩn hoá sự kiện, `/metrics` + Grafana + k6, ngân sách Redis, sửa tài liệu cho trung thực | ~1 ngày |

- Làm **tuần tự**: đợt 2 dựa trên định dạng message mới của đợt 1.
- Xong mỗi đợt thì commit riêng một lần, với message `fix(audit-0910): đợt N — …`.
- [`REVIEW-CHECKLIST.md`](REVIEW-CHECKLIST.md) ánh xạ **từng mục BB09 → story → lệnh kiểm**. Phiên review sẽ chạy đúng file này.

## 3. Hiện trạng 10/10 (đối chiếu BB09)

| BB09 | Mục | Hiện trạng | Story |
|---|---|---|---|
| P0-1 | Worker nạp `dist` cũ → xoá DB, normalize chết | 🟡 Image sạch nhờ `.dockerignore`, nhưng `libs/*/dist` vẫn còn trên máy và chưa có kiểm tra lúc khởi động | S1-6 |
| P0-1 | `db push --accept-data-loss` | 🔴 | S1-6 |
| P0-2 | SSRF `{all:true}` | ✅ `ssrf.ts:118-120` + test TCP thật | — (chỉ thêm kiểm qua axios, S1-7) |
| P0-3 | URL đích localhost trong docker | ✅ ADR-036 · 🔴 không đồng bộ được đích sau khi đã seed | S1-7 |
| 1 | PayOS so sánh `!==` | 🔴 | S3-1 |
| 1 | SePay nhận key thiếu tiền tố `Apikey ` | 🔴 | S3-1 |
| 1 | Khoá chống trùng rơi về `ulid()` | 🔴 | S3-1 |
| 1 | `signature_header` không lưu chữ ký PayOS/Stripe | 🔴 | S3-1 |
| 2 | Thiếu trường CloudEvents, type lệch, PayOS luôn `succeeded`, tiền lệch trường | 🔴 | S3-2 |
| 3 | Không có wildcard `payment.*` · seed `order.paid` | 🔴 | S3-3 |
| 3 | Telegram `parse_mode: Markdown` → 400 → DEAD | 🔴 | S1-7 |
| 3, 6 | Secret giải mã đi qua broker **và nằm trong `hub.outbox`** (nặng hơn BB09) | 🔴 | **S1-1** |
| 4 | normalize → delivery ghi đôi ngoài outbox | 🔴 | S1-2 |
| 4 | Mọi lỗi normalize vào DLQ, không phát lại được | 🔴 | S1-3 |
| 4 | Không tự kết nối lại AMQP | 🔴 | S1-4 |
| 4 | Không có job dọn dẹp | 🔴 | S1-4 |
| 4 | normalize gọi `prisma.rawEvent` trực tiếp (BB-5) — **mới phát hiện** | 🔴 | S1-5 |
| 5 | Không có HALF_OPEN · `circuit_state` không ai ghi · OPEN dồn vào hàng đợi 2h · bộ đếm lỗi không reset | 🔴 | S2-1 |
| 5 | Throttle gọi là token bucket nhưng thực ra là fixed window · retry không có jitter | 🔴 (chỉ sửa tài liệu) | S3-6 |
| 6 | Replay đơn trong 1 transaction | ✅ ADR-031 | — |
| 6 | Replay hàng loạt · audit log | 🔴 | S2-3 |
| 7 | JWT handshake + room tenant | ✅ ADR-035 | — |
| 7 | Không có trace, `delivery.attempt` thiếu trường, không có `circuit.changed`, không ai nghe `hub:alerts` | 🔴 | S2-2 |
| 7 | `successRate` hiện 100% khi chưa có gì | 🟡 | S2-2 |
| 9 | `createSubscription` không kiểm đích cùng tenant | 🔴 | S1-5 |
| 9 | Shop dùng chung `hub_user` | 🔴 | S1-5 |
| Công cụ | Playground PayOS luôn 401 | 🔴 | S2-4 |
| Công cụ | `/metrics` trả 404, Grafana trống, không có k6 | 🔴 | S3-4 |
| Công cụ | Không có test tích hợp | 🟡 | Mỗi story có test riêng + S1-8 |
| DEPLOY | Redis tốn 8–17 lệnh/sự kiện, ngân sách là 4 | 🔴 | S3-5 |

## 4. Luật cho phiên dev (đọc trước khi code)

1. Đọc `CLAUDE.md`, `docs/ARCHITECTURE.md`, rồi spec của đợt đang làm. Bốn bất biến BB-1..BB-5 là luật, không phải gợi ý.
2. **ADR append-only.** Số kế tiếp hiện là **ADR-041**. Kiểm lại cuối file `docs/adr/README.md` trước khi ghi, vì có thể phiên khác đã chiếm số. Mỗi story có ghi "ADR" thì viết 3 dòng (vấn đề / chọn / đánh đổi) **ngay lúc quyết**.
3. **Test trước, code sau** cho mọi story có logic. Chạy `npx jest -w 2`. Chạy song song mặc định sẽ hết RAM và kéo sập Docker Desktop.
4. **Mỗi story đều phải chạy thật trên docker** theo mục "Cách kiểm" trước khi đánh dấu xong. BB09 cho thấy cả 3 lỗi chặn đều lọt qua unit test.
5. Không động vào giao diện ngoài phạm vi story ghi rõ. UI mới (ADR-025..028) vừa xong.
6. `apps/shop` có trần ~300 dòng. Chỉ S3-2 chạm vào Shop, và chỉ để đổi trường đọc.
7. Được phép reset DB local (`docker compose down -v`) khi đổi sang migrations. **Hỏi Admin trước** khi chạy, vì auto-mode sẽ chặn lệnh này.
8. Gặp mâu thuẫn giữa spec và code thật thì **code thật thắng về mặt sự thật**. Ghi mâu thuẫn vào cuối file spec, mục "Lệch khi làm", rồi chọn cách giữ được bất biến.

## 5. Prompt bàn giao (dán vào phiên mới)

```
Đọc _bmad-output/planning-artifacts/audit-fix-2026-10-10/README.md rồi làm SPEC-1 (sau đó SPEC-2, SPEC-3) theo đúng thứ tự story.
Tuân thủ CLAUDE.md. Test trước, chạy `npx jest -w 2`. Mỗi story phải chạy thật trên docker theo mục "Cách kiểm".
ADR bắt đầu từ ADR-041 (kiểm lại số cuối). Xong mỗi đợt thì commit riêng.
Không làm những gì README §1 ghi KHÔNG làm. Cuối mỗi đợt, cập nhật cột "Kết quả" trong REVIEW-CHECKLIST.md.
```
