# REVIEW-PK10-R2 — lượt 2 sau commit `c948572`

Commit được review: `c948572` (`feat/pk`, worktree `C:\wt\pk`), sửa theo REVIEW-PK10 (`6293711`). Reviewer: Murat (test). Ngày 2026-10-14.
Lượt này chỉ đọc code, chạy jest từng file, chạy `tsc`, build libs như Dockerfile rồi `require` barrel, và chạy probe ở scratchpad. Không sửa code sản phẩm.

## Kết luận: **ĐẠT** — 0 Nặng · 0 Trung bình · 3 Thấp mới

N-1 và TB-1 đã sửa đúng. Các mục T-a, T-b, T-c, T-d cũng đã sửa đúng. T-e vẫn để lại như lượt 1 đã chấp nhận.
Phần thay đổi mới không phá BB-2:
- Không có khoá ngẫu nhiên.
- Đổi khoá chỉ có thể sinh **nhận trùng**, không gây mất sự kiện.
- Không thêm lệnh Redis nào.
- Không import subpath từ phía server.

## Mục cũ → trạng thái

| Mục | Trạng thái | Bằng chứng |
|---|---|---|
| **N-1** Pipedrive v1 `meta.id` là id đối tượng | **Đã sửa (chấp nhận)** | Xem §1 |
| **TB-1** `empty_body` thiếu trong catalog lỗi và ERRORS.md | **Đã sửa** | Xem §2 |
| **T-a** path nhận cấp toàn số | **Đã sửa** | Thêm `PATH_INDEX_SEGMENT_RE` ở `generic-config.ts:132,146` và bản sao ở web `listen-logic.ts:330`. Test đối chiếu server và web có trong `listen-logic.spec.ts`. Test mảng theo chỉ số và theo `length` giết được đột biến M6. Cấp lẫn chữ và số (`v2.id`, `0x.id`) vẫn được nhận. |
| **T-b** path trỏ vào object/mảng/boolean thì âm thầm rơi về băm body | **Đã sửa** | Xem §3c. Thêm log warn có nhịp và chẩn đoán `idempotency_path_not_scalar` kèm i18n vi/en. Có một lỗi Thấp mới (L-3). |
| **T-c** số lớn hơn 2^53 bị làm tròn | **Đã sửa** | Xem §3a |
| **T-d** JSDoc nằm sai chỗ | **Đã sửa** | Docblock PK1 đã về lại trên `idempotencyHeader` (`generic.adapter.ts:422-426`). ADR-230 ghi thêm dải số "PK 201–210 + 230; 211–229 cho hub-sap; tiếp từ 231". |
| **T-e** CircleCI dùng tiền tố `v1=` tĩnh | **Để lại (đã chấp nhận ở lượt 1)** | Không đổi. Vẫn ghi ở `docsVersion`. |

## 1. N-1 — Pipedrive: lập luận "fingerprint đòi `data` cấp một"

Đã WebFetch lại tài liệu ngày 2026-10-14.

**Tài liệu v1** (`pipedrive.readme.io/docs/guide-for-webhooks`):
- Khoá cấp một gồm `v`, `matches_filters`, `meta`, `retry`, `current`, `previous`, `event`.
- **Không có `data` cấp một.** Sự kiện xoá cũng vậy: `current: null`, `previous` là trạng thái cuối, không sinh thêm `data`.
- `meta.id` là "ID of the object".
- Trang ghi: "V1 webhooks can only be created through the API as a legacy fallback. The default version when creating webhooks is v2."

**Tài liệu v2** (`guide-for-webhooks-v2`):
- Khoá cấp một gồm `meta`, `data`, `previous`.
- `meta.id` là "ID of the event", còn `meta.entity_id` là id đối tượng.
- Sự kiện xoá có `data: null`, nhưng khoá `data` vẫn có mặt.
- `POST /v1/webhooks` nhận `version` là `1.0` hoặc `2.0`, mặc định là `2.0`.

**Nhận định:**
- Lập luận của dev **đúng**. Không có body v1 nào có `data` cấp một, nên `identify()` không gợi ý mục `pipedrive` cho v1.
- Test `[PK:T41] (phần b)` dùng body v1 có đủ khoá theo tài liệu và khẳng định nó không khớp. Fixture v2 vẫn qua bài A.

**Trường hợp dev tự chọn tay mục pipedrive cho webhook v1:**
- Rủi ro mất sự kiện **vẫn còn**. Lõi generic không thể chặn mà không thêm `if provider`, và việc đó bị cấm.
- Hiện chỉ có hai lớp chặn:
  - Nhãn field "CHỈ webhook v2 … webhook v1 hãy tạo lại webhook v2" hiện ngay cạnh ô nhập secret.
  - `docsVersion` mô tả rõ cách hỏng.
