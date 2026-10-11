# SPEC — Cách B: dev lạ tự cắm Shop vào project của mình (console Project + API key, trang Cài đặt của Shop)

> **Ngày:** 2026-10-12 · **Trạng thái:** sẵn sàng cho phiên DEV · **Admin chốt:** "làm theo cách B; Shop có một trang setting tạm để điền hết những gì cần để kết nối tới project hub".
> **Liên quan:** SPEC-ket-noi (KN1–KN4, ADR-138/151–153), P1/P2 (ADR-141/144/154), REVIEW-ADR154 (M-1, M-2).
> **Tiền tố test:** `SK:` (thêm vào SPEC-verification §3.1 + `verify/spec-sources.json` ở commit đầu).

## 1. Vì sao

Hiện Shop chỉ nối được vào project `default` của operator, và mọi thứ nằm cứng trong env Render (`HUB_URL`, `SHOP_PAYMENT_SOURCE_KEYS`, `PAYOS_*`). Một dev lạ đăng ký hub thì có project rỗng nhưng:
- console **không có trang Project và trang API key**, nên không lấy được connection string (backend đã có: `GET/POST /api/v1/projects`, `GET/POST/DELETE /api/v1/projects/:id/keys`);
- muốn đổi project của Shop phải sửa env trên Render rồi redeploy.

**Thước đo (kịch bản demo):** dev mới, không đụng Render:
> đăng ký → tạo project → tạo API key (copy connection string) → Sources → **Kết nối PayOS** (hub sinh source mới) → mở **Shop → Cài đặt** → dán connection string + chọn source + dán khoá PayOS → **Lưu** → Shop tự đăng ký endpoint vào project đó → mua món 5.000đ → PAID, và cả luồng hiện trong console **của project dev đó**.

## 2. Vì sao khoá PayOS nằm ở HAI chỗ (trả lời câu hỏi của Admin; ghi ADR)

Không phải trùng lặp. Mỗi chỗ làm một việc khác nhau, của cùng một chủ là dev:

| Nơi giữ | Dùng để | Cần trường nào |
|---|---|---|
| **Hub** (source PayOS, KN3) | **nhận** webhook: verify chữ ký, và (khi bấm "Kết nối") đăng ký URL webhook tại PayOS | `checksumKey`; thêm `clientId` + `apiKey` nếu dùng nút Kết nối |
| **Backend của dev** (Shop) | **tạo link thanh toán** cho đơn hàng (nghiệp vụ) | `clientId` + `apiKey` + `checksumKey` |

- Hub **không** tạo link thanh toán thay Shop: hub không biết "đơn hàng" là gì (BB-1).
- Shop **không** đọc khoá từ hub: hub không bao giờ trả credentials ra API (SPEC-ket-noi §4.3, điều 2).
- Đây đúng là mô hình thật: Stripe + Svix/Hookdeck. Backend giữ API key để tạo charge; cổng webhook giữ signing secret để verify.

→ Việc của spec này là làm cho chỗ thứ hai **dễ điền** (một trang Cài đặt), không phải xoá nó.

## 3. Phần A — Console hub: trang Project + trang API key (`apps/web`, P3 rút gọn)

Dùng route backend sẵn có. Không thêm route mới trừ khi thiếu thật (ghi vào §8).

- **Chọn project** ở header hoặc sidebar: danh sách project của user, chọn project đang làm việc. Mọi trang console sau đó dùng project này (kiểm cách console đang truyền project: header/cookie/guard `project-scope.guard.ts`).
- **Trang Project:** xem danh sách, **tạo project** (tên + slug; 409 slug trùng thì hiện lỗi tiếng Việt).
- **Trang API key** của project đang chọn:
  - danh sách key gồm tên, scope, prefix 4 ký tự, lần dùng cuối, trạng thái;
  - tạo key: tick scope `manage:endpoints`, `read:events`, `publish:events`. Mặc định cho Shop là `manage:endpoints` + `read:events`;
  - sau khi tạo, hộp **"Chỉ hiện một lần"** với ô copy `HUB_URL=hubs://…` (connection string đầy đủ);
  - thu hồi key.
