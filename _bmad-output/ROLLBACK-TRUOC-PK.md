# Mốc rollback trước đợt PK ("Provider khác" bản 2), ghi 2026-10-13 tối

Bản production đang chạy ổn **trước** khi bất kỳ commit PK nào lên master:

| Nơi | Commit | Kiểm bằng |
|---|---|---|
| **master (GitHub)** | `57c81ad2045ea2d74e1a9d039bed62ff8288b8db` (`57c81ad`, 2026-10-13 18:16 +07) | `git log`; CI `verify` xanh |
| **Vercel (web, frontend)** | `57c81ad`, deployment Production lúc 2026-10-13T11:31:30Z | GitHub Deployments API (`environment: Production`) |
| **Render (hub-api, hub-worker, shop; backend)** | `57c81ad`, auto-deploy từ master | Render chưa báo commit về GitHub; xem ở Render dashboard → service → Events |

Migration Neon mới nhất tại mốc này: `20261013120000_circuit_half_open_at` (đã áp, kiểm read-only 2026-10-13).

## Cách quay lại nếu bản PK lỗi

- **Vercel:** Dashboard → project web → Deployments → chọn deployment của `57c81ad` → "Promote to Production" (hoặc "Instant Rollback").
- **Render:** Dashboard → từng service (hub-api, hub-worker; shop nếu đổi) → Deploys → deploy của `57c81ad` → "Rollback to this deploy".
- **Migration PK** (nếu có): Prisma không tự down. Rollback code về `57c81ad` vẫn chạy được với cột/bảng mới **nếu** migration PK chỉ THÊM cột có DEFAULT/nullable (spec PK yêu cầu vậy). Không xoá cột bằng tay khi chưa hỏi phòng.
- **Git:** không force-push. Muốn gỡ trên master thì `git revert` các commit PK.

Commit PK đầu tiên trên master sẽ được ghi thêm vào đây khi merge.

## Nhật ký gộp PK vào master

| Thời điểm | master | Gồm | Ghi chú |
|---|---|---|---|
| 2026-10-14 đêm (chặng 1) | `314ace0..9d84dcd` | PK0, PK1, PK2 (code đầu tiên: `10afed4`) | Không có migration. Rollback code = quay về `57c81ad` (hoặc `314ace0`, chỉ thêm docs) |
| 2026-10-14 đêm (chặng 2) | `e6d61d6..8bcb4fa` | PK3 (signed-template), PK9 (danh mục 21 mục + identify + GET /api/v1/catalog), sửa hub-api khởi động (ADR-210) | Không có migration. CI e2e của `a4094b3` xanh. Mốc an toàn trước chặng 2: `e6d61d6` (= PK0–PK2) |
| 2026-10-14 sáng sớm (chặng 3) | `1aedcf2..db875bd` | PK4 (bắt tay khai báo được, GET chỉ cho bắt tay, HEAD `head-ok`, ack 200/202/204 · 401/403/503), mã lỗi mới `method_not_allowed`/`handshake_invalid`/`uri_too_long`, danh mục 24 mục | Không có migration. CI e2e của `a8abda4` xanh. Mốc an toàn trước chặng 3: `1aedcf2` |
| 2026-10-14 sáng (chặng 4) | `83d59d8..75e8484` (merge) | PK5 nguồn `unverified` (4 khoá, nhãn "Chưa xác thực", polling scope `read:unverified`), momo + twilio vào danh mục (26 mục) | **CÓ migration** `20261014090000_unverified_sources`: chỉ thêm 4 cột DEFAULT. Rollback code về `83d59d8`/`2b38a8d` vẫn chạy với cột thừa. Lưu ý: code cũ không lọc `events.verified=false` ở polling (chỉ có dữ liệu như vậy nếu owner đã bật cờ). Không DROP cột khi chưa hỏi phòng |
| 2026-10-14 trưa (chặng 5) | `c6911f6..4946b5d` (merge) | PK10 chống trùng theo id lồng (`idempotency.path` ≤ 3 cấp) + `bodyHash` + mã lỗi `empty_body`, danh mục 31 mục (pipedrive chỉ webhook v2), ADR-230 | Không có migration. CI e2e của `c948572` xanh. Mốc an toàn trước chặng 5: `c6911f6`. Lưu ý: id số > 2^53 đổi khoá chống trùng (chỉ có thể nhận trùng lúc deploy, không mất) |
| 2026-10-14 tối (lưới hứng chặng 1) | `35918bd..ab8e897` (merge) | §9 `HUB_INGEST_PUBLIC_URL` (ADR-211), LH3 hub nhận request từ lưới (ADR-217/221), spike LH-S; trước đó cùng tối gộp UI modal/scroll `35918bd` | **CÓ migration** `20261014150000_raw_events_via`: chỉ thêm cột NULL + CHECK NOT VALID. Rollback code về `35918bd` vẫn chạy với cột thừa. Lưới TẮT tới khi đặt `CATCHNET_FORWARD_SECRET`. Header `x-hub-outcome` có trên mọi phản hồi `/hooks` |