- Để rơi vào trường hợp này, dev phải tạo webhook v1 **chủ động** qua API với `version: "1.0"`, vì mặc định là v2, v1 là "legacy fallback" và giao diện Pipedrive tạo v2. Khi trỏ webhook vào hub thì phải tạo webhook mới. Lúc đó webhook sẽ là v2, trừ khi dev cố ý chọn v1.
- Đánh đổi này đã ghi vào ADR-230 ("dev vẫn chọn tay được; chỉ có cảnh báo chặn").
- **Chấp nhận.** Có thể tăng an toàn bằng một chẩn đoán chung trong "Lắng nghe", không gắn với provider: nếu body ACCEPTED lệch `fingerprint` của mục danh mục đã chọn thì cảnh báo. Đây là việc backlog, không chặn PK10.

## 2. TB-1 — `empty_body`

- `libs/common/src/errors/catalog.ts` có mục `empty_body` với status 422. `fix` trùng từng chữ với câu cũ.
- Adapter dùng `EMPTY_BODY_FIX = ERROR_CATALOG.empty_body.fix()`, nên chỉ còn một nguồn câu. Đã kiểm lúc chạy qua `dist`: `EMPTY_BODY_FIX === ERROR_CATALOG.empty_body.fix()` → `true`.
- `docs/ERRORS.md` có mục `## empty_body`: status 422, nguyên nhân (bodyHash, hoặc path thiếu giá trị nên rơi về băm body), cách sửa, `curl --data-binary ''`. Mục này khớp hành vi adapter: path với body rỗng → `bodyObject` = null → băm body rỗng → 422.
- `error-catalog.spec` quét mã lỗi trong `libs/providers/src/errors.ts` và kiểm chúng ⊆ catalog. Test cũ kiểm catalog ⊆ ERRORS.md.
- Ba chỗ dùng mã `empty_body` đều thống nhất: hằng `EMPTY_BODY_ERROR` của adapter, `Diagnosis.reason` và `LISTEN_REASON_KEYS` ở web.

## 3. Thay đổi mới

### a. T-c — reviver `JSON.parse` có `source`

**Runtime:**
- `Dockerfile` dùng `FROM node:22-slim`. Năm job của `.github/workflows/verify.yml` đều dùng `node-version: 22`. Máy local chạy v22.15.0.
- Tính năng "JSON.parse source text access" có sẵn từ V8 11.4+ (Node ≥ 21). Đã chạy thử trên v22.15: `ctx.source` trả đúng `"12345678901234567891"`.

**Khi runtime không hỗ trợ:** đã chạy probe giả lập reviver không có tham số thứ 3, gọi qua `dist` thật.
- `field`: giữ khoá làm tròn như cũ (`generic:12345678901234567000`). Không tệ hơn trước.
- `path`: rơi về `generic:body:<hash>`, khớp đúng `bodyHashKey(rawBody)`. Nhận trùng, không mất.
- Không có nhánh nào ném lỗi, vì `try/catch` → null.

**Đổi khoá của source đang chạy:**
- Chỉ xảy ra với id dạng số mà `!Number.isSafeInteger`: số lớn hơn 2^53, hoặc số thực như `3.140`. Probe cho khoá cũ `generic:3.14` và khoá mới `generic:3.140`.
- Số nguyên an toàn giữ khoá cũ. Probe: `1.5e3` → `generic:1500`, `42` → `generic:42`.
- Sự kiện đang được gửi lại trong lúc deploy sẽ có khoá mới, nên được **nhận lần hai**. Không có đường nào làm hai id khác nhau ra cùng khoá, nên không mất sự kiện. Trước bản sửa thì có thể mất.
- ADR-230 đã ghi đánh đổi này. **Chấp nhận.**

**Bên tấn công:**
- Sửa body để chèn `__hubNumberSource` không có tác dụng. Nhánh này chỉ chạy khi giá trị đã parse là *số*, và reviver chỉ bọc số, nên một object thật trong body không bao giờ đi vào nhánh.
- Parse lần hai giới hạn ở body ≤ 1 MiB và chỉ chạy ở nhánh hiếm.
- `field` được truyền như path một cấp. `FIELD_RE` không có dấu `.`, và `readIdempotencyPath` chỉ đọc own-property, nên an toàn.

### b. `LogThrottle` dời sang `libs/common` (rủi ro ADR-210)

- `libs/common/src/index.ts` có `export * from './log-throttle'`. `tsconfig` của common gồm `src/**/*`, nên file mới vào `dist/` mà không cần khai thêm.
- Các import mới đều đi qua **barrel `@hub/common`**: `generic.adapter.ts:2` và `delivery.consumer.ts:24-25`. Không có subpath, nên gate `server-lib-subpath` không bị chạm.
- Dockerfile chạy `rm -rf libs/*/dist` rồi `npm run build --workspaces`. Workspaces `libs/*` theo thứ tự chữ cái, nên `common` được build trước `providers`.
- Đã tái hiện bước build: `npm run build --workspace=libs/common --workspace=libs/crypto --workspace=libs/providers`, sau đó `node -e "require('@hub/providers'); require('@hub/common')"`. Kết quả: `LogThrottle` là `function`, `empty_body` là `422`, không có `MODULE_NOT_FOUND`.
  - Ghi chú: trước khi build lại, `tsc -p libs/providers` báo đỏ vì `libs/common/dist` (gitignored) còn bản cũ từ 07:01. Đây là trạng thái máy local, không phải lỗi. Docker xoá `dist` trước khi build.
