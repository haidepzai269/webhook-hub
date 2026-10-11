# Hướng dẫn test theo tình huống — bấm từng bước trên bản đã deploy

> Viết cho Admin, để tự bấm thử sản phẩm thật như một người dùng. Mỗi kịch bản gồm: **Mục tiêu → Chuẩn bị → Các bước → Bạn sẽ thấy → Nếu không thấy**.
> Mọi tên menu, nút, ô nhập dưới đây được chép đúng từ code giao diện (`apps/web`) ngày 2026-10-11.
> Chỗ nào **không có trên giao diện** thì có ghi rõ, kèm một cách thay thế ngắn nhất.
> Tài liệu này không chứa bí mật nào. Chỗ cần khoá thì ghi `<lấy trong KEYS-CAN-LAY.md mục …>`.

| | Địa chỉ |
|---|---|
| Console (web) | https://webhook-hub-rouge.vercel.app |
| Cửa hàng (giao diện mua) | https://webhook-hub-rouge.vercel.app/shop *(trang mua nằm trên web; `shop-o398.onrender.com` chỉ là API, mở `/` sẽ ra 404, đúng như thiết kế)* |
| Hub API | https://hub-api-c9hg.onrender.com |
| API của Shop | https://shop-o398.onrender.com (kiểm bằng `/products`) |

---

## Trước khi bắt đầu (5 phút)

- [ ] **Đánh thức hub.** Mở https://hub-api-c9hg.onrender.com/health → chờ tới khi thấy `"status":"healthy"` và cả 3 mục `postgres`, `redis`, `rabbitmq` đều `up`. Lần đầu có thể mất 30–60 giây (Render free ngủ sau ~15 phút).
- [ ] **Đánh thức shop.** Mở https://shop-o398.onrender.com/products → chờ ra danh sách món dạng JSON. Lần đo gần nhất mất **~42 giây**. Shop không được UptimeRobot ping nên lúc nào cũng có thể đang ngủ.
- [ ] **UptimeRobot** đang ping `hub-api …/health` mỗi 5 phút (HUONG-DAN-DEPLOY §10). Nếu monitor đang tạm dừng thì bước "đánh thức" ở trên lại càng quan trọng.
- [ ] **Dùng cửa sổ ẩn danh** nếu trình duyệt có extension chặn quảng cáo hoặc chặn tracker. Đã gặp trường hợp extension chặn `/health` hoặc chặn socket realtime. Khi test cô lập (kịch bản 8), mở thêm **một trình duyệt khác** cho người dùng B.
- [ ] **Tài khoản cần có:**
  - Tài khoản **operator** (email + mật khẩu): `<lấy trong KEYS-CAN-LAY.md mục tài khoản operator>`. Operator thấy được mọi project, kể cả `default` (project của Shop). Operator **không** đăng nhập được bằng Google/GitHub, và đó là đúng thiết kế.
  - Một **Gmail thứ hai** (người dùng B) để thử đăng ký và kiểm tra cô lập.
  - Một **repo GitHub** của bạn để gắn webhook (repo rỗng cũng được).
  - **PayOS** (kịch bản 2): đăng nhập được my.payos.vn, có tài khoản ngân hàng thật để tự chuyển tiền.
- [ ] Mở sẵn file `KEYS-CAN-LAY.md` ở máy của bạn. Đừng dán bất kỳ khoá nào vào tài liệu này.

**Bản đồ menu console** (thanh bên trái, nhóm theo thứ tự trên màn hình):

| Nhóm | Mục | Dùng để |
|---|---|---|
| *(đầu thanh)* | ô chọn **Project** | đổi project. Mọi trang bên dưới chỉ hiện dữ liệu của project đang chọn |
| Luồng dữ liệu | **Bản đồ luồng** | sơ đồ nguồn → hub → đích, có chấm chạy realtime |
| | **Hành trình sự kiện** | mỗi dòng là một lần provider gọi vào. Có các tab **Tất cả / Đang chạy / Thất bại / Bị từ chối / Thành công** |
| | **Giao hàng (Deliveries)** | các lần hub gửi ra đích. Lọc theo `PENDING / DELIVERING / RETRYING / SUCCEEDED / DEAD` |
| | **DLQ** | các delivery đã chết (DEAD), có nút replay |
| Tổng quan | **Dashboard** | các thẻ số: Nguồn, Đích, Sự kiện, Deliveries, DLQ (DEAD), Tỉ lệ thành công; thẻ "Sức khoẻ hệ thống", "10 sự kiện gần nhất" |
| Cấu hình | **Nguồn (Sources)** | chỗ nhận webhook vào (GitHub/SePay/PayOS/Stripe) |
| | **Đích (Destinations)** | chỗ hub gửi webhook ra |
| | **Subscriptions** | luật định tuyến: loại sự kiện X → đích Y |
| Công cụ | **Playground** | tự bắn một webhook đã ký đúng vào hub |
| | **Nhật ký (Audit)** | ai đã làm gì, lúc nào |
| *(cuối thanh)* | **Mở Shop** · **Đăng xuất** | |

> **Chưa có trên giao diện:** trang quản lý Project (tạo project mới), **API key**, **Thành viên / lời mời**, và chức năng **sửa / tắt / xoá Nguồn**. Các kịch bản cần tới những việc này có ghi cách thay thế ngay tại chỗ.

---

## Kịch bản 1 — Đăng ký, xác minh email, đăng nhập (email và Google)

**Mục tiêu:** một người lạ tự đăng ký được và vào thẳng một project riêng của mình.
**Vì sao quan trọng:** hub là hạ tầng dùng chung. Người dùng mới phải tự phục vụ được, không cần admin tạo tài khoản hộ.

**Chuẩn bị:** dùng Gmail thứ hai (người dùng B) trong một trình duyệt khác hoặc cửa sổ ẩn danh.

### 1a. Đăng ký bằng email
1. Mở https://webhook-hub-rouge.vercel.app/register → thấy tiêu đề **ĐĂNG KÝ**.
2. Điền **EMAIL**, **TÊN HIỂN THỊ**, **MẬT KHẨU** (tối thiểu 10 ký tự, không được chứa phần trước dấu @ của email), **NHẬP LẠI MẬT KHẨU**.
3. Bấm **ĐĂNG KÝ**.
4. Thấy dòng: *"Đã gửi link kích hoạt tới … Mở link trong email, đặt mật khẩu để kích hoạt…"*.
5. Mở hộp thư → mở thư xác minh → bấm link trong thư.
6. Thấy trang **KÍCH HOẠT TÀI KHOẢN**, có các ô **TÊN HIỂN THỊ**, **MẬT KHẨU**, **NHẬP LẠI**. Trang này **bắt đặt lại mật khẩu**: mật khẩu nhập lúc đăng ký sẽ bị bỏ. Đây là chủ ý, để chống chiếm tài khoản bằng cách đăng ký trước.
7. Điền xong → bấm **KÍCH HOẠT**.

