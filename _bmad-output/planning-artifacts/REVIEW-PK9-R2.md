# REVIEW-PK9-R2: hotfix khởi động `c481656` (ADR-210) + sửa review `a4094b3`

Grumbal ⚠️ + Winston 🏗️ · 2026-10-14 · worktree `C:\wt\pk`, nhánh `feat/pk`. Chỉ đọc, chạy jest chọn lọc và đột biến tạm (đã trả lại). Không commit.

## Kết luận: **ĐẠT**: 0 Nặng · 1 Trung bình (mới) · 3 Thấp

- TB-1, TB-2, T-b, T-f, T-g, T-h, T-j đều đã sửa đúng.
- **TB-R2-1** sinh ra từ chính bản sửa TB-1. Phải xong trước PK6 ④ (server gọi `identify` trên body thu được), và nên xong trước PK7.

## Bằng chứng

| Kiểm | Kết quả |
|---|---|
| Build `libs/common, crypto, database, messaging, providers` + `apps/hub-api` (tsc, như Dockerfile). Sau đó `node -e "require('./apps/hub-api/dist/apps/hub-api/src/modules/console/catalog.controller.js')"` | OK, `CATALOG` có 21 mục |
| Build `apps/hub-worker`, rồi `require` `normalize.consumer.js` (consumer này import barrel, nên giờ kéo theo catalog) | OK |
| jest `--maxWorkers=2`: `libs/providers/test`, `verify/test/gates.spec`, `apps/hub-api/test/console-catalog`, `apps/web/src/lib/hub` | 24 suite, 334 test xanh |
| `verify:gates` | 21 luật, 0 vi phạm |
| `catalog:build --check` | khớp, 21 mục |
| Đột biến: đổi `catalog.controller.ts` về `from '@hub/providers/catalog/catalog'` | gate `server-lib-subpath` đỏ (1 vi phạm), đã trả lại file |
| Grep `@hub/<lib>/…` toàn repo, ngoài `apps/web` | Trong src phía server chỉ còn ở comment. Ngoài src chỉ có `apps/hub-api/test/edge-nginx.spec.ts` (`@hub/database/seed`), chạy qua jest nên không sao. `apps/web` (non-spec) không import barrel `@hub/providers` |

## 1. Import phía server / gate / barrel (c481656)

- **Nguyên nhân:** `node_modules/@hub/providers` là symlink tới gốc package, `main` trỏ `dist/index.js`, và package không khai `exports`. Vì vậy subpath không resolve được. ADR-210 mô tả đúng.
- **Cách sửa:** chuyển sang barrel là cách hẹp nhất. Không khai `exports` là đúng, vì jest/tsc đang dùng `moduleResolution: node`.
- **Regex của gate** (thử trực tiếp):

  | Bắt | Lọt |
  |---|---|
  | `from` (cả dòng `} from` của import nhiều dòng) | `require.resolve('@hub/x/y')` |
  | `import '…'` | `` require(`@hub/x/y`) `` (template literal) |
  | `import(…)` | `import(` xuống dòng trước chuỗi |
  | `export … from` | |
  | `import a = require(…)` | |

  `import type … from '@hub/x/y'` cũng bị bắt. Đây là dương tính an toàn (kiểu bị xoá lúc biên dịch), chấp nhận được. Không báo sai cho `apps/web` (đã loại khỏi `include`).
- **Barrel kéo catalog vào hub-worker:**
  - `CATALOG` được kiểm (`validateCatalog`) ngay lúc nạp module. Dữ liệu `catalog.data.ts` khoảng 29 KB. Danh mục hỏng thì worker cũng không lên.
  - Đánh giá: hợp lý. Danh mục đã bị chặn ở `[PK:T19]` + `catalog:build --check` + CI, và fail-fast lúc khởi động tốt hơn chết giữa chừng.
  - Shop không import `@hub/providers`, nên không bị ảnh hưởng.
  - Ghi nhận kiến trúc: worker không dùng danh mục mà vẫn chịu chi phí kiểm. Nếu sau này muốn tách, có thể dùng getter lười. Hiện chưa cần.
- **Web:** `@hub/providers/catalog` trỏ `catalog/index.ts` (chỉ `identify` + kiểu, không có dữ liệu). Web không kéo dữ liệu hay `crypto` qua barrel. Riêng `listen-logic.spec.ts` import barrel, nhưng đó là jest nên không vào bundle.

## 2. TB-1 (`xmlRootTag` + cắt 64 KB)

- **Không cắt** (chép hàm ra chạy riêng trên 4 MB), từng mẫu đều tuyến tính:

  | Mẫu | Thời gian |
  |---|---|
  | `<`×n | 236 ms (4 triệu vòng) |
  | `<!`×n | 3 ms |
  | `<?`×n | 13 ms |
  | `<!--`×n | 18 ms |
  | `<a`×n | 117 ms |
  | `<?x?>`×n | 46 ms |
  | `<!x>`×n | 53 ms |
  | tên 1000 ký tự lặp | 9 ms |

- **Qua `identify`** trên 1 MB, cả `sample` lẫn `captured`, với các mẫu `<` lặp, `<?` không đóng, `<!--` không đóng, `<!<?<!<` trộn: đều ≤ 7 ms và báo `problems` đúng.
- **Fixture:** bài A trên danh mục thật vẫn xanh. Mọi fixture đều nhỏ hơn 64 KB, nên việc cắt không làm sai nhận diện fixture.

