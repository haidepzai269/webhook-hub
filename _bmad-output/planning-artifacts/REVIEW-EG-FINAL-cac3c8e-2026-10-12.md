# Review cuối EG (Winston + Murat): `feat/edge-nginx` @ `cac3c8e`

Ngày 2026-10-12. Nhánh = master `681b219` + 18 commit (EG2–EG5, D3, EG1 đã rebase, commit gộp `cac3c8e`).
Chỉ đọc. Không sửa, không commit, không docker. `docs/TEST-MAP.md` bị `verify:map` ghi đè, đã khôi phục về HEAD.

## Kết luận: **ĐẠT để push**

Không có lỗi Cao hoặc Trung bình. Còn 3 điểm Thấp và 2 điểm Thông tin, đều không chặn push.

## 1. Commit `cac3c8e`: gộp EG1 với D3

| Mục | Kết quả |
|---|---|
| `rejectNonCanonicalHooksPath` | Đúng. Lấy path bằng `hooksPathOf` (gắn ở gốc nên `req.url === originalUrl`); khi bị mount lồng thì dùng `pathnameOfUrl(originalUrl)`. Logic `lower` khớp `/hooks` hoặc `/hooks/…` nhưng không có tiền tố `/hooks` chữ thường thì trả 404. `/hooksX` và `/HOOKSX` cho đi tiếp. |
| `installHooksPathGuard` | Gắn ở gốc. main.ts gọi nó sau CORS, trước `installPenaltyGate`. Mount `/hooks` cũ đã bỏ khỏi `configureBodyParsers`. |
| `fix` của 404 | `HOOKS_NOT_FOUND_FIX` trùng nguyên văn với body 404 tĩnh của nginx. Test `[EG:T10] (phần g)` regex lấy câu này từ template. |
| Test | `[EG:T19]` (b): 2 IP × 3 path cho cùng một body, ingest không bị gọi. (c): absolute-form chữ thường không bị 404 oan. Có khoá thứ tự main.ts. `[EG:T1]` (b): A bị chặn không kéo theo B, kiểm ở mức `req.ip` qua proxy tin cậy. `[EG:T1] (phần a)` được đổi tên để không trùng mã. |
| ADR | Thêm "Bổ sung lượt 5" vào cuối ADR-175/176 (append). Có đủ vấn đề, lựa chọn và đánh đổi. |

### Probe socket thô

Dựng app Nest thật theo đúng thứ tự main.ts: trust proxy 1, helmet, error handling, CORS, guard, gate, body parser. Mỗi request khai báo `Content-Length` 1 MB nhưng chỉ gửi 2 byte. Nếu server trả `TIMEOUT` nghĩa là nó đã cho request qua và đang chờ đọc body. IP bị ban do luật (a) đạt 20 lần.

| Request-target | IP sạch | IP bị ban |
|---|---|---|
| `/hooks/github/src_x`, `?x=1`, `#frag`, `/` cuối | cho qua (TIMEOUT) | 429 `ip_temporarily_blocked` + `Connection: close` |
| `http://hub.test/hooks/…`, `HTTP://HUB.TEST/hooks/…` | cho qua | 429 |
| `http://hub.test/HOOKS/…`, `HTTP://HUB.TEST/HOOKS/…?q=1` | 404 not_found + fix nginx | **cùng** 404 |
| `/HOOKS/…`, `/Hooks/…?x=1`, `/HOOKS/…#x`, `/HOOKS` | 404 | **cùng** 404 |
| `/hooks`, `/HOOKSX/…`, `/hooksx/…`, `//hooks/…`, `/%68ooks/…`, `/%48OOKS/…`, `/api/v1/x` | cho qua | cho qua (router không giao cho ingest) |
| `/hooks/GitHub/src_x` | cho qua | 429 |

- Path viết hoa nhận 404 giống hệt nhau dù IP sạch hay bị ban, nên không lộ trạng thái phạt (S1/S2 R6 đã đóng).
- Absolute-form chữ thường không còn bị 404 oan (Thấp-A EG1 R4 đã đóng).
- Không path hợp lệ nào bị 404 oan. Ingest không bị gọi lần nào trong toàn bộ probe.
- Dòng `/hooks/GitHub/k` là thông tin: lớp hub-api cho qua với IP sạch và trả 429 với IP bị ban; nginx thì trả 404 tĩnh. Hành vi này đúng ADR-177 lần 7 ("gate khớp như router, không lọc provider"), không phải do commit này gây ra.
- `%48OOKS` qua được lớp hub-api nhưng router không khớp, nên không tới ingest. nginx decode trước rồi khớp `~*`, trả 404. Không có đường vòng.

## 2. Rebase và giải xung đột