- Không hiện lại key thô ở bất kỳ đâu sau lần đầu.

## 4. Phần B — Shop: trang **Cài đặt kết nối** (`/shop/settings` trên web + API trong `apps/shop`)

### 4.1 Lưu ở đâu

- Bảng mới `shop.settings` (một dòng):
  - các trường thường: `hub_connection_url`, `payment_source_keys text[]`, `bank_code`, `bank_account`, `bank_account_name`, `updated_at`;
  - các trường bí mật **mã hoá AES-256-GCM**: `hub_connection_url` (chứa key), `payos_client_id`, `payos_api_key`, `payos_checksum_key`. Khoá mã hoá là env mới **`SHOP_SETTINGS_KEY`** (32 byte base64); tái dùng `libs/crypto` nếu có thể.
- **Thứ tự ưu tiên:** giá trị trong `shop.settings` thắng env. Env cũ (`HUB_URL`, `SHOP_PAYMENT_SOURCE_KEYS`, `PAYOS_*`, `SHOP_BANK_*`) vẫn là **mặc định** khi chưa lưu gì. Nhờ vậy bản deploy hiện tại không đổi hành vi (cách A vẫn chạy).

### 4.2 Bảo vệ (Shop không có đăng nhập, ADR-024)

- Mọi route cài đặt yêu cầu header `x-shop-admin-token` = env **`SHOP_ADMIN_TOKEN`**, so bằng `timingSafeEqual`.
- Env không đặt thì route trả 404, tức là tắt hẳn tính năng.
- Giới hạn tốc độ: tối đa 5 lần sai mỗi phút cho mỗi IP.
- `GET /settings` **không bao giờ trả bí mật**. Chỉ trả `configured: true/false` và 4 ký tự cuối, cùng một mẫu với redact của hub.
- Log và audit không chứa giá trị bí mật.

### 4.3 Route của Shop

- `GET /settings`: trả giá trị hiện tại đã che, kèm nguồn (`db` | `env` | `none`) của từng trường.
- `POST /settings/test-hub`: body là connection string. Shop gọi `hub.me()` rồi `GET /v1/p/:project/sources`, trả về project, service, scope và **danh sách source** (key, provider, tên) để UI cho chọn. Thiếu scope thì trả lỗi kèm `fix` (khuôn DX1).
- `PUT /settings`: lưu (chỉ ghi các trường được gửi; trường để trống thì giữ nguyên). Sau khi lưu:
  1. tạo lại hub client;
  2. **chạy lại đăng ký endpoint** (`hub-registration.ts`: `ensure` + subscription ghim `payment_source_keys`, `exclusive`) **ngay, không cần redeploy**;
  3. trả kết quả đăng ký: VERIFIED/FAILED + `verificationFix`.
- Các chỗ đang đọc env (`main.ts` cho HUB_URL/PAYMENT_SOURCE_KEYS, `payos.ts` cho PAYOS_*, VietQR cho SHOP_BANK_*, `/payment-options`) chuyển sang đọc **một hàm `getSettings()`** có cache trong bộ nhớ, bị xoá khi `PUT`.

### 4.4 UI `/shop/settings` (web, nhóm `(shop)`)

- Ô nhập **mã quản trị**, chỉ giữ trong `sessionStorage` của tab.
- **Bước 1: Kết nối hub.** Ô dán `HUB_URL`, nút **Kiểm tra**. Hiện "Đã nối project … với tư cách service …", rồi danh sách source để **tick** những nguồn thanh toán tin cậy (gợi ý sẵn các source `payos`/`sepay`).
- **Bước 2: PayOS** (để tạo link thanh toán). Ba ô `clientId`, `apiKey`, `checksumKey`, mỗi ô có dòng giải thích ngắn. Có thêm ghi chú: *"Đây là khoá để Shop **tạo link thanh toán**. Hub giữ riêng khoá của nó để **nhận webhook** (xem §2)."* Nếu checksumKey khác key source PayOS bên hub thì webhook sẽ 401. UI chỉ nhắc đối chiếu 4 ký tự cuối, không tự so.
- **Bước 3: VietQR (tuỳ chọn).** Mã ngân hàng, số tài khoản, tên chủ tài khoản.
- Nút **Lưu và kết nối** hiện kết quả đăng ký endpoint: ✅ VERIFIED, hoặc ❌ kèm `verificationFix`.
- Trên đầu trang có link sang console hub để tạo key và kết nối PayOS.

