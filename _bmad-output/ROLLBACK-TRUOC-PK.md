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
