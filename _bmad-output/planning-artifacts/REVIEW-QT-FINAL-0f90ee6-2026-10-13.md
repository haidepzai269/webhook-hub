# REVIEW cuối QT (Winston + Murat), 2026-10-13

- **Phạm vi:** `feat/qt` HEAD `0f90ee6` = master `9b32cac` + 15 commit (14 commit QT đã rebase + `0f90ee6` sửa theo REVIEW-QT-S3).
- **Cách làm:** chỉ đọc. Không sửa, commit, checkout hay stash.

## Kết luận: **ĐẠT, được merge vào master**

Mọi mục M0, M2, M3, L1, L2, L3, L4, L6, L7, L9 của REVIEW-QT-S3 đều đã sửa đúng. Rebase sạch. CI xanh. Không thấy lỗi mới mức Trung bình trở lên. Còn ba ghi chú mức Thấp (N1–N3), không chặn merge.

## Lệnh đã chạy

| Lệnh | Kết quả |
|---|---|
| `tsc --noEmit -p apps/{hub-api,hub-worker,web}` | exit 0 / 0 / 0 |
| `jest --maxWorkers=2 --testPathIgnorePatterns db\.spec --testPathPattern "storage\|alert\|gates\|notify\|redis-budget\|canonical-contract\|projects"` | 26 suite, 229 test PASS |
| `npm run verify:gates` | 20 luật, 0 vi phạm, 12 ngoại lệ có lý do. Hai gate mới `operator-project-usage` và `delivery-ignores-storage-lock` xanh |
| CI run `38346212817` (`feat/qt-final`, sha `0f90ee6`) | **success**: unit ✓, db (L1) ✓, e2e (L2 hubv) ✓, secrets ✓. probe và chaos bị skip, đúng theo workflow |

Job db (L1) chạy **50 suite, 238/238** (chặng 3 là 237, tức thêm đúng 1 test). Log có dòng `PASS apps/hub-worker/test/storage-alerts-db.spec.ts (7.486 s)`, nghĩa là [QT:T19b] chạy thật, không bị skip.

## 1. Commit `0f90ee6` so với REVIEW-QT-S3

| Mục | Đánh giá |
|---|---|
| **M0** owner `asOf` | ĐẠT. `listAlertsFor` và `alertSummaryFor` ở nhánh owner gọi `store.dbNow()` **trước** escape hatch, trả `asOf` ISO. Test L0 khoá giá trị và thứ tự `['dbNow','ownerList','dbNow','ownerSummary']`. Câu lệnh tách khỏi escape hatch nên tốn thêm một round-trip `SELECT now()`. Cách này cùng mẫu với đường operator của master, chấp nhận được. |
| **M2** test song song L1 | ĐẠT, xem phân tích bên dưới. |
| **M3** gate `delivery-ignores-storage-lock` + [QT:T4] | ĐẠT. Phạm vi gồm `consumers/`, `senders/`, `circuit/`, `outbox.relay.ts`, `delivery.sweeper.ts`. Test có ca đỏ tổng hợp, có kiểm phạm vi trên repo thật không rỗng, và repo thật cho 0 vi phạm. Đã map trong TEST-MAP. Hạn chế xem N2. |
| **L1** lỗi đọc người nhận | ĐẠT. `recipientsOk=false` thì giữ nguyên `notified_level/at`, còn alert và event vẫn đúng. `storageSignalDue` thấy dấu email lệch nên lượt `sweep` sau gửi bù. Test chứng minh có đúng 1 thư `up:WARN_70`, không sinh event thứ hai. Đọc lỗi kéo dài thì chỉ log warn mỗi 60s. Trùng thư đã có `skipDuplicates` theo tag chặn. |
| **L2** | ĐẠT. `alert-sheet` thêm `useIsOperator()` vào điều kiện hiện nút "Đã xem". |
| **L3** | ĐẠT. Hành động người dùng chọn khác hành động gợi ý thì hiện `frees-of-suggested` ("Ước tính theo gợi ý (Dọn)…"), có đủ khoá vi/en. |
| **L4** | ĐẠT. DEPLOYMENT ghi tối đa 2 PUBLISH mỗi lần đổi nấc (về OK là 1, lượt nhắc là 0), chốt ổ 1 PUBLISH. |
| **L6** | ĐẠT. Gate `operator-project-usage` chỉ cho gọi ở `projects.controller.ts` (khai báo ở `prisma.service.ts`), có test. |
| **L7** | ĐẠT. Bước 1 của checklist DEPLOYMENT nhắc operator cũ tick các luật mới. |
| **L9** | ĐẠT. `canReadStorage` cho owner, developer và operator, khớp `libs/common/src/auth/roles.ts` (DEVELOPER có `storage:read`, VIEWER không có). Banner gọi `useStorage(canRead ? projectId : null)`. `me` chưa nạp thì trả false, nên không có 403 thừa. Có test. |

### M2: thiết kế test có song song thật và có đỏ khi bỏ `FOR UPDATE` không

Test `apps/hub-worker/test/storage-alerts-db.spec.ts` [QT:T19] (phần b):

