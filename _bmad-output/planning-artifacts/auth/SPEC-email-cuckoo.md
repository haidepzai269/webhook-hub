# SPEC — Kiểm tra email đã tồn tại bằng Cuckoo filter (gợi ý trên form đăng ký)

> **ĐÍNH CHÍNH 2026-10-12 (Admin chốt): dùng `BloomFilter` của `bloom-filters`, KHÔNG dùng Cuckoo.** Mọi chỗ ghi "Cuckoo" bên dưới đọc thành "Bloom". Áp dụng ngay cho §1, §3, §5.
> - **Lý do:** `bloom-filters@3.0.4` `CuckooFilter` có lỗi âm tính giả. Công thức vị trí thay thế khi đẩy chỗ (`cuckoo-filter.js:221-224`) lệch `_locations`, nên filter báo "chưa có" cho email đã thêm. Đo được 34 353/100 000 email bị báo sai ở mức đầy 95%, và vẫn sai cả khi filter còn trống. Fingerprint còn bị tính sai: tỉ lệ dương tính giả ra 2,9% thay vì 0,1%. Gói `cuckoo-filter@1.1.4` thì `require` lỗi ngay, không dùng được. `BloomFilter` cùng thư viện đã đo: 0 âm tính giả, dương tính giả 0,086% với 100k email.
> - **Đánh đổi:** Bloom không xoá được phần tử. Hiện repo không có đường xoá user hay đổi email, và lượt dựng lại định kỳ (§3.2) chữa được nếu sau này có. Bỏ hẳn op `remove`.
> - **Đường tạo user:** cả 3 đường (mật khẩu, GitHub, Google) đều đi qua `AuthService.createUserWithFirstProject`, nên chỉ móc một chỗ, sau khi `$transaction` trả về. Operator do seed tạo, chỉ vào filter ở lượt dựng lại.
> - **ADR: GIỮ ADR-180.** Lý do: 165..173 là alerts, 174 là DS4 (docs-sync), từ 175 là `edge/SPEC-chong-qua-tai.md` (phiên webhook-hub-10 đang viết, chưa biết số cuối). Trước khi ghi vẫn grep lại; nếu 180 đã bị dùng thì lấy số trống kế tiếp và sửa dòng này.

> Phòng party viết 2026-10-12. Admin chốt: **hiện cho người dùng**, **dùng thư viện có sẵn**, làm trên nhánh riêng `feat/email-cuckoo`.
> Cần **ADR mới** (đảo một phần R-6/ADR-120). Grep số ADR tiếp theo trước khi ghi; ADR-164 đã dùng.

## 1. Vấn đề và quyết định

Hiện tại `POST /auth/register` trả **cùng 201 `REGISTER_ACCEPTED`** cho email mới và email đã có (R-6, ADR-120, chống dò email). Người dùng gõ lại email cũ sẽ không biết mình đã có tài khoản.

Admin muốn form đăng ký **báo ngay** khi email đã được dùng. Kiểm tra này đi qua **Cuckoo filter**:

- Câu trả lời "chắc chắn chưa có" (âm tính) **không chạm DB**.
- Câu trả lời "có thể có" (dương tính) được **xác nhận lại bằng Postgres**, nên người dùng không bao giờ thấy "đã dùng" sai.

Dùng Cuckoo thay vì Bloom vì Cuckoo **xoá được** phần tử, còn Bloom thì không.

Áp dụng BB-2: filter là đường tắt và **được phép sai**. `UNIQUE(users.email)` vẫn là trọng tài. Ở `auth.service.ts:164`, P2002 vẫn trả đúng hình dạng nhánh "đã tồn tại".

**Đánh đổi bảo mật (phải ghi ADR):** endpoint kiểm tra là một **oracle dò email**. Giảm thiểu bằng rate limit chặt (§3.3) và log. `POST /auth/register` **giữ nguyên R-6**: vẫn 201 cùng body, không đổi.

## 2. Phạm vi

| Trong | Ngoài |
|---|---|
| Endpoint `POST /auth/email-check` | Đổi hành vi `/auth/register`, `/auth/login` (giữ R-6) |
| Filter trong bộ nhớ hub-api + đồng bộ nhiều instance | RedisBloom / redis-stack (không hỗ trợ ở Upstash, không đổi compose) |
| Gợi ý trên ô email của `/register` | Gợi ý ở login / forgot-password (giữ chống dò) |
| Thêm/xoá email vào filter ở mọi đường tạo/xoá user | Kiểm tra `name` (không unique) |

## 3. Thiết kế

### 3.1. Thư viện
- `bloom-filters` (MIT, có class `CuckooFilter`). Kiểm version mới nhất ổn định đã ≥ 2 tuần, ghim chính xác version.
- Nếu thư viện không hợp (ESM/CJS với Nest, typing…), báo lại trước khi đổi. Không tự viết thuật toán.
- Bọc trong `EmailFilterService` (hub-api, module auth). Phần còn lại của code không import thư viện trực tiếp.
- Khoá đưa vào filter là `normalizeEmail(email)` (trim + lowercase), **dùng chung** hàm chuẩn hoá mà auth đang dùng.

### 3.2. Vòng đời
- **Khi boot:** dựng filter từ `hub.users` theo lô, dùng keyset `(id)`, không OFFSET. Truy vấn đi qua repository/đường mà auth đang dùng cho bảng `users`, theo quy ước repo, không query thô.
- **Chưa dựng xong** (`ready=false`): endpoint đi thẳng DB. Đúng nhưng chậm, giống BB-2.
- **Kích thước:** cấu hình `EMAIL_FILTER_CAPACITY` (mặc định 100 000) và tỉ lệ dương tính giả mục tiêu khoảng 0.1%. Filter đầy (insert thất bại) thì log cảnh báo và đặt cờ `degraded`, từ đó mọi kiểm tra đi DB.
- **Thêm:** ở **mọi** đường tạo user:
  - đăng ký mật khẩu;
  - tạo user qua GitHub OAuth;
  - tạo user qua Google OAuth;
  - nhận lời mời, nếu có tạo user.

  Chỉ thêm **sau khi COMMIT** (giống `SET NX` của ingest).
