# REVIEW-PK10 — chống trùng `path` / `bodyHash`, `empty_body`, 5 mục danh mục, ADR-230

Commit `6847841` (`feat/pk`, worktree `C:\wt\pk`). Reviewer: Mary (dữ liệu provider), Grumbal (soi lỗi), Murat (test). Ngày 2026-10-14.
Chỉ đọc, chạy jest chọn lọc và đột biến tạm thời (đã trả lại hết, `git status` sạch, trừ `libs/hub-sdk/bin/hub.js` vốn đã sửa từ trước).

## Kết luận: **KHÔNG ĐẠT** — 1 Nặng · 1 TB · 5 Thấp

Lõi (validator, adapter, ingest) chắc chắn, đúng E31/BB-2: không có khoá ngẫu nhiên, lõi không có `if provider`, khoá `{header}`/`{field}` cũ giữ nguyên.
Chặn duy nhất là **dữ liệu danh mục Pipedrive** (N-1): với webhook v1, cấu hình này có thể làm mất sự kiện vĩnh viễn mà không báo gì.

## Nặng

**N-1 — Pipedrive `path: meta.id` chỉ đúng với webhook v2. Với v1, `meta.id` là ID CỦA ĐỐI TƯỢNG → báo DUPLICATE sai và mất sự kiện vĩnh viễn.**
- Đã WebFetch đối chiếu:
  - `pipedrive.readme.io/docs/guide-for-webhooks` (v1) ghi `meta.id` là "ID of the object".
  - Bản v2 ghi `meta.id` là "ID of the event", còn `entity_id` mới là id đối tượng.
- v1 vẫn tồn tại: tạo được qua API ("legacy fallback"), và webhook tạo trước 2025-03-17 không thấy tài liệu nói được tự chuyển.
- Hậu quả với nguồn v1 dùng mục này:
  - Lần cập nhật thứ 2 trở đi của cùng một deal có cùng khoá `generic:<dealId>`.
  - Hub trả 200 DUPLICATE, Pipedrive không gửi lại → **mất sự kiện, không có cảnh báo**.
  - Đây là hướng hỏng tệ nhất: mất dữ liệu, trong khi hỏng kiểu ngược lại chỉ là nhận trùng.
- `fingerprint` đòi `data` (v1 dùng `current`) nên `identify()` không gợi ý mục này cho v1. Tuy vậy dev vẫn chọn tay được, và nhãn/ghi chú không cảnh báo gì.
- **Sửa (nhỏ):**
  - Nhãn field và `docsVersion` nói rõ "CHỈ webhook v2 (`version: "2.0"`). Webhook v1 thì `meta.id` là id đối tượng — tạo lại webhook v2".
  - Thêm `meta.version` hoặc `meta.entity_id` vào `fingerprint.body` để identify bám đúng v2. Ít nhất là thêm vào note.
  - Thêm test hoặc fixture: dạng body v1 (`meta.v=1`, có `current`) **không** khớp mục pipedrive.
  - Phương án mạnh hơn (tuỳ chọn): đổi sang trường chỉ v2 mới có. Hiện không có trường nào như vậy ở cấp chọn được, nên tối thiểu là cảnh báo.

## Trung bình

**TB-1 — `empty_body` thiếu trong `libs/common/src/errors/catalog.ts` và `docs/ERRORS.md`.**
- `missing_idempotency_key` có ở cả hai nơi; mã mới anh em với nó thì chưa có ở nơi nào.
- Ack ở `/hooks` có kèm `fix` nên dev không bị kẹt. Nhưng tài liệu lỗi (DX, `docsUrl`) không tra ra được `empty_body`, và `error-catalog.spec` không bắt lỗi này.
- **Sửa:**
  - Thêm mục `empty_body` (422, cùng fix với `EMPTY_BODY_FIX`) vào catalog và ERRORS.md, kèm ví dụ `curl` body rỗng.
  - Nếu có test đối chiếu "mã lỗi phát ra ⊆ catalog" thì mở rộng sang `IdempotencyKeyMissingError.code`.

## Thấp

- **T-a — Validator nhận cấp toàn số (`items.0.id` khớp `^[A-Za-z0-9_-]{1,64}$`).**
  - Lúc đọc, guard `Array.isArray` trả `undefined`, nên sự kiện **âm thầm** rơi về băm body. Cấu hình sai mà không ai biết.
  - Đột biến M6 (bỏ `Array.isArray`) **sống sót**: không có test nào đi qua mảng bằng chỉ số.
  - Đề xuất: cấm cấp toàn số trong `idempotencyPathProblem` và trong bản sao ở web (khớp §15 "không chỉ số mảng"), và thêm test `'items.0.id'` → 422.
- **T-b — `path` trỏ nhầm vào object/mảng/boolean thì âm thầm rơi về băm body.**
  - Hướng hỏng này an toàn (nhận trùng, không mất). Nhưng Heroku/Pipedrive có `attempt` đổi theo từng lần gửi, nên lần gửi lại sẽ thành sự kiện mới.
  - Đề xuất: `log.warn` hoặc đếm metric "path fallback" theo source, hoặc gợi ý trong Lắng nghe.
- **T-c — Số nguyên lớn hơn 2^53 qua `JSON.parse` bị làm tròn, nên hai id khác nhau có thể ra cùng khoá** (`String(1e21)` = `"1e+21"`).
  - Lỗi này có từ trước với `field`, nay lan sang `path`.
  - Đề xuất: chỉ nhận `Number.isSafeInteger`; ngoài khoảng đó thì `path` rơi về băm body, `field` báo 422.