**Bạn sẽ thấy:** tự chuyển vào `/dashboard`. Ô **Project** ở đầu thanh bên hiện **"<Tên của bạn>'s project"**, được tạo tự động lúc đăng ký. Các thẻ số trên Dashboard đều bằng 0.

**Nếu không thấy:**
- Không có thư: xem thư mục Spam. Nếu vẫn không có, refresh token Gmail của hub có thể đã hết hạn (HUONG-DAN-DEPLOY §12, dòng "Mail không tới"). Thử đăng ký lại bằng cùng email để nhận link mới.
- *"Link không hợp lệ, đã dùng hoặc đã hết hạn"*: link chỉ dùng được một lần. Đăng ký lại bằng cùng email.
- *"Không kết nối được hub-api"*: hub đang ngủ. Mở `/health`, chờ, rồi thử lại.

### 1b. Đăng nhập và đăng xuất
1. Bấm **Đăng xuất** (cuối thanh bên) → về trang **ĐĂNG NHẬP**.
2. Điền **EMAIL**, **MẬT KHẨU** → bấm **ĐĂNG NHẬP** → vào lại dashboard.
3. Thử sai mật khẩu → thấy *"Email hoặc mật khẩu không đúng, hoặc email chưa xác minh…"*. Thông báo cố ý không nói rõ sai cái nào, để chống dò tài khoản.
4. Nhấn F5 trên dashboard → vẫn đăng nhập.

### 1c. Đăng nhập bằng Google
1. Ở trang **ĐĂNG NHẬP**, bấm nút có logo **G** (ngay dưới form) → chọn một tài khoản Google **chưa từng đăng ký** bằng mật khẩu.
2. Thấy vào thẳng dashboard với project riêng.

**Nếu không thấy:** dòng đỏ trên trang đăng nhập cho biết lý do. Ví dụ *"Email này đã có tài khoản và Google không phải nơi cấp email đó — đăng nhập bằng mật khẩu…"* nghĩa là email đó đã đăng ký bằng mật khẩu trước. Đây là đúng thiết kế, không phải lỗi. Còn *"Operator không đăng nhập bằng Google"* là do bạn đang dùng email operator.

> Nút **GH** (GitHub) cũng có và chạy theo cùng cách. Mục **Quên mật khẩu?** nằm dưới nút ĐĂNG NHẬP.

---

## Kịch bản 2 — Mua hàng, thanh toán qua PayOS, đơn chuyển sang PAID

**Mục tiêu:** một khoản tiền thật đi theo đường PayOS → hub → Shop. Đơn chuyển **PAID**, và console thấy được sự kiện `payment.received` cùng delivery tới `shop`.
**Vì sao quan trọng:** đây là luồng xuyên suốt của đề tài. Hub chỉ trả 2xx cho PayOS **sau khi** đã lưu chắc vào Postgres (BB-3). Shop chỉ hiểu một kiểu dữ liệu duy nhất là `payment.received` và không có `if` theo từng provider. Hub cũng không biết "đơn hàng" là gì (BB-1).

> ⚠️ **Đọc trước: giới hạn của code hiện tại.**
> - Shop **không tự tạo link/QR thanh toán PayOS**. `apps/shop` không gọi API PayOS. Web luôn tạo đơn với `paymentProvider: "sepay"`. Các biến `PAYOS_CLIENT_ID/API_KEY/CHECKSUM_KEY` của Shop hiện không được dùng.
> - Mã QR hiện trong cửa sổ thanh toán **không phải QR ngân hàng (VietQR)**. Nó chỉ mã hoá dòng chữ `DHxxxxxxxxxx <số tiền>`, nên quét bằng app ngân hàng sẽ không ra lệnh chuyển khoản.
> - Vì vậy, đường PayOS thật dưới đây cần **bạn tự tạo một yêu cầu thanh toán trên trang quản trị PayOS**, với đúng số tiền và nội dung là mã đơn. Shop khớp đơn bằng cách tìm `DH` + chữ số trong nội dung (`data.description` của PayOS).
> - Đơn **hết hạn sau 15 phút** kể từ lúc tạo. Tiền tới sau 15 phút thì đơn thành `EXPIRED` chứ không thành PAID. Hãy chuẩn bị PayOS xong **trước khi** tạo đơn.

### 2.0. Cấu hình PayOS gọi vào hub (chỉ làm một lần)
1. **Đánh thức hub trước** (mục "Trước khi bắt đầu"). Khi bạn lưu webhook URL, PayOS sẽ bắn ngay một request kiểm tra và đòi hub trả 200. Nếu hub đang ngủ, PayOS báo lỗi và không lưu (cạm bẫy số 4).
2. Đăng nhập console bằng **operator** → ở ô **Project** chọn **`default`**.
3. Bấm **Nguồn (Sources)** → tìm dòng provider `payos` (sourceKey `src_payos_main`) → bấm nút sao chép ở cột **Webhook URL (dán vào provider)**. URL phải có dạng:
   `https://hub-api-c9hg.onrender.com/hooks/payos/src_payos_main`
4. Vào my.payos.vn → **Kênh thanh toán** → chọn kênh của bạn → dán URL vào ô **Webhook URL** → lưu.
5. **Checksum key** của kênh PayOS này phải **trùng** với secret mà hub đã lưu cho `src_payos_main`: `<lấy trong KEYS-CAN-LAY.md mục PayOS>`. Nếu khác, mọi webhook PayOS sẽ bị hub trả 401.