- **Xoá:** nếu repo có đường xoá user hoặc đổi email thì gọi `remove`. Grep, chưa có thì ghi rõ trong báo cáo.
- **Đồng bộ nhiều instance:**
  - Sau COMMIT: `PUBLISH hub:auth:email-filter {op:'add'|'remove', email}`. Kênh này dùng **chung một connection subscriber** sẵn có nếu có, tôn trọng giới hạn kết nối Upstash.
  - Instance nhận tin thì áp vào filter của mình. Instance phát cũng áp ngay tại chỗ, không chờ tin vọng lại.
  - Mất tin pub/sub thì filter của instance đó có âm tính giả: nó báo "chưa dùng" sai. Hậu quả chỉ là mất một gợi ý; đăng ký vẫn đúng nhờ UNIQUE và R-6.
  - Chữa bằng **dựng lại định kỳ** (`EMAIL_FILTER_REBUILD_MS`, mặc định 10 phút), dựng vào bản mới rồi mới hoán đổi.
- Redis chết: chỉ mất đồng bộ, filter cục bộ vẫn chạy. Không thêm lệnh Redis nào vào đường nóng ingest/delivery; ngân sách R1 không đổi. Chạy `apps/hub-api/test/redis-budget.spec.ts`.

### 3.3. Endpoint
- `POST /auth/email-check`, body `{ email }`. Dùng POST để email không lọt vào URL hay access log.
- Validate email như form đăng ký. Sai định dạng thì 400 theo khuôn lỗi chung (`docs/ERRORS.md`).
- Trả `200 { available: boolean }`:
  - filter âm tính → `available: true`, không chạm DB;
  - filter dương tính → xác nhận bằng DB: có thì `false`, không có (dương tính giả) thì `true`.
- **Rate limit:**
  - theo IP: 20 lần/phút, dùng cơ chế `auth/rate-limit.ts` sẵn có;
  - thêm trần toàn cục cho endpoint để giới hạn dò hàng loạt từ nhiều IP: 600 lần/phút.

  Vượt thì 429 kèm `Retry-After`, theo khuôn lỗi chung.
- Không cookie, không cần đăng nhập. Không log email thô, chỉ log hash hoặc độ dài.
- Metric Prometheus: `email_filter_checks_total{result="negative|positive_confirmed|false_positive|db_fallback"}`, `email_filter_size`.

### 3.4. Giao diện `/register`
- Đã gõ email đúng định dạng thì debounce 400ms rồi gọi `/auth/email-check` qua proxy web. Huỷ request cũ bằng AbortController.
- `available:false`: dưới ô email hiện "Email này đã có tài khoản. **Đăng nhập** hoặc **quên mật khẩu**?" (link tới `/login` và `/forgot-password`, mang theo email).
- `available:true`: không hiện gì, hoặc dấu ✓ nhỏ. Tránh nhiễu.
- 429 hoặc lỗi mạng thì im lặng. Gợi ý **không bao giờ** chặn nút submit, vì server mới là trọng tài.
- i18n vi + en. A11y: gợi ý gắn `aria-describedby` và dùng `aria-live="polite"`.
- Giữ đúng phong cách giao diện auth mới (`auth.module.css`, `AuthField`).

## 4. Test (gắn mã theo quy ước `verify:map` nếu bắt buộc)
- Unit `EmailFilterService`:
  - add/has/remove;
  - chuẩn hoá hoa/thường và khoảng trắng;
  - chưa ready thì đi DB;
  - đầy thì `degraded`;
  - dựng lại rồi hoán đổi.
- Endpoint:
  - email mới → `true`, không gọi DB (spy);
  - email đã có → `false`;
  - dương tính giả (mock filter) → DB → `true`;
  - sai định dạng → 400;
  - quá trần → 429.
- Đường tạo user (đăng ký, GitHub, Google): sau COMMIT thì email vào filter và có publish. Tx lỗi thì không add.
- Xử lý tin pub/sub: áp `add`/`remove`.
- `register` vẫn R-6: email đã có và email mới trả body giống hệt nhau. Đây là test hồi quy: không được đỏ.
- Redis budget spec vẫn xanh.

## 5. ADR (ghi khi làm)
- **Vấn đề:** người dùng không biết email đã có tài khoản (hệ quả của R-6).
- **Chọn:** thêm endpoint gợi ý dùng Cuckoo filter trong bộ nhớ (`bloom-filters`), xác nhận dương tính bằng PG, đồng bộ qua pub/sub và dựng lại định kỳ. `/register` vẫn R-6.
- **Đánh đổi:** mở một oracle dò email, có rate limit theo IP và toàn cục. Bộ nhớ khoảng vài trăm KB mỗi instance. Có thể có âm tính giả tạm thời khi mất pub/sub.

## 6. Xong khi
- [ ] tsc 4 app, `npx jest --maxWorkers=2`, `verify:map`, gitleaks, `next build` web đều xanh.
- [ ] Có reviewer riêng; sau mỗi lượt sửa có review lại.
- [ ] ADR + cập nhật `docs/ARCHITECTURE.md` (mục auth/bảo mật) và `docs/DEPLOYMENT.md` (env mới).