- `hub-worker` vẫn re-export `LogThrottle` và `INFRA_LOG_INTERVAL_MS` nên chỗ import cũ không gãy. `delivery-infra-errors.spec` xanh 11/11.
- Web không bị ảnh hưởng. Web chỉ dùng alias `@hub/providers/catalog`, mà `identify.ts` chỉ import kiểu. Web không import barrel `@hub/common` ở mã chạy, chỉ trong jest spec. Vì vậy `perf_hooks` không vào bundle client.

### c. Log warn có nhịp

- Map `sourceKey → LogThrottle` đếm trong bộ nhớ, trần 1000 nguồn. Khi đầy thì `clear()`, nên map không lớn mãi. **0 lệnh Redis.** `redis-budget.spec` xanh 16/16.
- Trường được log chỉ có `{sourceKey, idempotencyPath, suppressed}`. Test khẳng định giá trị body (`secret-ish`) không lọt vào log.
- Log `sourceKey` đã có tiền lệ ở `penalty-box.ts:567`.
- Không log khi giá trị vắng, chuỗi rỗng hoặc chuỗi hợp lệ. Có test cho điều này.

### d. Mã `empty_body`

Nhất quán giữa catalog lỗi, ERRORS.md, adapter (`EMPTY_BODY_ERROR`), `Diagnosis` và i18n web. Xem §2.

## Lỗi mới

### Nặng
Không có.

### Trung bình
Không có.

### Thấp

- **L-1 — Chưa ghim `engines.node >= 22`.**
  - `package.json` gốc và các workspace đều không có `engines`.
  - T-c dựa vào tính năng của Node ≥ 21. Khi chạy trên Node 20, runtime vẫn hỏng an toàn (§3a), nhưng test T-c sẽ đỏ, và `field` quay về hành vi làm tròn mà không có dấu hiệu gì.
  - Đề xuất: thêm `"engines": {"node": ">=22"}` ở gốc. Hoặc thêm một test nhỏ khẳng định reviver có `source`, để việc hạ Node bị phát hiện bằng một thông báo rõ ràng.
- **L-2 — Rủi ro Pipedrive v1 còn lại khi dev chọn tay mục pipedrive.**
  - Rủi ro chỉ còn được chặn bằng nhãn. Đã chấp nhận ở §1 và ADR-230.
  - Backlog: thêm chẩn đoán chung "body ACCEPTED lệch fingerprint của mục đã chọn" trong Lắng nghe.
- **L-3 — Chẩn đoán `idempotency_path_not_scalar` che lỗi mapping** (`libs/providers/src/generic.adapter.ts:276-279`).
  - Phép kiểm path không vô hướng chạy **trước** `diagnoseMapping`. Nếu nguồn vừa trỏ path sai vừa có mapping hỏng, dòng ACCEPTED sẽ hiện `ok: true` kèm cảnh báo path.
  - Trong khi đó `mapping_field_missing` / `mapping_field_invalid` là `ok: false`: sự kiện sẽ lỗi normalize vĩnh viễn và không tới đích, nhưng lại bị giấu đi.
  - Chỉ xảy ra khi hai lỗi cấu hình trùng nhau, và trạng thái lỗi normalize vẫn thấy được ở danh sách sự kiện.
  - Đề xuất: chạy `diagnoseMapping` trước. Nếu kết quả `ok: false` thì trả nó. Nếu `ok` thì mới xét path không vô hướng. Thêm một test cho trường hợp có cả hai lỗi.

## Lệnh đã chạy

- jest `--maxWorkers=2`, từng file:

  | Spec | Kết quả |
  |---|---|
  | generic-idempotency | 24/24 |
  | error-catalog | 6/6 |
  | delivery-infra-errors | 11/11 |
  | listen-logic | 39/39 |
  | redis-budget | 16/16 |
  | ingest-idempotency-pk10 | 5/5 |
  | catalog-identify | 28/28 |
  | generic.adapter | 23/23 |

  **8/8 suite, 152/152 test xanh.**
- `tsc --noEmit`: hub-api cho exit 0, hub-worker cho exit 0. libs/providers cho exit 0 sau khi build lại `libs/common/dist` như Docker.
- Đã build libs giống Docker và `require` barrel `@hub/common` / `@hub/providers` lúc chạy: OK.
- Probe T-c chạy qua `dist`, gồm cả giả lập không có `source`. Kết quả ở §3a.
- WebFetch tài liệu Pipedrive `guide-for-webhooks` (v1) và `guide-for-webhooks-v2`.
- Ngoài file này, không đổi file nào được theo dõi trong git. `libs/*/dist` bị gitignore.