**Cách nhanh hơn (sau KN3, ADR-151) thay cho bước 3–5:** **Nguồn (Sources)** → **Kết nối provider** → chọn **payos** → ở mục **Nguồn** để **"Kết nối nguồn có sẵn"** và chọn **`src_payos_main`** (mặc định khi project đã có nguồn PayOS) → dán Client ID, Api Key, Checksum Key của kênh → tick *"Tôi hiểu URL cũ sẽ bị thay"* → **Kết nối**. Hub tự đăng ký đúng URL `/hooks/payos/src_payos_main` tại PayOS, không mở my.payos.vn. Checksum key khác bản đã lưu thì hub thêm version mới và **giữ cả hai** cho tới khi webhook thật xác minh bằng key mới (ADR-152); mở lại 🔗 của nguồn mà thấy `secret_mismatch` = key vừa dán sai, dán lại đúng rồi **Thử lại**. Dán đúng checksumKey đang dùng (đối chiếu 4 ký tự cuối) là an toàn nhất.
> ⚠️ **Không** chọn "Tạo nguồn mới" cho kênh mà Shop đang dùng: nguồn mới có sourceKey mới, PayOS sẽ gửi vào đó, còn Shop chỉ tin `src_payos_main` (`SHOP_PAYMENT_SOURCE_KEYS`) → đơn **không bao giờ PAID**.

**Bạn sẽ thấy:** PayOS báo lưu thành công. Trên console → **Hành trình sự kiện**, có thể xuất hiện **một sự kiện mẫu** của PayOS (số tiền và nội dung mẫu kiểu `VQRIO123`). Điều này bình thường: Shop nhận được, không tìm thấy mã đơn nên bỏ qua.

**Nếu không thấy:**
- PayOS báo webhook URL không hợp lệ: hub đang ngủ hoặc đang khởi động. Mở `/health`, chờ `healthy`, rồi lưu lại.
- Có dòng mới ở tab **Bị từ chối** (HTTP 401): checksum key lệch với secret của `src_payos_main`.
- Không có dòng nào: sai sourceKey trong URL, hoặc đang chọn nhầm project (phải là `default`).

### 2.1. Mua hàng và thanh toán thật
1. Đánh thức Shop (`/products`, chờ ra JSON).
2. Mở https://webhook-hub-rouge.vercel.app/shop (hoặc bấm **Mở Shop** trên console).
3. Ở thực đơn, bấm nút **+** (*"Thêm 1 phần … vào giỏ"*) trên một món. Có thể bấm vào món để mở chi tiết, rồi bấm nút thêm vào giỏ cho tới khi thấy *"Đã thêm vào giỏ!"*.
4. Bấm **Giỏ hàng** → kiểm **Tạm tính** → bấm **Thanh toán**.
5. Trong cửa sổ thanh toán (các bước **Thông tin → Chuyển khoản → Hoàn tất**), điền **Họ tên \***, **Số điện thoại \***, và nếu muốn thì **Địa chỉ giao hàng**, **Ghi chú**. Ở mục **Cách thanh toán** để **PayOS** (mặc định khi Shop đã có khoá PayOS) → bấm **Tạo đơn & lấy mã QR**.
6. Thấy **"Quét VietQR bằng app ngân hàng"** với mã QR thật do PayOS cấp, nút **Mở trang thanh toán PayOS**, **mã đơn** dạng `DH` + 7 chữ số, **Số tiền**, và trạng thái *"Đang chờ thanh toán…"*. **Ghi lại mã đơn và số tiền.** (Shop đã tự tạo link PayOS với mô tả = mã đơn, ADR-141 — không cần tạo link thủ công trên my.payos.vn nữa.)
7. Mở app ngân hàng → quét QR (hoặc bấm **Mở trang thanh toán PayOS** rồi quét ở đó). Số tiền và nội dung đã điền sẵn.
8. Xác nhận chuyển khoản (tiền vào tài khoản của chính bạn).
9. **Giữ nguyên cửa sổ Shop.** Cửa sổ tự hỏi lại trạng thái đơn vài giây một lần, tới hết hạn đơn (mặc định 30 phút, `SHOP_ORDER_TTL_MIN`).

**Bạn sẽ thấy:**
- Trên Shop: thấy dòng **"Đã thanh toán!"** và *"Đơn DH… đã nhận … Bếp đang chuẩn bị món cho bạn."* Thanh bước nhảy sang **Hoàn tất**.
- Trên console (operator, project `default`):
  - **Hành trình sự kiện** → dòng mới ở đầu: Provider PayOS, cột *Type · subject* là `payment.received`, trạng thái thành công → bấm vào dòng để mở **Chi tiết sự kiện**. Ở đó có thẻ **Event Type**, thẻ **Source**, và sơ đồ **Hành trình**. Bấm một node để xem tab **Vào / Ra / Chi tiết**. Trong `data`, các trường `amount`, `currency: "VND"`, `memo` chứa mã đơn.
  - **Giao hàng (Deliveries)** → bấm bộ lọc `SUCCEEDED` → dòng có **Đích** = `shop`, **HTTP** 200.
  - **Bản đồ luồng** → chấm xanh chạy từ nguồn PayOS qua hub tới `shop`.

**Nếu không thấy:**
- Shop vẫn *"Đang chờ thanh toán…"* và delivery tới `shop` ở trạng thái **RETRYING** (503): Shop đang ngủ hoặc chưa đăng ký xong với hub. Hub tự gửi lại (10 giây → 1 phút → 5 phút…), chỉ cần chờ.
- Có sự kiện nhưng đơn không đổi: nội dung PayOS không chứa đúng mã `DH…` (Shop ghi *UNMATCHED*), hoặc tiền đến từ **kênh khác** kênh đã chọn khi tạo đơn (Shop ghi *OTHER_CHANNEL*, không cộng — tránh cộng đôi khi một tài khoản đứng sau cả PayOS lẫn SePay), hoặc số tiền nhỏ hơn giá đơn (đơn thành **UNDERPAID**, Shop hiện *"Đã nhận …, còn thiếu …"*).
- Đơn ghi *"Đơn đã hết hạn"*: đã quá hạn đơn (mặc định 30 phút). Link PayOS hết hạn **sớm hơn đơn 5 phút** nên PayOS không cho trả sát hạn. Khoản đã trả **đúng hạn** luôn được tính theo giờ trả (`paidAt`), kể cả khi hub/Shop vừa ngủ dậy và webhook tới muộn (ADR-144). Tạo đơn mới. Nếu tiền về **sau** hạn thật (chuyển khoản thẳng), Shop ghi nhận và hiện *"Đơn đã hết hạn nhưng Shop đã nhận …"* (không mất tiền).
- Bấm **Tạo đơn** báo *"Không tạo được link thanh toán PayOS"*: khoá PayOS trên service `shop` sai/thiếu (log shop có `PayOS <mã lỗi>`). Chọn **Chuyển khoản ngân hàng** để tiếp tục.
- Không có sự kiện nào: PayOS chưa trỏ đúng URL, hoặc hub vừa ngủ dậy và PayOS gọi trượt (PayOS sẽ tự gọi lại).