### 4.5 Kích thước Shop

Phần này vượt trần 450 dòng (ADR-141/144). **Nới trần lên ~600 dòng** cho `apps/shop/src` bằng ADR mới (lý do: cách B là kịch bản demo chính). Tách thành file `settings.ts`. Cập nhật gate `shop-size` và dòng trong CLAUDE.md.

## 5. Phần C — Gộp các sửa còn nợ (REVIEW-ADR154)

- **M-1:** đơn **PayOS** đã hết hạn mà còn thiếu thì chỉ hiện "gọi hotline", không hiện "chuyển thêm cùng nội dung". Lời nhắn UNDERPAID của đơn PayOS cũng vậy.
- **M-2:** sửa câu sai trong ADR-154. Thêm: khi đơn vẫn còn trong `sessionStorage` (tab còn mở), mở lại modal hoặc tải lại trang thì **hỏi trạng thái một lần**, để khách trả muộn vẫn thấy PAID. Đọc thêm `?order=` từ `returnUrl` của PayOS.
- **L-2:** sửa câu log `LATE_PAYMENT`. **L-1:** bỏ câu "tối thiểu 2.000đ" không có nguồn.

## 6. Story

| ID | Nội dung | Ước lượng |
|---|---|---|
| **SK1** | Console: chọn project + trang Project + trang API key (copy connection string một lần, thu hồi) | 2.5h |
| **SK2** | Shop: `shop.settings` (migration, mã hoá), `getSettings()` thay các chỗ đọc env, route `/settings*` có token, đăng ký lại endpoint khi lưu, ADR nới trần | 3h |
| **SK3** | Web `/shop/settings` (3 bước + kết quả) | 2h |
| **SK4** | Phần C (M-1, M-2, L-1, L-2) + tài liệu: HUONG-DAN-DEPLOY (env mới `SHOP_SETTINGS_KEY`, `SHOP_ADMIN_TOKEN`), HUONG-DAN-TEST-TINH-HUONG (tình huống mới "Cắm Shop vào project của bạn"), ADR "khoá PayOS ở hai chỗ" (§2) | 1.5h |

## 7. Test (tối thiểu)

| Mã | Kiểm |
|---|---|
| `[SK:U1]` | `GET /settings` không chứa bí mật (quét JSON). Token sai → 401, thiếu env token → 404 |
| `[SK:U2]` | DB có giá trị thì thắng env; chưa lưu gì thì hành vi y như trước (regression cho cách A) |
| `[SK:U3]` | `PUT` đổi HUB_URL thì client mới được dùng, `ensure` chạy lại với `payment_source_keys` mới. Webhook từ source cũ thì không còn được tin |
| `[SK:U4]` | Cột bí mật trong DB không chứa plaintext |
| `[SK:U5]` | `test-hub` dùng key thiếu scope thì trả lỗi kèm `fix` |
| `[SK:U6]` | Console: tạo key xong thì connection string hiện một lần. Thu hồi key thì Shop gọi hub nhận 401 |
| `[SK:U7]` | M-1 / M-2 như §5 |
| `[SK:T1]` | (L2 trên hubv nếu chạy được) dev mới → project → key → source → Shop settings → thanh toán giả qua hub-sim → PAID trong project mới, project `default` không thấy event |

## 8. Lệch so với spec (phiên DEV ghi)

- …

## 9. Checklist

- [x] SK1 · [ ] SK2 · [ ] SK3 · [ ] SK4