- **Hai giao dịch thật.** Test dùng hai `PrismaService` riêng (`svc1`, `svc2`), tức hai pool và hai `tenantTx` độc lập, chạy cùng lúc bằng `Promise.all`.
- **Cách cắm rào.** `forTenant` là method công khai (`prisma.service.ts:741`), được ghi đè trên chính instance đó. `StorageAlerts.signal` gọi `this.prisma.forTenant(tenantId, tx)` bên trong tx nên dùng bản đã cắm rào. Code thật không bị đụng.
- **Rào `before`.** Hai tx đều đã BEGIN và đều tới ngay trước câu khoá rồi mới cùng chạy câu khoá.
- **Có `FOR UPDATE`.** tx A lấy được dòng, gọi `after.hit()` (đếm 1), rồi chờ tối đa 500ms. tx B bị Postgres chặn trong `lock()` nên không gọi được `hit`. Hết 500ms, A commit. B lúc đó đọc lại phiên bản mới (READ COMMITTED + FOR UPDATE) với `signaled_level='LOCKED'`, kết luận không có gì để làm và trả false. Kết quả kỳ vọng `[false, true]`: 1 event, 1 alert, 1 thư, `signaled/notified = LOCKED`.
- **Bỏ `FOR UPDATE`.** Hai tx cùng đọc ảnh chụp `signaled_level='OK'` và cùng `hit`, nên rào mở ngay và cả hai cùng đi tiếp. Khi đó hoặc có 2 event `hub.project.storage`, hoặc tx sau vấp ràng buộc unique của alert OPEN và `Promise.all` reject. Trường hợp nào test cũng **đỏ**. Đây là phân tích trên giấy. Máy này không có Docker nên tôi chưa chạy thử bỏ fix.
- **Rủi ro còn lại.** Nếu CI chậm tới mức `lock()` của B tới Postgres sau khi A đã chờ hết 500ms và commit, thì ở bản đột biến (không có FOR UPDATE) test có thể xanh giả. Ở code thật thì không bao giờ flaky. 500ms rộng so với một round-trip LAN. Chấp nhận được.
- `results.sort()` trên boolean sắp theo chuỗi, cho `[false, true]`. Đúng.
- `afterAll` dọn `alert_emails`, `alerts`, `deliveries`, `events`, thành viên, user và project (CASCADE `project_usage`), rồi ngắt cả ba client.

## 2. Rebase

Lệnh: `git range-diff cac3c8e..fc95983 9b32cac..ccd9603`.

- 12/14 commit hiện `=`, tức nội dung không đổi.
- Hai commit hiện `!`, và chỉ khác ở chỗ giải xung đột:
  - `18bc8e9` (QT1): khác ở ngữ cảnh `docs/adr/README.md`. Khối ADR-186 của nhánh giờ nối sau ADR-188 của master thay vì sau khối EG cũ. Nội dung ADR của nhánh giữ nguyên.
  - `de009e0` (QT6): `AlertStore` trong `alerts-api.ts` gộp đúng, có đủ `operatorAlertsAcrossTenants`, `operatorAlertSummaryAcrossTenants`, `operatorFindAlert*`, `dbNow`, `ownerAlertsAcrossTenants`, `ownerAlertSummaryAcrossTenants`. `listAlerts` (operator) giữ `asOf` của master.
- `docs/adr/README.md`:
  - `git diff 9b32cac HEAD` không có dòng `-` nào (append-only).
  - ADR-180..191 mỗi số đúng một lần, không trùng, không mất. ADR-188 còn nguyên.
  - Thứ tự số trong file không tăng dần: 188, 186, 183, 185, 182, 189, 184, 187, 190, 191. Đó là thứ tự ghi, không phải lỗi.
- Phía web:
  - `notify-logic.ts` không bị nhánh sửa (diff với master rỗng). `takeArrivals(..., { asOf, complete })` của master giữ nguyên.
  - Logic owner nằm ở `alert-notifier.tsx` (`useCanSeeAlerts`), `alert-bell`, `alert-banner` và `types.ts` (`audience`). Notifier vẫn truyền `asOf: data.asOf`, và owner giờ nhận được `asOf` nhờ M0.
  - Thống kê diff của web/alerts trước và sau rebase giống nhau (lệch đúng 1 dòng do L9).

## 3. Ghi chú mới (Thấp, không chặn)

- **N1. Đường summary của operator chưa có `asOf`.** `alertSummary` (operator, `alerts-api.ts:~159`) không trả `asOf`, còn summary của owner thì có. Client hiện chỉ dùng `asOf` của danh sách nên không phải lỗi, chỉ là hình dạng hai đường lệch nhau. Muốn thống nhất thì thêm vào đường operator, hoặc ghi rõ trong ADR-188 rằng summary không bắt buộc có.
- **N2. Regex của gate `delivery-ignores-storage-lock` có kẽ hở.** Regex dùng `\bProjectUsage\b`, nên tên kiểu `getProjectUsage(` / `findProjectUsage(` lọt qua vì trước `P` là ký tự chữ, không có ranh giới từ. `isWriteBlocked`, `lockProjectUsage*` và `project_usage` (SQL) vẫn bắt được, tức đủ các đường hợp lý nhất. Có thể nới thành `/ProjectUsage|projectUsage|project_usage/` không cần `\b`.
- **N3. Test M0 owner `asOf` chưa gắn mã.** Test không mang mã [QT:…] hay [CB:…] nên không có mặt trong TEST-MAP. Ở L1 cũng chưa có test owner `asOf` trên DB thật. Rủi ro thấp vì `dbNow` dùng chung với đường operator.

Các ghi chú L5 (`flow.repository` `raw_trimmed` chưa có test) và L8 (realtime chỉ tính vai trò owner lúc connect) từ chặng 3 vẫn để backlog như đã chấp nhận.