### 2.2. Cách thay thế không tốn tiền — Playground bắn webhook PayOS đã ký
Dùng khi chỉ cần chứng minh luồng, không cần tiền thật.
1. Ở Shop, tạo đơn như các bước 2.1.1–6 và ghi lại mã đơn + số tiền.
2. Trên console (operator, project `default`) → **Playground**.
3. Ô **Nguồn** → chọn nguồn `payos`.
4. Ô **Checksum key** → `<lấy trong KEYS-CAN-LAY.md mục PayOS>`.
5. Trong ô **Body (gửi nguyên văn)**, sửa `"amount"` thành **đúng số tiền của đơn** và `"description"` thành **mã đơn**. Giữ nguyên `"code": "00"`.
6. Bấm **Gửi webhook**.

**Bạn sẽ thấy:** bên khung **Phản hồi** có huy hiệu **HTTP 200**. Shop chuyển sang **Đã thanh toán!**. Console hiện đúng như mục 2.1.

### 2.3. Đường phụ — SePay
- **Thật:** chuyển khoản vào tài khoản ngân hàng đã liên kết SePay, nội dung là mã đơn `DH…`, số tiền bằng giá đơn. SePay cần cấu hình ở my.sepay.vn → WebHooks, URL `https://hub-api-c9hg.onrender.com/hooks/sepay/src_sepay_main`, kiểu xác thực **API Key** (HUONG-DAN-DEPLOY §9). *Cần tài khoản ngân hàng thật đã liên kết SePay.*
- **Không tốn tiền:** làm như mục 2.2 nhưng chọn nguồn `sepay`, ô **API key** = `<lấy trong KEYS-CAN-LAY.md mục SePay>`, sửa `"transferAmount"` = số tiền và `"content"` = mã đơn, giữ `"transferType": "in"`.
- Kết quả trên console giống hệt PayOS: cùng kiểu `payment.received`, cùng các trường trong `data`. **Đây chính là luận điểm "vào nhiều kiểu, ra một kiểu".**

> Nút **"Giả lập chuyển khoản"** trong cửa sổ thanh toán **chỉ có ở môi trường local**. Trên bản deploy sẽ không thấy nút này, và đó là đúng.

---

## Kịch bản 3 — Thêm nguồn GitHub vào project của chính bạn

**Mục tiêu:** tự gắn một provider mới mà không cần sửa code. Push một commit thì thấy `repo.push` trên console.
**Vì sao quan trọng:** thêm provider chỉ là chuyện cấu hình phía người dùng (luận điểm ProviderAdapter + registry). Hub tính HMAC trên đúng các byte gốc của body.

**Chuẩn bị:** đăng nhập bằng tài khoản thường (ví dụ người dùng B, hoặc tài khoản Google), đang ở project của chính mình. Nghĩ trước một chuỗi secret ngẫu nhiên, ít nhất 8 ký tự.

1. Console → **Nguồn (Sources)** → bấm **Thêm nguồn**.
2. Trong hộp **Thêm nguồn webhook**: ô **Provider** chọn `github` · ô **Tên** điền ví dụ `GitHub repo của tôi` · ô **Secret** dán chuỗi secret của bạn → bấm **Tạo**.
3. Thấy thông báo *"Đã tạo nguồn …"* kèm Webhook URL. Bảng có dòng mới, cột **Trạng thái** là **Đang bật**.
4. Bấm nút sao chép ở cột **Webhook URL (dán vào provider)**. URL có dạng `https://hub-api-c9hg.onrender.com/hooks/github/src_github_…`.
5. Sang GitHub → repo của bạn → **Settings → Webhooks → Add webhook**:
   - **Payload URL**: dán URL vừa chép.
   - **Content type**: **`application/json`**. *Bắt buộc. Nếu để mặc định `application/x-www-form-urlencoded` thì sự kiện sẽ hỏng.*
   - **Secret**: đúng chuỗi đã nhập ở bước 2.
   - Events: **Just the push event**, hoặc chọn thêm Pull requests → **Add webhook**.
6. GitHub gửi ngay một **ping**. Trên console → **Hành trình sự kiện** sẽ thấy một dòng kiểu `github.ping`. Đây là sự kiện "chưa chuẩn hoá", bình thường.
7. Push một commit bất kỳ lên repo (sửa README ngay trên web GitHub cũng được).

**Bạn sẽ thấy:**
- **Hành trình sự kiện** → dòng mới, cột *Type · subject* là `repo.push` · `repo:<tên>/<repo>` → bấm vào để xem **Chi tiết sự kiện**: nhánh, danh sách commit, người push.
- **Dashboard** → thẻ **Sự kiện** tăng lên. Thẻ **10 sự kiện gần nhất** có dòng mới.
- GitHub → Settings → Webhooks → webhook của bạn → tab **Recent Deliveries**: mục mới có Response **200**, body `{"ok":true,"id":"…"}`.
- Chưa có Subscription nào thì sự kiện **không được giao đi đâu**. Đó là bình thường; kịch bản 5 sẽ gắn đích.

**Nếu không thấy:**
- GitHub Recent Deliveries báo **timeout**: hub đang ngủ (GitHub chỉ chờ khoảng 10 giây). Đánh thức hub rồi bấm **Redeliver**.
- Response **401**: secret ở GitHub khác secret ở hub. Dòng đó nằm ở tab **Bị từ chối**.
- Response **404**: URL sai (thiếu ký tự khi dán).

**Nguồn SePay / PayOS do người dùng tự tạo:** dùng cùng hộp **Thêm nguồn**, chọn `sepay` (Secret = API key SePay) hoặc `payos` (Secret = Checksum key). Sau đó dán Webhook URL vào trang quản trị của provider. Thử nhanh không cần provider thật: **Playground** → chọn nguồn vừa tạo → nhập đúng secret → **Gửi webhook**.

---

## Kịch bản 4 — Sửa, tắt, xoá nguồn; webhook sai bị từ chối

