# Điều phối các agent (ghi trước /compact, 10/10 tối)

## Agent đang có (gọi lại bằng SendMessage theo id)
| Vai | Agent id | Trạng thái | Việc tiếp |
|---|---|---|---|
| Dev đa service | `aaf03f036f2b52ad2` | **XONG** P2-1..6 (`3ef6339` `5a047c6` `0209a98` `f44f711`+`cfac69b` `a193aad` `b5d0f91`, ADR-088..093), smoke xanh, Redis chết ingest 17–44ms | — |
| Dev UI Event Flow | `a2f27e5a7dec66849` | **ĐANG CHẠY F7** (giao 10/10). Nhánh `feat/event-flow-ui` (worktree `.claude/worktrees/agent-a2f27e5a7dec66849`), F1–F5 + chỉnh hình thức `e1d8694`, đã dừng | **F7**: rebase lên master sau đa service, sửa theo §6A + X17 (`EventOrigin` thêm `api`, `ProjectScopeGuard`, cột `verification`/`source_ids`…), test + build + chụp lại ảnh, rồi coordinator merge |
| Dev VF → Auth | `aa0f047fc964219f3` | Xong VF1/VF2/VF7, đang chờ | Sau F7: AU1–AU6 theo `auth/DINH-CHINH-AUTH-2026-10-10.md` (giờ đã có projects/api_keys của đa service → §2 cắt giảm hết hiệu lực) |
| Review | (tạo mới mỗi lần) | Pha 1 và pha 2 đã xong | Review lại sau F7/merge và sau auth. **Cấm worktree/junction/lệnh git làm đổi file** (sự cố pha 1) |
| Phiên party mode khác | `webhook-hub-54` (cross-session) | Viết spec, không code | Nhắn khi có thay đổi spec; bên này commit gộp spec cho họ |

## Luật chung
- Không push. Mỗi story một commit. `npx jest -w 2` / `verify:*`.
- Stack dev `webhook-hub`: không `down -v`. `hubv`: tự do.
- Đĩa: kiểm `df -h /c` trước build, `docker builder prune -f` sau build, < 10GB thì dừng.
- Telegram thật luôn TẮT.
- Commit file planning gộp khi cần (đã làm `c79e539`, `04be2ba`, `567e40e`).

## Thứ tự còn lại
dev đa service xong P2-5/6 → **F7** UI → merge `feat/event-flow-ui` → review → **AU1–AU6** → review → VF3…VF8 → DX1–DX3.

## Mở cho Admin
- Push / CI thật chưa chạy (repo sẽ public).
- Các mục Thấp để lại: ADR-087 (MS-R5 a–d, R6), MS-P2 chưa kiểm: Socket.IO T14.4, DNS rebinding, cửa sổ lắng > 2s.

## Lệnh Admin (10/10, sau compact) — chuỗi chạy tự động, báo Admin ở cuối
1. [XONG: ff master → 1a43972] F7 UI xong → coordinator merge `feat/event-flow-ui` vào master.
2. [Review 1 xong: MS-P2-1 FAIL (R-1 Cao lỗ mới qua subscription trỏ endpoint shop), R-2/R-3 TB, UI R-4/5/6/9. Đã sửa: R-1/2/3/7 (91157b6 59a8c9d 9f1a25d 40418f6), UI R-4/5/6/9 merge 5358103 (L0 557, L1 93). Review vòng 2: R-1..R-9 PASS; phát hiện mới R2-1 TB (Shop bỏ ensure sau 6 lần → 503 vĩnh viễn), R2-* đã sửa (2956f31..2f1eb63). Vòng 3: PASS-có-điều-kiện, còn Thấp R3-* đã sửa 922fa54 c1c291f bee9b7b (L0 567, L1 95). XONG bước 2] Agent review mới: review đa service (MS-P2-1..6) + giao diện sau F7. Có lỗi → giao dev sửa → review lại.
3. [XONG: 7 commit 2564d5e..30d7338, ADR-103..108, L0 597 L1 131; hubv đã down -v; stack dev chưa build lại]  Resume agent auth `aa0f047fc964219f3`: AU1–AU6 (khớp code đa service).
4. [Review auth vòng 1 xong (a29253a78aa17c400): Cao R-2 rate limit chung IP proxy, R-7 FORCE RLS chặn owner Neon; TB R-1 R-3 R-4 R-5 R-6 R-8 → agent auth cũ aa0f047 hết ngữ cảnh giữa R-1 (diff chưa commit); agent dev MỚI a79fcf9fb84cd4ec5 sửa tiếp, log ở auth/RESUME-auth-fixes.md → XONG 13/14 (275abbd..fa20f49, ADR-109..120, L0 611 L1 136, gates 14), R-9 hoãn A7; Admin cần quyết A7–A11. Review auth vòng 2: 13 mục đứng vững; MỚI N-1 Cao (chiếm tài khoản bằng đăng ký trước, do bản sửa R-6), N-2 TB open redirect, N-3/N-4 Thấp → ĐÃ SỬA 752d4bd 25d3505 a20f0e3 7f4ae67 (ADR-121..123, L0 628 L1 138, e2e auth 17/17). Review auth vòng 3: AU1–AU4 Đạt, AU5 Đạt có điều kiện (TA11 tay), AU6 Đạt. XONG] Agent review mới: review auth.
5. [XONG 11/10: verify L0 628 L1 138, gates 14/0, bất biến OK] Coordinator review lần cuối toàn bộ → báo Admin.
6. [XONG: stack dev build lại từ 7f4ae67, migration + hub_app OK, SePay → shop SUCCEEDED, chống trùng OK; hubv chạy HEAD] Kiểm tra đã build lại image docker + container chưa (stack dev `webhook-hub` và `hubv` chạy đúng code master mới nhất: so thời điểm build image với commit cuối, `docker compose ps` healthy, smoke xanh). Chưa → build lại (kiểm đĩa trước, `builder prune -f` sau, không `down -v` stack dev).

Admin đi ngủ (10/10 tối): tự chạy hết 1→6. Vấn đề quá lớn không tự quyết được → ghi vào `_bmad-output/planning-artifacts/CAN-ADMIN-QUYET-2026-10-10.md`, không dừng cả chuỗi nếu còn việc khác làm được. Xong cả 6 mới báo.