- `git range-diff 5703897~1..1546378 681b219..9ce09dd`: cả 11 commit đều ra `=` (patch giống hệt). Chỉ thêm `9ce09dd` (R7 THẤP-A/B). Đã đọc `9ce09dd`: `removeGoodKey(victim, good.get(victim)?.tenantId === t)` đọc tenant trước khi xoá nên đúng; có test kịch bản R7. Đạt.
- Với nhánh EG1 (`3a307c9~1..3c4ce16` so với `9ce09dd..c9566be`), so trực tiếp kết quả `git merge-tree 9ce09dd 3c4ce16` với cây của `c9566be`. Xung đột chỉ ở 4 file `ERRORS.md`, `TEST-MAP.md`, `adr/README.md` và `catalog.ts`. Phần tự gộp được (main.ts, ARCHITECTURE, DEPLOYMENT, mã nguồn) trùng khớp hoàn toàn.
- Quét mọi file hai nhánh đã đổi: mọi dòng mà mỗi nhánh thêm vào (so với base của nhánh đó) đều có mặt ở `c9566be`. Ngoại lệ duy nhất là các dòng được thay có chủ ý: dòng `note` và `EG2` của spec-sources, và TEST-MAP.
- `catalog.ts`: có cả `ip_temporarily_blocked` và `edge_rate_limited`, dấu `},` đúng.
- `ERRORS.md`: có cả hai mục, khối code đóng đúng.
- `adr/README.md`: không mất dòng nào của hai bên. ADR-175/176 được đặt trước ADR-177, nên số ADR tăng dần. Đoạn "Bổ sung" giữ nguyên vị trí. Không có số trùng: dãy cuối là 170–173, 180, 174–179, 181 (ADR-180 nằm sẵn trên master). Không có đoạn cũ nào bị sửa.
- `spec-sources.json`: chỉ còn một mục `"ns": "EG"`, nhóm đủ EG1–EG5. `EG2: "T1,T4-T7,T17,T18,T19"`, dải `T4-T7` được `expandCodes` hỗ trợ. `verify:map` cho 0 ma, 0 trùng.
- main.ts theo thứ tự: trust proxy → helmet → cookieParser → installErrorHandling (request-id) → CORS → hooks-path guard → penalty gate → body parser. Đúng yêu cầu. Thứ tự này có test khoá.

## 3. `docs/TEST-MAP.md` ghép tay

- CI (`.github/workflows/verify.yml`) chạy `npm run verify:map` rồi chỉ upload file làm artifact. Không có bước `git diff --exit-code` hay so sánh nào.
- `mapCmd` ghi đè file. Exit code chỉ phụ thuộc mồ côi, ma và trùng. Không gate hay test nào đọc TEST-MAP (đã grep `verify/`, `.github/` và các file spec).
- Dòng ghi chú ở đầu file không làm `verify:map` hay `verify:gates` đỏ.
- Đã so bản commit với bản `verify:map` sinh lại (bỏ cột trạng thái): cấu trúc giống hệt, chỉ khác dòng ghi chú đầu file. Hai bản cùng có 342 mã, 277 có test, 0 mồ côi, 24 mồ côi có lý do, 0 ma, 0 trùng.
- **Chấp nhận được để push.**
- **Thấp-1:** dòng `EG:T19` trong file ghi "chưa chạy", trong khi ghi chú đầu file nói T19 lấy theo lần chạy của 9d7b9f0, lúc đó chưa có T19. Thực tế T19 (a/b/c) pass ở L0 trong lần chạy này. Nên sinh lại file trên CI/Linux trước khi merge vào master, như ghi chú tự nêu.

## 4. Lệnh đã chạy

| Lệnh | Kết quả |
|---|---|
| `tsc --noEmit` cho hub-api, hub-worker, shop, web | cả 4 exit 0 |
| `jest --testPathIgnorePatterns "db\.spec\.ts$"` (loại cả `source-traffic-db.spec`, `source-traffic-api-db.spec`), maxWorkers=2 | 156 suite pass, 3 skip; 1351 test pass, 30 skip; **1 fail: `[BB:4]`** |
| Như trên với maxWorkers=4 | thêm `body-limit.spec` timeout 5 s ở test 413 1 MB (tải song song cao) |
| `jest apps/hub-api/test/body-limit.spec.ts` chạy riêng | 7/7 pass |
| `npm run verify:map` | exit 0: 342 mã, 277 có test, 0 mồ côi, 24 mồ côi có lý do, 0 ma, 0 trùng. Đã khôi phục file. |
| `npm run verify:gates` | 16 luật, 0 vi phạm, 12 ngoại lệ có lý do |
| Probe socket thô | xem §1 |

- `[BB:4]` đỏ là do môi trường Windows: `git ls-files --eol docker-compose.yml` cho `i/lf w/crlf` (master cũng vậy), mà regex của test đòi `\n  hub-api:\n`. Đây là lỗi đã biết (R4 Thấp-C), không phải hồi quy. Trên CI Linux thì xanh.

## Phân mức các điểm còn lại

| Mức | Điểm | Chặn push? |
|---|---|---|
| Thấp-1 | TEST-MAP: cột trạng thái ghép tay, dòng `EG:T19` ghi "chưa chạy". Sinh lại trên CI trước khi merge vào master. | Không |
| Thấp-2 | `docs/ERRORS.md#not_found` chỉ nói về slug project. 404 của `/hooks` sai hoa thường (cả nginx lẫn hub-api) có `fix` khác nhưng không được ghi ở mục này. Thêm một câu. | Không |
| Thấp-3 | Test 413 của `body-limit.spec` timeout 5 s khi chạy maxWorkers=4 trên Windows; pass khi chạy riêng và với maxWorkers=2 (mặc định của `npm test`). Có thể tăng timeout cho test này. | Không |
| Thông tin | `/hooks/GitHub/k`: hub-api trả 429/cho qua tuỳ IP, nginx trả 404. Hợp lệ theo ADR-177 lần 7. | Không |
| Thông tin | L2 qua container `edge` thật (`[EG:T1]` (b), `[EG:T9]`, `[EG:T11]`, T19 qua nginx) chưa chạy trên máy này vì không có Docker. Cần CI e2e xanh trước khi merge vào master. | Không chặn push nhánh |