**Mục tiêu:** webhook giả hoặc sai chữ ký bị chặn và **thấy được** trên console. Nguồn đã tắt thì không nhận gì nữa.
**Vì sao quan trọng:** chữ ký được so bằng `timingSafeEqual`. Request sai vẫn được lưu lại một mẫu để điều tra, nhưng **không** sinh sự kiện.

> **Không có trên giao diện:** trang Nguồn **không có nút sửa tên, đổi secret, tắt/bật hay xoá**. API có `PATCH /api/v1/sources/:id` (chỉ đổi tên và bật/tắt). **Xoá nguồn không tồn tại, kể cả trong API.** Lý do: xoá nguồn thì mất luôn bằng chứng các request đã nhận.

### 4a. Chữ ký sai (làm được trên giao diện)
1. GitHub → webhook của kịch bản 3 → **Edit** → đổi **Secret** thành một chuỗi khác → **Update webhook**.
2. Push một commit (hoặc ở **Recent Deliveries** bấm **Redeliver**).
3. Cách khác, ngay trên console: **Playground** → chọn nguồn GitHub → **để trống** ô **Secret để ký** (ô ghi *"Để trống = gửi chữ ký sai"*) → **Gửi webhook**.

**Bạn sẽ thấy:** GitHub hoặc Playground nhận **HTTP 401** với nội dung *"Chữ ký webhook không hợp lệ"*. Trên console → **Hành trình sự kiện** → tab **Bị từ chối** có dòng mới. Thẻ **Sự kiện** trên Dashboard **không tăng**. Trên **Bản đồ luồng**, cạnh của nguồn đó loé đỏ.
**Cuối cùng:** đổi secret ở GitHub về đúng giá trị cũ.

### 4b. Tắt nguồn (không có trên giao diện; dùng DevTools)
1. Ở console (đang đăng nhập, đúng project), nhấn **F12 → Console**, dán đoạn sau:
   ```js
   const csrf = decodeURIComponent(document.cookie.split('; ').find(c => c.startsWith('hub_csrf=')).slice(9));
   const pid = (await (await fetch('/api/v1/projects')).json()).map(p => [p.slug, p.id]); console.table(pid);
   ```
2. Lấy `id` của nguồn: xem bảng trả về từ `await (await fetch('/api/v1/sources?projectId=<PID>')).json()`.
3. Tắt nguồn:
   ```js
   await fetch('/api/v1/sources/<SOURCE_ID>?projectId=<PID>', { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrf }, body: JSON.stringify({ isActive: false, reason: 'test tắt nguồn' }) }).then(r => r.status)
   ```
   Kết quả phải là `200`. F5 trang **Nguồn (Sources)** → cột **Trạng thái** chuyển thành **Tắt**.
4. GitHub → **Redeliver** một mục cũ, hoặc push commit.

**Bạn sẽ thấy:** GitHub nhận **HTTP 404** *"Source webhook không hợp lệ hoặc đã tắt"*. **Nhật ký (Audit)** có dòng `source.update` với lý do bạn ghi.
**Lưu ý (khoảng trống UX):** request vào nguồn đã tắt **không hiện ở đâu trên console**, kể cả tab Bị từ chối. Chỉ thấy ở phía provider.
**Cuối cùng:** bật lại bằng cùng lệnh, đổi `isActive: true`.

**Nếu không thấy:** lệnh trả `403`/`401` nghĩa là thiếu `x-csrf-token` hoặc phiên đã hết hạn (F5 rồi chạy lại). Lệnh trả `400 project_required` nghĩa là thiếu `?projectId=`.

---

## Kịch bản 5 — Đích + Subscription: nhận webhook ra, thất bại, retry, replay

**Mục tiêu:** sự kiện được định tuyến theo loại và giao tới một URL bạn xem được. Khi đích hỏng thì retry, rồi vào DLQ, rồi replay.
**Vì sao quan trọng:** delivery được ghi vào DB trước (outbox), gửi sau. Thất bại không làm mất sự kiện. Replay tạo bản ghi mới (generation + 1), không ghi đè lịch sử cũ.

**Chuẩn bị:** mở https://webhook.site (miễn phí) → chép **Your unique URL**. Đó là đích "tốt" để xem request đến. Đích "hỏng": `https://httpbin.org/status/404` (trả 404 → chết ngay, không retry) và `https://httpbin.org/status/500` (trả 500 → retry 10 giây → 1 phút → 5 phút → 30 phút → 2 giờ).

### 5a. Đích tốt
1. Console → **Đích (Destinations)** → **Thêm đích** → **Tên**: `webhook.site` · **Loại**: `webhook` · **Config (JSON)**: `{ "url": "<URL webhook.site>" }` · **Signing secret (tuỳ chọn)**: một chuỗi bất kỳ (để thấy chữ ký) · **Giới hạn tốc độ**: `0` → **Tạo**.
2. **Subscriptions** → **Thêm subscription** → **Tên**: `push → webhook.site` · **Đích**: `webhook.site` · **Loại sự kiện**: `repo.push`. Có thể dùng `repo.*` hay `payment.*`; nhiều loại thì phân tách bằng dấu phẩy · **Template (tuỳ chọn)**: để trống → **Tạo**.
3. Push một commit lên repo của kịch bản 3, hoặc dùng **Playground** → nguồn GitHub → đúng secret → **Gửi webhook**.

**Bạn sẽ thấy:**
- webhook.site có request mới, header gồm `webhook-id`, `webhook-timestamp`, `webhook-signature` (chuẩn Standard Webhooks), body là sự kiện `repo.push` đã chuẩn hoá.
- **Giao hàng (Deliveries)** → `SUCCEEDED`, **Đích** `webhook.site`, **HTTP** 200, cột **ms**.
- **Chi tiết sự kiện** → sơ đồ **Hành trình** có thêm nhánh tới `webhook.site`.

**Lọc theo loại:** dùng Playground bắn một webhook `sepay`/`payos` (loại `payment.received`) → webhook.site **không** nhận gì, vì subscription chỉ nhận `repo.push`.