### TB-R2-1. Cắt 64 KB **trước khi parse** làm hỏng nhận diện body JSON hợp lệ lớn hơn 64 KB

- **Vị trí:** `identify.ts`. `readRequest` / `fromCaptured` gọi `clip()` trước `applyBody`, nên `JSON.parse` chạy trên một nửa đối tượng.
- **Đo** (fixture thật, đệm thêm trường 70 KB):

  | Fixture | Kết quả |
  |---|---|
  | typeform | `matches: []` (mất hẳn) |
  | github | điểm 0.846 → 0.615 |

  `problems` còn báo sai: "body bắt đầu như JSON nhưng không parse được", trong khi body hợp lệ.
- **Thực tế:** body hơn 64 KB không hiếm. Ví dụ: GitHub push nhiều commit, Shopify `orders/*` nhiều dòng hàng, Stripe `invoice.*`. Đó cũng chính là body mà PK6 ④ sẽ đưa vào `identify` (≤ 1 MB).
- **Đề xuất:**
  - Thử `JSON.parse` trên body **đầy đủ** trước. Bước này tuyến tính trong V8 và body đã bị trần `MAX_INGEST_PAYLOAD_BYTES`.
  - Chỉ cắt 64 KB cho các nhánh còn lại: XML, form, JSON lines, JWT, guess.
  - Nếu vẫn muốn cắt mọi thứ: khi JSON hỏng *do bị cắt*, ghi `problems` là "bị cắt 64 KB, không đọc được khoá body". Fingerprint body phải coi là "không biết" chứ không phải "trượt".
  - Thêm test: fixture thật đệm lên 100 KB vẫn ra đúng mục.

## 3. TB-2 + dữ liệu provider (WebFetch 2026-10-14)

- **GitLab:**
  - Theo docs.gitlab.com: `Idempotency-Key` có từ 17.4, "consistent across webhook retries". Signing token và `webhook-signature` có từ 19.0, sau feature flag `webhook_signing_token`, GA 19.1.
  - Mặc định `static-token` + `idempotency-key` là đúng và hợp lý cho bản self-managed phổ biến. Standard Webhooks làm phương án phụ, có ghi ngưỡng; `docsVersion` và nhãn đã nêu ngưỡng 17.4 / 19.0.
  - Đánh đổi đã ghi ADR-208 bổ sung (c): token tĩnh không phủ body.
- **Shopify:** đúng tài liệu. shopify.dev/…/ignore-duplicates ghi "Use `X-Shopify-Webhook-Id` to deduplicate individual deliveries"; Event-Id dùng để gom các delivery cùng một hành động.
- **Typeform:**
  - Khớp `secure-your-webhooks`: header `Typeform-Signature`, HMAC-SHA256, base64, tiền tố `sha256=`, tính trên payload thô.
  - `event_id` cấp một khớp `example-payload`: "Unique ID for the webhook. Automatically assigned by Typeform". Khoá nằm trong body đã ký, tốt hơn khoá ở header.
  - Xem T-R2-3 về độ ổn định của `event_id` khi gửi lại.

## 4. Thấp của REVIEW-PK9

| Mục | Kết quả |
|---|---|
| T-f | Đúng. UA so trên chuỗi nguyên (thêm go, python, reactornetty, restsharp, vert.x…). `STOP_NAMES` thêm các từ chung và so cả từ đầu của lõi. Tên miền trong body chỉ còn là bằng chứng phụ. Có test cho mọi dòng trong bảng T-f |
| T-j | Đúng. Dùng `Object.create(null)`, và `fromCaptured` dùng `Object.keys` thay `Object.entries`. Tên đoán > 40 ký tự thì bỏ, bằng chứng cắt ở 80 ký tự. Test có cả `constructor` / `__proto__` |
| T-h | Đúng. Hoà điểm cao nhất với mục ngoài nhóm thì `ok = false`. Có test dùng bản clone để chứng minh, và danh mục thật vẫn xanh |
| T-g | Đúng. `Cache-Control: private, max-age=300`. Không có interceptor toàn cục nào ghi đè. Bỏ ETag có ghi lý do |

## Thấp mới

- **T-R2-1.** Gate `server-lib-subpath` lọt ba dạng: `require.resolve(…)`, `` require(`…`) `` và `import(` xuống dòng. Hiếm. Có thể thêm `` ` `` vào lớp ký tự, `require\.resolve\(`, và `\s*` trải nhiều dòng. Hoặc ghi rõ "chỉ chuỗi tĩnh" (ADR-210 đã nói một phần).
- **T-R2-2.** Không có gate cấm src `apps/web` (non-spec) import barrel `@hub/providers`. E28 hiện chỉ dựa vào comment. Một import nhầm sẽ kéo `crypto` của Node và dữ liệu danh mục vào bundle. Có thể thêm luật đối xứng `web-no-provider-barrel`.
- **T-R2-3.** Typeform không cam kết `event_id` giữ nguyên khi gửi lại. Trang webhooks chỉ mô tả lịch retry, không nói về id. Nếu `event_id` đổi theo mỗi lần gửi, trường hợp hub đã COMMIT nhưng phản hồi bị mất (timeout 30 s) sẽ thành event trùng. Tác động thấp, vì retry chỉ xảy ra khi Typeform không nhận được 2xx. Nên ghi một dòng vào `docsVersion` hoặc ADR-208 ("ổn định khi gửi lại: chưa có tài liệu xác nhận"), hoặc hạ `confidence`.