- **T-d — `bodyHashIdempotencyKey` bị chèn giữa JSDoc của `idempotencyHeader` và thân hàm** (`generic.adapter.ts` ~355–370). Docblock PK1 giờ treo trên nhầm hàm.
- **T-e — CircleCI dùng tiền tố tĩnh `v1=`.** Khi header thành `v1=…,v2=…` thì 401 mãi. Đã ghi ở `docsVersion` và chấp nhận được. Khi CircleCI công bố v2 cần ghi sổ theo dõi.

## Đối chiếu từng điểm

1. **`path`**
   - Prototype an toàn: validator cấm `__proto__`/`prototype`/`constructor`, và chỉ đọc own-property (đột biến M1, M5 bị giết).
   - Rỗng, quá dài, object, mảng → `generic:body:<hash>`.
   - Độ dài khoá: tối đa `generic:` + 200 = 208, unverified là 241, `generic:body:` + 32 = 45. Tất cả đều ≤ `VarChar(255)`.
   - Đổi cấu hình `field:id` → `path:id` cho ra cùng khoá (tốt). Đổi sang `bodyHash` thì dải khoá khác, nên sự kiện đang được gửi lại có thể vào 2 lần (nhận trùng, không mất). **Chấp nhận**, có thể ghi một câu vào ADR-230.
2. **`bodyHash`**
   - Tiền tố `generic:body:` chỉ đụng khi provider ký thật một id dạng `body:<32hex>`, coi như không xảy ra.
   - Body rỗng → `storeRejected(…, signature_valid=true)` + 422 `empty_body` + `fix`.
   - `source.signature_failing` chỉ đếm `invalid`, nên mã lỗi này không làm bẩn cảnh báo.
   - Chẩn đoán trả `empty_body` và có câu i18n vi/en.
   - unverified + bodyHash = bỏ trống (E7), đột biến M9 bị giết.
   - Thiếu catalog/ERRORS.md: xem TB-1.
3. **Tương thích ngược:** nhánh `{header}`/`{field}` trả đúng `generic:<v>` / `generic:<v>:<hash>` như master, có test dòng 96 và 174–176.
4. **5 mục danh mục (WebFetch 2026-10-14):**
   | Mục | Header / thuật toán / encoding / khoá | Khoá chống trùng | Kết quả |
   |---|---|---|---|
   | circleci | `circleci-signature`, `v1=` + HMAC-SHA256 hex trên body; secret tuỳ chọn (nhãn đã nói phải đặt) | `id` "uniquely identify each event … deduplicate" | Đúng (T-e) |
   | heroku | `Heroku-Webhook-Hmac-SHA256`, base64 (theo mẫu Ruby), secret khi đăng ký | `webhook_metadata.event.id` (= `id` cấp một); `attempt`/`delivery` đổi theo lần gửi | Đúng |
   | pipedrive | Basic auth (`http_auth_user/password`), không ký | `meta.id`: v2 là id sự kiện, **v1 là id đối tượng** | **Sai với v1 (N-1)** |
   | squarespace | `Squarespace-Signature`, `HMAC-SHA256(hexToBytes(secret), raw body)`, hex → `keyEncoding: hex` | `id` unique notification id | Đúng |
   | checkout-com | `Cko-Signature`, HMAC (SHA-256 theo trang workflows) hex, khoá là **webhook signature key** của action (không phải secret key API) | `id` (`evt_…`) | Đúng; nhãn field đúng khoá |
5. **ADR-230:** số hợp lý.
   - PK giữ 201–210; hub-sap mở dải từ 211 và đã nhắc tới 220. Lý do được ghi ngay đầu ADR.
   - Đề xuất: ghi dải đã giữ vào `docs/adr/README.md` (hoặc một dòng trong SPEC-hub-sap), ví dụ "hub-sap 211–229, PK tiếp từ 230", để lần sau không phải đoán.
6. **Lệnh đã chạy:**
   - jest `--maxWorkers=2` (11 suite: generic-idempotency, ingest-idempotency-pk10, catalog-identify, generic.adapter, generic-unverified, ingest-generic, console-catalog, listen-logic, dictionary, error-catalog, redis-budget): **11/11 suite, 166/166 test xanh**.
   - `tsc --noEmit` cho hub-api, hub-worker, web: đều exit 0.
   - `verify:gates`: 22 luật, 0 vi phạm.
   - `catalog:build --check`: khớp (31 mục).

## Đột biến (đã trả lại)

| # | Đột biến | Kết quả |
|---|---|---|
| M1 | bỏ `hasOwnProperty` trong `readIdempotencyPath` | giết (1) |
| M2 | bỏ tiền tố `body:` | giết (4) |
| M3 | bỏ throw `EmptyBodyIdempotencyError` | giết (3) |
| M4 | `PATH_MAX_DEPTH` 3 → 4 | giết (1) |
| M5 | bỏ danh sách cấm prototype | giết (1) |
| M6 | bỏ guard `Array.isArray` | **sống** → T-a |
| M7 | bỏ kiểm URL của `bodyHashReason` ∈ `sources` | giết (1) |
| M8 | bỏ chặn bodyHash khi body luôn `empty` | giết (1) |
| M9 | unverified + bodyHash không còn coi như bỏ trống | giết (1) |

## Điều kiện ĐẠT

Sửa N-1 (cảnh báo v2 trên nhãn và `docsVersion`, fingerprint bám v2, test body v1 không khớp) và TB-1 (`empty_body` trong catalog lỗi và ERRORS.md). Thấp: để lại hoặc gộp vào lượt sau.