### 5b. Đích hỏng → DLQ → Replay
1. **Thêm đích** tên `hong-404`, Config `{ "url": "https://httpbin.org/status/404" }` → **Thêm subscription** `repo.push` → `hong-404`.
2. Bắn một `repo.push` như ở 5a.
3. **Giao hàng (Deliveries)** → lọc `DEAD` → thấy dòng **Đích** `hong-404`, **HTTP** 404, cột **Lỗi gần nhất**. 4xx là lỗi cấu hình nên chết ngay, không retry.
4. **DLQ** (trang *Dead Letter Queue*) → thấy dòng đó → bấm nút replay của dòng → hộp **Replay delivery này?** → ô **Lý do (không bắt buộc)** → xác nhận.
5. Hoặc: **Hành trình sự kiện** → mở sự kiện → nút **Replay** → **Replay tất cả đích hỏng (n)**. Có thể replay hàng loạt bằng hộp **Replay hàng loạt** trên trang DLQ (ô **Lý do (bắt buộc)**).

**Bạn sẽ thấy:** thông báo *"Đã replay — delivery mới ở generation 2"*. **Deliveries** có thêm một dòng **Gen** = 2, dòng cũ (Gen 1, DEAD) vẫn còn. **Nhật ký (Audit)** ghi hành động replay.
**Retry:** làm tương tự với `https://httpbin.org/status/500` → **Deliveries** hiện `RETRYING`, cột **Lần thử** tăng dần, cột **Thử lại lúc** đếm ngược.

### 5c. Tắt / xoá
1. **Subscriptions** → dòng `hong-404` → **Tắt** → thấy *"Đã tắt … — sự kiện mới không còn được giao"*. Cột **Trạng thái** chuyển sang **Tắt**.
2. Bấm biểu tượng thùng rác (*Xoá*) → hộp xác nhận → **bị chặn**: *"Không xoá được subscription"*, vì đã có delivery (lịch sử phải được giữ).
3. **Đích (Destinations)** → xoá `hong-404` → **bị chặn** vì còn subscription trỏ vào. Đích mới tạo mà chưa có subscription nào thì xoá được.

**Nếu không thấy:**
- Không có delivery nào: kiểm ô **Loại sự kiện** của subscription (gõ sai `repo.push`), subscription đang **Tắt**, hoặc đang chọn nhầm project.
- Delivery `RETRYING` mãi tới webhook.site: URL webhook.site đã hết hạn (bản miễn phí xoá URL sau một thời gian). Tạo URL mới.
- *"Tạo đích thất bại"*: Config không phải JSON hợp lệ, hoặc URL trỏ vào mạng nội bộ (bị chặn SSRF).

> **Endpoint có challenge** (`/v1/p/:project/endpoints`) chỉ tạo được bằng **API key**, **không có trên giao diện**. Đích tạo trên console thì không cần challenge. Muốn thử thì xem KICH-BAN-TEST-DA-SERVICE.md. Thử nhanh: tạo endpoint trỏ vào webhook.site bằng key ở kịch bản 7 → kết quả `verification: "FAILED"`, vì webhook.site không trả lời được challenge. Endpoint FAILED **không** nhận sự kiện. Trang **Đích** hiện **không có cột trạng thái xác minh**, nên trên console không phân biệt được endpoint nào đã VERIFIED.

---

## Kịch bản 6 — Gửi trùng (GitHub "Redeliver") không sinh sự kiện thứ hai

**Mục tiêu:** provider gửi lại cùng một webhook thì hub trả 200 nhưng **không** tạo sự kiện mới và **không** giao lại.
**Vì sao quan trọng:** đây là idempotency. Postgres là trọng tài (BB-2): khoá chống trùng là `X-GitHub-Delivery`, được ràng buộc unique trong DB.

1. Ghi lại con số trên thẻ **Sự kiện** ở **Dashboard**, và số dòng `SUCCEEDED` tới `webhook.site` ở **Deliveries**.
2. GitHub → Settings → Webhooks → webhook của bạn → **Recent Deliveries** → mở mục `push` gần nhất (đã 200) → bấm **Redeliver** → xác nhận.
3. Làm lại bước 2 thêm một lần nữa.

**Bạn sẽ thấy:**
- GitHub: mục redeliver mới có Response **200**, body **`{"ok":true,"message":"Duplicate delivery skipped"}`**. *Đây là bằng chứng rõ nhất.*
- Console: thẻ **Sự kiện** **không tăng**. **Hành trình sự kiện** không có dòng mới. webhook.site **không** nhận thêm request. **Deliveries** không thêm dòng.

**Cách khác, không cần GitHub:** **Playground** → chọn nguồn → **Gửi webhook** → bấm **Gửi webhook** lần nữa **với đúng body đó** (ô Body ghi *"Gửi lại đúng body này hai lần (cùng id) để thấy idempotency"*). Lần 2 trả HTTP 200 với body có chữ *duplicate* hoặc *Duplicate*. Bấm **Mẫu mới** thì sẽ được một sự kiện mới.

**Khoảng trống UX:** hub có phát tín hiệu "trùng — bỏ qua" theo thời gian thực, nhưng thành phần hiển thị nó (`trace-feed.tsx`) **chưa được gắn vào trang nào**. Vì vậy console không có dòng hay toast nào nói "vừa bỏ qua 1 bản trùng". Hiện chỉ chứng minh được qua phản hồi phía provider/Playground và việc các con số không tăng.

**Nếu không thấy:** redeliver ra một sự kiện mới. Đây sẽ là **lỗi thật**, cần ghi lại thời điểm và delivery id của GitHub. Trước khi kết luận, kiểm lại rằng bạn bấm **Redeliver** chứ không push commit mới.

---

## Kịch bản 7 — API key: tạo, giới hạn quyền (scope), thu hồi → 401

**Mục tiêu:** một service dùng key để gọi hub. Key chỉ làm được đúng những gì scope cho phép. Thu hồi key thì service đó bị 401 ngay, các key khác vẫn chạy.
**Vì sao quan trọng:** mỗi service có một key riêng, thu hồi một key chỉ ngắt đúng service đó.

> **Không có trên giao diện:** console chưa có trang API key. Cách thay thế: DevTools trên console (tạo, xem, thu hồi) + `curl.exe` trong PowerShell (dùng key).

1. Console (project của bạn) → **F12 → Console** → chạy dòng `csrf`/`pid` ở kịch bản 4b để có `csrf` và id project.
2. Tạo key chỉ có quyền đọc:
   ```js
   const k = await (await fetch('/api/v1/projects/<PID>/keys', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrf }, body: JSON.stringify({ serviceName: 'thu-nghiem', scopes: ['read:events'] }) })).json(); k
   ```
   Kết quả có `key` (bắt đầu bằng `hk_test_…`) và `connectionString`. **Key chỉ hiện một lần.** Chép tạm vào Notepad và xoá sau khi test xong.
