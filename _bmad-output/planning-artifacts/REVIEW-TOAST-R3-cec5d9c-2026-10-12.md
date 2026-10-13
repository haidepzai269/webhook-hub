# Review R3 — `cec5d9c` toast/badge theo đồng hồ server (ADR-188) — 2026-10-12

Reviewer: Murat (kiểm thử/rủi ro) + Sally (trải nghiệm). Chỉ đọc, không sửa code.
Bối cảnh: HIGH vòng 1 (REVIEW-TOAST-6ac202a), I2 vòng 2 (REVIEW-TOAST-R2-681b219) — mốc "mới" so `opened_at` (đồng hồ worker) với `Date.now()` trình duyệt.

## Kết luận: **ĐẠT** — HIGH vòng 1 đã đóng. Còn 3 LOW + 3 INFO, không chặn merge.

## Đã chạy

| Lệnh | Kết quả |
|---|---|
| `npx tsc -p apps/web/tsconfig.json --noEmit` | exit 0 |
| `npx jest apps/web apps/hub-api/test/alerts-api.spec.ts --maxWorkers=2` | 26 suites / 276 tests PASS |

Không chạy: `alerts-api-db.spec.ts` (cần Postgres thật), không docker.

## Kiểm từng điểm

1. **Còn `Date.now()` client quyết định "mới"?** — **Không.** `takeArrivals` (`apps/web/src/lib/alerts/notify-logic.ts:144-158`) chỉ dùng `mem.seen`, `socketOpened`, `baselineAt` lấy từ `serverBaseline` (`:132-137`: `complete` → −∞; bị cắt → `asOf`; thiếu `asOf` → max(openedAt)). Các chỗ `Date.now()` còn lại đều là hẹn giờ cục bộ: `alert-notifier.tsx:56,64,101` (banner xanh 4s, `bannerSync` chỉ dùng `now` để ghi `resolvedAt`, `notify-logic.ts:289-304`), `alert-ui.tsx:77-79` + `alert-sheet.tsx:39` (giờ tương đối "2 phút trước" — ADR-188 đã ghi là chưa bù lệch). Badge chuông đếm ở server (`/alerts/summary`). Test lệch ±10 phút (`notify-logic.spec.ts:159-203`) mock `Date.now` và kết quả không đổi.
2. **Phân trang/cắt (`next != null`)** — feed sắp `opened_at DESC, id DESC` (`prisma.service.ts:205`), `limit=100` (`alert-queries.ts:18`). Lần đầu bị cắt: id cũ (ngoài 100 dòng) rơi vào trang khi dòng trên đóng → `openedAt < asOf` → không toast (đúng L3). Không toast lại cái đã báo (`seen`). `asOf` đọc TRƯỚC danh sách (`alerts-api.ts:83`) nên dòng commit giữa hai câu nằm trong trang → đã thấy, không nuốt. Còn một cửa sổ nhỏ → **L1**.
3. **Reconnect / đổi project / tab ẩn lâu** — `mem` là store zustand toàn cục (`alert-ui.tsx:122`), feed operator xuyên project (không phụ thuộc project đang chọn) → đổi project không prime lại, không toast lại. Socket rớt: poll 30s bù, `seen` chống trùng. Tab ẩn: `refetchIntervalInBackground: false`, quay lại thì refetch → mọi cảnh báo mở trong lúc ẩn được toast một lượt (có thể dồn nhiều) → **I2** (có từ trước, không do commit này).
4. **Realtime `alert.changed` + poll → toast đôi?** — Không. Socket chỉ ghi `socketOpened` + invalidate; toast chỉ phát từ `takeArrivals`, id vào `seen` ngay lượt đầu thấy; toast id `alert-${id}` cũng làm sonner gộp. Episode mới luôn có uuid mới (`tenant-scoped.repository.ts:1062-1066`, `gen_random_uuid()`, `ON CONFLICT … WHERE state='OPEN'`) nên id đã đóng không bao giờ OPEN lại.
5. **Tập id phình vô hạn** — `seen` và `socketOpened` chỉ thêm, không bao giờ xoá → **L2**.
6. **`dbNow()` / BB-5 / redis-budget** — `SELECT now()` không chạm bảng nghiệp vụ, không cần `tenant_id` → không phá BB-5 (chấp nhận, đúng như ADR ghi). Không có lệnh Redis nào → redis-budget không đổi (đường list cảnh báo không phải đường nóng ingest/delivery). Thêm một round-trip mỗi lần đọc danh sách → **I1**.
7. **§8.3** (`SPEC-canh-bao-nhan-dinh.md:208-212`) — không đổi: `routeArrival` giữ nguyên (warning 6s, critical không tự đóng, RESOLVED không toast, không toast lúc tải trang). Chính sách "critical project khác chỉ thấy qua poll → toast dính" vẫn như R2. DINH-CHINH-2026-10-12 không có mục nào về mốc toast.
8. **ADR-188** — số không trùng (182..187 đã giữ chỗ cho quota spec `SPEC-han-muc-dung-luong.md:4`; 188 chỉ xuất hiện một lần). Đủ ba ý Vấn đề / Chọn / Đánh đổi; nội dung khớp code. Định dạng lệch → **L3**.