3. PowerShell:
   ```powershell
   curl.exe -s https://hub-api-c9hg.onrender.com/v1/p/<slug>/me -H "Authorization: Bearer <key>"
   curl.exe -s "https://hub-api-c9hg.onrender.com/v1/p/<slug>/events" -H "Authorization: Bearer <key>"
   curl.exe -s -o NUL -w "%{http_code}" -X POST https://hub-api-c9hg.onrender.com/v1/p/<slug>/events -H "Authorization: Bearer <key>" -H "Content-Type: application/json" -d "{}"
   ```
   → lệnh 1 trả tên project, `serviceName`, `scopes`. Lệnh 2 trả danh sách sự kiện của project (polling). Lệnh 3 trả **403**, vì key không có `publish:events`.
4. Thu hồi key (dùng `k.id` của bước 2):
   ```js
   await fetch('/api/v1/projects/<PID>/keys/' + k.id, { method: 'DELETE', headers: { 'x-csrf-token': csrf } }).then(r => r.status)   // 204
   ```
5. Chạy lại lệnh 1 ở bước 3.

**Bạn sẽ thấy:** sau khi thu hồi, lệnh 1 trả **401**. **Nhật ký (Audit)** có dòng `api_key.revoked`. Thu hồi lần hai vẫn trả 204 (idempotent).
**Thử thêm:** dùng key của project A gọi `/v1/p/<slug-của-project-B>/me` → **404 `not_found`**, giống hệt khi gọi một project không tồn tại. Hub không để lộ project nào có thật.

**Nếu không thấy:** `422 validation_failed` nghĩa là scope gõ sai. Chỉ được dùng `publish:events`, `read:events`, `manage:endpoints`, `manage:sources`. Project `live` cần email đã xác minh thì mới tạo được key.

---

## Kịch bản 8 — Cô lập: người dùng B không thấy dữ liệu project A

**Mục tiêu:** hai tài khoản dùng chung một hub nhưng không nhìn thấy dữ liệu của nhau.
**Vì sao quan trọng:** mọi truy vấn đều đi qua `TenantScopedRepository` cộng RLS (BB-5). Lọt một chỗ là dữ liệu của khách khác bị lộ.

**Chuẩn bị:** trình duyệt 1 đăng nhập **operator** hoặc người dùng A (đã có sự kiện ở kịch bản 2/3). Trình duyệt 2 đăng nhập **người dùng B** (kịch bản 1).

1. Trình duyệt 1 → **Hành trình sự kiện** → mở một sự kiện → chép địa chỉ trang (`…/dashboard/events/<id>`).
2. Trình duyệt 2 (B) → bấm ô **Project** → chỉ thấy project của B, **không** có `default` hay project của A.
3. B → **Nguồn (Sources)**, **Hành trình sự kiện**, **Deliveries**, **Nhật ký (Audit)** → chỉ có dữ liệu của B. Project mới thì các trang này trống.
4. B dán địa chỉ đã chép ở bước 1 vào thanh địa chỉ.
5. B → **Playground** → ô **Nguồn** chỉ liệt kê nguồn của B.

**Bạn sẽ thấy:** ở bước 4 có thông báo *"Không tìm thấy hành trình trong project đang chọn (có thể thuộc project khác…)"*. Không lộ bất kỳ trường nào của sự kiện.

**Mời thành viên (không có trên giao diện, tuỳ chọn):** A (đã xác minh email) chạy trong DevTools:
`await fetch('/api/v1/projects/<PID>/invitations', { method:'POST', headers:{'Content-Type':'application/json','x-csrf-token':csrf}, body: JSON.stringify({ email:'<email B>', role:'viewer' }) }).then(r=>r.json())`
→ B nhận mail → bấm link → trang **LỜI MỜI VÀO PROJECT** → nhận lời mời → ô **Project** của B có thêm project của A, kèm chữ `viewer`. Lời mời phải được nhận bằng **đúng email được mời**.

**Nếu không thấy:** B vẫn thấy được dữ liệu của A. Đây là **lỗi nghiêm trọng**, cần chụp màn hình và ghi lại URL.

---

## Kịch bản 9 (thêm) — Bản đồ luồng realtime và Nhật ký

**Mục tiêu:** nhìn là biết luồng nào đang chạy, luồng nào hỏng. Mọi thao tác quản trị đều để lại dấu vết.

1. Mở **Bản đồ luồng** ở một tab, bên cạnh **Playground** ở tab khác (hoặc chia đôi màn hình).
2. Playground bắn 1 webhook đúng chữ ký, rồi 1 webhook sai chữ ký.
3. Mở **Nhật ký (Audit)**.

**Bạn sẽ thấy:** ở bước 2, chấm xanh chạy từ nguồn → hub → các subscription; request sai làm cạnh của nguồn loé đỏ. Nút **Cửa sổ thời gian** đổi được khoảng thời gian xem. Ở bước 3, bảng có các cột **Thời gian / Người làm / Hành động / Đối tượng / Lý do** gồm các hành động đã làm ở các kịch bản trên: `source.create`, `destination.create`, replay, `api_key.revoked`…

**Nếu không thấy:** sơ đồ đứng yên trong khi Hành trình sự kiện vẫn có dòng mới, nghĩa là socket realtime bị chặn (thử cửa sổ ẩn danh), hoặc `NEXT_PUBLIC_HUB_API_URL` sai (HUONG-DAN-DEPLOY §12).

---

## Kịch bản 10 — Cắm Shop vào project của bạn (cách B, không đụng Render)

**Mục tiêu:** một dev mới tự nối Shop vào project hub của chính mình chỉ bằng giao diện: không sửa env, không redeploy (SPEC-shop-ket-noi-project, ADR-155/157).

**Chuẩn bị (một lần, người deploy):** Render › `shop` có `SHOP_SETTINGS_KEY` và `SHOP_ADMIN_TOKEN` (HUONG-DAN-DEPLOY §8); Render › `hub-api` có `HUB_PUBLIC_URL` (bắt buộc cho nút Kết nối, §12). Biết mã quản trị.

> Không có bước tạo project: mỗi tài khoản đã có sẵn một project từ lúc đăng ký ("<tên>'s project"), console chọn sẵn nó. Tạo thêm project chỉ khi cần tách môi trường, sản phẩm hoặc thành viên (ADR-038).

1. **Đăng ký** tài khoản mới (Kịch bản 1a), đăng nhập. Bộ chọn project ở thanh bên đang là project của bạn.
2. Thanh bên › **Project › API key** → **Tạo API key**: tên `shop`, giữ tick mặc định `manage:endpoints` + `read:events` (tick thêm `manage:sources` nếu muốn Shop liệt kê source để chọn) → **Tạo key**. Hộp **"Chỉ hiện một lần"** hiện `HUB_URL=hubs://…` → copy phần sau dấu `=`.
3. **Nguồn (Sources) › Kết nối provider › payos**: dán Client ID, Api Key, Checksum Key của kênh PayOS → tick "Tôi hiểu URL cũ sẽ bị thay" → **Kết nối**. Thấy ✅ CONNECTED. Ghi lại sourceKey (phần cuối Webhook URL).
4. Mở `https://<web>/shop/settings` → nhập **mã quản trị** → **Mở**.
5. **Bước 1:** dán HUB_URL → **Kiểm tra**. Thấy "✅ Đã nối project … với tư cách service shop". Tick source PayOS vừa tạo (key có `manage:sources`) hoặc gõ sourceKey (key không có `manage:sources`).
6. **Bước 2:** dán CÙNG ba khoá PayOS (chỗ này để Shop **tạo link thanh toán**; hub giữ riêng để **nhận webhook** — ADR-157). Đối chiếu 4 ký tự cuối checksum với source ở console.
7. **Lưu và kết nối** → thấy "✅ Endpoint của Shop đã VERIFIED trong project …".
8. Về `/shop`, mua món **Trà đá thử nghiệm 5.000đ**, chọn PayOS, quét QR, trả.

**Bạn sẽ thấy:** đơn chuyển **Đã thanh toán!**. Console (project của bạn) › Hành trình sự kiện có `payment.received` từ source PayOS mới, delivery tới endpoint `shop` SUCCEEDED. Đăng nhập operator, project `default` **không** có sự kiện này. Tải lại `/shop/settings`: các ô bí mật chỉ hiện "Đang dùng …abcd (đã lưu ở trang này)", không bao giờ hiện giá trị.

**Kiểm thêm:**
- Mã quản trị sai → "Sai mã quản trị"; sai 5 lần trong 1 phút → bị khoá 1 phút.
- Console › API key › **Thu hồi** key `shop` → `/shop/settings` › Kiểm tra lại → "Hub từ chối key (401)" kèm cách sửa.
- Mở lại giỏ sau khi trả: modal hiện form đơn mới (không còn QR cũ). Đổi món khi đơn đang chờ → tự tạo đơn mới. Khung đầu bước thanh toán luôn ghi "Đơn DHxxxxxxx" + nút **Tạo đơn mới**.
- **Lưu thất bại không làm hỏng Shop (ADR-160):** dán HUB_URL của một key đã thu hồi (hoặc tắt `SHOP_PUBLIC_URL` đúng) → **Lưu và kết nối** → thấy "Chưa lưu gì — Shop vẫn chạy bằng cấu hình cũ" + cách sửa. Mua món 5.000đ ngay sau đó → vẫn **Đã thanh toán!** (cấu hình cũ còn chạy).
- **Host lạ bị chặn:** dán `hubs://hk_test_…@evil.example/x` → Kiểm tra → 422 "Host hub … không được phép" kèm cách sửa (`SHOP_ALLOWED_HUB_HOSTS`). Mã quản trị ngắn hơn 24 ký tự → trang báo "Shop chưa bật trang cài đặt".
- **Chuyển project (runbook):** chỉ chuyển khi không còn đơn PENDING/UNDERPAID; sau khi Lưu thành công vào console project CŨ › Endpoints › `shop` → tắt/xoá subscription `payment.received`. Webhook còn tới từ nguồn cũ → log Shop `payment.received từ source KHÔNG tin cậy` kèm `sourceId` + `orderCodes` (đối soát tay).

**Nếu không thấy:**
- `/shop/settings` báo "Shop chưa bật trang cài đặt" → thiếu `SHOP_ADMIN_TOKEN` trên Render › shop.
- Nút Lưu bị khoá, cảnh báo SHOP_SETTINGS_KEY → thiếu biến đó.
- Kết nối PayOS báo `HUB_PUBLIC_URL` → đặt trên Render › hub-api (HUONG-DAN-DEPLOY §12).
- ❌ đăng ký endpoint kèm "Cách sửa" → làm theo dòng đó (thường là Shop chưa có `SHOP_PUBLIC_URL` đúng, hoặc hub đang ngủ: thử lại sau 1 phút).
- Trả tiền xong mà đơn không PAID, delivery 401 ở hub → checksumKey ở Shop và ở source PayOS bên hub là hai kênh khác nhau.

---

## Bảng kết quả (Admin điền)

| # | Kịch bản | Đạt / Không | Ghi chú (thời gian, ảnh chụp, mã lỗi) |
|---|---|---|---|
| 1a | Đăng ký email + xác minh | | |
| 1b | Đăng nhập / đăng xuất / F5 | | |
| 1c | Đăng nhập Google | | |
| 2.0 | PayOS gọi được vào hub (lưu webhook URL) | | |
| 2.1 | Thanh toán PayOS thật → đơn PAID, `payment.received`, delivery `shop` SUCCEEDED | | |
| 2.2 | Playground PayOS → đơn PAID | | |
| 2.3 | SePay (thật hoặc Playground) → cùng hình dạng `payment.received` | | |
| 3 | Nguồn GitHub → `repo.push` trên console | | |
| 4a | Sai chữ ký → 401, tab Bị từ chối | | |
| 4b | Tắt nguồn → 404 (DevTools) | | |
| 5a | Đích + subscription → webhook.site nhận, có chữ ký | | |
| 5b | Đích hỏng → DEAD → DLQ → replay generation 2 | | |
| 5c | Tắt / xoá bị chặn đúng lý do | | |
| 6 | Redeliver → "Duplicate delivery skipped", không thêm sự kiện | | |
| 7 | API key: scope 403, thu hồi → 401 | | |
| 8 | B không thấy dữ liệu của A | | |
| 9 | Bản đồ luồng realtime + Audit | | |
| 10 | Cách B: đăng ký → API key → Kết nối PayOS → Shop Cài đặt → Lưu → trả 5.000đ → PAID trong project mới | | |