## Lỗi phân mức

- **[LOW] L1 — Lần đầu bị cắt vẫn có thể nuốt cảnh báo "commit muộn".** `apps/web/src/lib/alerts/notify-logic.ts:155` so `openedAt >= baselineAt` với `baselineAt = asOf`. `opened_at` = `now` ĐẦU lượt evaluator (`tenant-scoped.repository.ts:1064`, `input.now`), nên lượt bắt đầu trước `asOf` nhưng COMMIT sau đó (và không lọt vào trang) cho ra cảnh báo `opened_at < asOf` → bị coi là cũ, không toast (project khác không có `alert.changed`). Chỉ xảy ra khi có > 100 OPEN lúc tải, cửa sổ = thời lượng một lượt evaluator. ADR-188 nêu rõ ca này ở nhánh "đầy đủ" nhưng không nói ở nhánh "bị cắt". Sửa rẻ: `baselineAt = asOf − (trần thời lượng lượt evaluator)` (đổi lại có thể bật vài cảnh báo cũ trong khoảng đó), hoặc ghi một dòng vào phần Đánh đổi của ADR-188.
- **[LOW] L2 — `mem.seen` / `mem.socketOpened` phình theo thời gian mở tab.** `notify-logic.ts:113` (`socketOpened.add`), `:150,157` (`seen.add`) — không có chỗ nào xoá. Mỗi episode một uuid mới, cảnh báo nhấp nháy (flapping) nhiều ngày → hàng chục nghìn chuỗi (vài trăm KB–MB), không sập nhưng là rò. Sửa an toàn: khi `complete === true`, cắt `seen` (và `socketOpened`) về các id có trong danh sách OPEN hiện tại — id đã đóng không bao giờ OPEN lại (uuid mới mỗi episode), nên cắt không gây toast lại. Khi bị cắt thì không cắt (để giữ L3). Cần test.
- **[LOW] L3 — ADR-188 khác khuôn các ADR khác.** `docs/adr/README.md:1941-1943`: ba dòng `**Vấn đề:**` / `**Chọn:**` / `**Đánh đổi:**` không có gạch đầu dòng `- ` và không có dòng trống giữa chúng → Markdown dồn thành MỘT đoạn văn; các ADR liền trước dùng `- **Vấn đề:**`. File cũng thiếu xuống dòng cuối (`\ No newline at end of file`). Chỉ là trình bày.

- **[INFO] I1 — `dbNow()` thêm một round-trip mỗi lần poll** (`libs/database/src/prisma.service.ts:225-228`, gọi ở `alerts-api.ts:83`), mỗi tab operator 30s một lần, cộng thêm `/dashboard/alerts`. Chấp nhận được. Nếu muốn bỏ: trả `now()` ngay trong `systemTx` của `operatorAlertsAcrossTenants` (`transaction_timestamp()` lấy lúc bắt đầu tx, trước snapshot của câu SELECT ở READ COMMITTED → vẫn giữ bất biến "đọc trước danh sách").
- **[INFO] I2 — Tab ẩn lâu rồi mở lại sẽ toast dồn** mọi cảnh báo mở trong lúc ẩn (opened_at có thể đã vài giờ trước). Đúng nghĩa "mới trong phiên", sonner giới hạn 3 cái hiển thị cùng lúc; có từ trước commit này. Về trải nghiệm (Sally): nếu > 3 thì nên gộp thành một toast "N cảnh báo mới trong lúc bạn vắng" — để backlog.
- **[INFO] I3 — Chưa có test ở mức component** rằng `alert-notifier.tsx:71` truyền `complete = data.next === null` và `asOf` vào `takeArrivals`; hiện chỉ có test hàm thuần. Rủi ro thấp (2 dòng nối dây), tsc đã chặn sai kiểu.

## Tóm tắt
ĐẠT. Không còn `Date.now()` trình duyệt nào trong quyết định toast/banner; lần đầu đầy đủ dùng −∞ (tập id), bị cắt dùng `asOf` của DB, server cũ thì rơi về max(openedAt). Không toast đôi giữa socket và poll, đổi project/reconnect không toast lại. `dbNow` không chạm bảng (BB-5 không bị phá), không đụng Redis. §8.3 giữ nguyên; ADR-188 không trùng số. tsc 0 · jest 276/276. Còn lại: L1 cửa sổ commit muộn khi lần đầu bị cắt, L2 tập id phình vô hạn, L3 định dạng ADR.
