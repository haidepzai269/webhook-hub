# REVIEW-LH3-R2 — lượt 2 sau khi sửa theo REVIEW-LH3

**Người review:** Winston 🏗️ + Murat 🧪, 2026-10-14.
**Phạm vi:** 3 commit mới trên `feat/lh` (`34952d5..HEAD`):
- `7dbdd6c` — migration bỏ VALIDATE (T-4)
- `b317b39` — code và test cho TB-1, T-1, T-2, T-3, T-6, T-7
- `2fe0464` — docs, `[LH:T22]`

## Kết luận: **ĐẠT** — 0 Nặng · 0 Trung bình · 4 Thấp (nợ, không chặn)

TB-1 đã hết. Các mục Thấp của lượt 1 đều được xử lý hoặc ghi nợ có lý do ở §16. Tôi không thấy lỗi mới ở mức TB trở lên.

### Đã chạy

| Lệnh | Kết quả |
|---|---|
| `npx jest apps/hub-api/test/ingest-catchnet.spec.ts --maxWorkers=2` | 27/27 PASS |
| `npx jest apps/hub-api/test/edge-nginx.spec.ts --maxWorkers=2` | 14 PASS, 3 skip (các ca nginx thật, cần `EDGE_NGINX_BIN`, đã skip từ trước), có `[LH:T22]` |
| `npx tsc --noEmit -p apps/hub-api/tsconfig.json` | sạch |
| Tính lại 3 test vector bằng `node -e` (crypto thuần, không dùng hàm của sản phẩm) | cả 5 trường của mỗi ca đều khớp: chuỗi ký, chữ ký, sha256 body, chuỗi ký body, chữ ký body |

---

## Đối chiếu các điểm coordinator hỏi

### TB-1 — đã hết thật

- **nginx không đọc header lưới:** template không có `$http_x_catchnet`, và `[LH:T22]` khoá điều này.
- **Lưới bật thì tắt giới hạn theo IP cho `/hooks/*`:** điều kiện "lưới bật" là có `CATCHNET_FORWARD_SECRET` với ít nhất một giá trị ≥ 32 ký tự trong 2 giá trị đầu. Luật này giống hệt `catchnetSecrets` của hub-api (`slice(0,2)` rồi lọc độ dài), nên nginx và hub-api không thể lệch nhau về chuyện lưới có bật hay không. Khi đó `edge.js` đặt `EDGE_HOOKS_IP_LIMITS=0`:
  - `$edge_hooks_fuse_key` và `$edge_hooks_conn_key` thành chuỗi rỗng. nginx không đếm request có khoá rỗng, cả với `limit_req` lẫn `limit_conn`.
  - `/hooks/*` dùng zone riêng `hooks_path_ip`.
  - `/v1/p/*` giữ zone `hooks_ip` và khoá `$edge_fuse_key` như cũ.
  - `limit_conn` chỉ có ở location `/hooks/*`, nên `/v1/p/*` không bị ảnh hưởng.
- **Còn lớp nào khoá chung IP Cloudflare không?**
  - Ở hub-api: không, khi chữ ký lưới hợp lệ.
  - Chỉ còn trường hợp chữ ký lưới **không** qua: secret lệch khi xoay khoá, Worker có bug, hoặc hạn bị kẹp (xem R2-L2). Lúc đó request qua Worker bị coi là gọi thẳng, nên điểm phạt rơi vào IP Cloudflare. Đây là cách fail-safe có chủ ý, đã ghi trong ADR-217. Cấu hình đúng thì không xảy ra.
  - Body lệch giờ cũng bị coi là gọi thẳng (T-1). Worker thật luôn ký body khớp, nên body lệch chỉ đến từ người gọi thẳng Render bằng IP của chính họ. Điểm phạt rơi đúng vào kẻ đó. Tốt hơn spec H3.
- **Đánh đổi mất chống slowloris theo IP:** chấp nhận được. `EDGE_NGINX` mặc định tắt, đánh đổi đã ghi ở ADR-217 và DEPLOYMENT §3.6, và vẫn còn `client_header_timeout`/`client_body_timeout 10s` cùng cổng phạt. Riêng một phần mất mát chưa được nói rõ trong tài liệu: xem R2-L1.

### Cú pháp template nginx (đọc tay, không có nginx thật)

- **`map "${EDGE_HOOKS_IP_LIMITS}" … { "1" $edge_fuse_key; default ""; }`:** cùng khuôn với `map "${EDGE_IP_FUSE}"` đang chạy. Nguồn map là chuỗi hằng sau envsubst, giá trị là một biến. Hợp lệ. `$edge_fuse_key` được khai báo trước đó.
- **envsubst:** `EDGE_HOOKS_IP_LIMITS` đã có trong `EDGE_ENVSUBST_VARS`. Các `$uri`, `$)` trong regex không nằm trong danh sách nên giữ nguyên.
- **`map $uri $edge_outcome_* { "~*^/hooks(/|$)" refused; default ""; }`:** regex trong map hợp lệ (`~*` = không phân biệt hoa thường).
  - Named location đến qua `error_page` giữ nguyên `$uri` gốc, nên map vẫn khớp.
  - `add_header … $var always` với giá trị rỗng thì không thêm header, nên `/v1/p/*` và `/api/*` không bị gắn.
  - `always` cần thiết cho 429/413/503/404 và đã có.
- **Kế thừa `add_header`:** mỗi named location vốn đã khai `add_header` của riêng nó, và header mới được thêm cùng cấp, nên không mất `Retry-After`/`X-Request-Id`.
- **Phản hồi 429/413 do hub-api trả qua proxy:** không bị `error_page` chặn, vì không có `proxy_intercept_errors`. Header `x-hub-outcome` của hub đi thẳng ra, không bị nhân đôi.
- **404 location `~*^/hooks`:** gắn hằng `rejected`. Đúng.
- **502/504 thành 503:** `unavailable`. Đúng nghĩa "hub vắng".

### Các sửa Thấp có gây lỗi mới không

- **T-1:**
  - `omitCatchnetHeaders` chạy sau `redactHeaders` và giữ lại `x-catchnet-id`.
  - Re-verify ở worker (F6) không đọc `x-catchnet-*`, nên không ảnh hưởng.
  - Controller: body lệch thì `catchnet = null`. Hệ quả là IP kết nối, `via` NULL, `HUB_PUBLIC_URL`, `Date.now()`. Có test riêng.
- **T-2:** quá khứ ≤ hạn và tương lai ≤ 5 phút, hai ngưỡng tách riêng. Có test.
- **T-3:** kẹp hạn ≤ `EVENT_RETENTION_DAYS`. Phần mồ côi và tab Lắng nghe được ghi nợ ở §16, kèm đề xuất cột `committed_at`. Hợp lý. Có một hệ quả vận hành: R2-L2.
- **T-5:** luật xử lý 4xx không có outcome cho LH2 đã ghi ở ADR-221 và §16.
- **T-6:**
  - Giá trị ngắn hơn 32 ký tự bị bỏ và log cảnh báo một lần, thay vì cho app thoát. Chấp nhận được, vì kết quả là lưới tắt (fail-closed) và nginx dùng cùng luật.
  - Cảnh báo chỉ hiện ở request đầu tiên có header lưới, không phải lúc khởi động. Nằm chung với R2-L4.
- **T-7:**
  - Đã có ca header lặp, `received_at` sai khuôn, IP sai, mode viết hoa, target tuyệt đối, chữ ký viết hoa.
  - Đã có ca OPTIONS: OPTIONS không mang outcome (`hub-outcome.ts` bỏ qua OPTIONS), và header không lọt ra route khác.
  - Đã có test vector.
- **ADR-217/221:** viết gọn lại đúng ba mục Vấn đề/Chọn/Đánh đổi, số trong dải 211–229.

### Migration sửa tại chỗ

- Chỉ còn `ADD COLUMN NULL` và `CHECK … NOT VALID`, không còn VALIDATE.
- Ràng buộc vẫn áp cho dòng mới. Dòng cũ đều NULL.
- `lock_timeout 5s`. Chú thích trong file đã sửa đúng (transaction ngầm).
- Sửa tại chỗ là an toàn vì migration chưa lên prod (nhánh chưa merge). Riêng DB nào **đã** chạy bản cũ (hubv/local của dev nếu đã chạy L1) sẽ lệch checksum trong `_prisma_migrations`. Cần reset hoặc `migrate resolve` DB đó trước khi chạy L1.

### Test vector

- Định dạng chuỗi ký khớp đúng code `catchnet.ts`: `${id}.${at}.${ip}.${mode}.${method}.${target}` và `${id}.${hex(sha256(body))}`, chữ ký dạng `v1=<hex thường>`.
- Có ca IPv6 (`2001:db8::1`, chứa `:` nhưng không chứa `.`, nên chuỗi ký không mơ hồ).
- Có ca query giữ percent-encoding thô.
- Có ca `?` đứng một mình.
- Test sản phẩm vừa so với giá trị ghi cứng, vừa chạy `verifyCatchnetHeaders`/`verifyCatchnetBody` trên đúng vector đó.
- Tôi đã tính lại độc lập và mọi giá trị đều khớp.

---

## Thấp (nợ, không chặn)

### R2-L1 — Tắt `limit_conn` cho `/hooks/*` cũng bỏ luôn giới hạn với kẻ gọi **thẳng** Render

- **Chỗ:** `nginx.conf.template:74-81`.
- Khi lưới bật, khoá rỗng áp cho mọi IP chứ không riêng IP Cloudflare. Source cũ vẫn gọi thẳng Render (U-C), nên một IP đơn lẻ giờ có thể giữ tới `worker_connections 1024` kết nối chậm vào `/hooks/*`. Kết nối của cả nginx cạn, `/health` và `/api` cũng chết theo.
- Đánh đổi trong ADR và DEPLOYMENT chỉ viết "mất lớp chống slowloris theo IP", không nói rõ là mất **cho cả đường thẳng**.
- **Đề xuất:** dùng block `geo` với dải IP Cloudflare công bố (cập nhật được), chỉ để khoá rỗng cho IP Cloudflare, IP khác vẫn tính `$binary_remote_addr`. Nếu chưa làm thì ghi rõ câu này vào DEPLOYMENT §3.6.

### R2-L2 — Hạn bị kẹp âm thầm, có thể nhỏ hơn hạn D1 của Worker

- **Chỗ:** `catchnet.ts` `catchnetRetentionMs`; `docs/DEPLOYMENT.md:665-666`.
- Hub giờ dùng `min(CATCHNET_RETENTION_DAYS, EVENT_RETENTION_DAYS)`, nhưng DEPLOYMENT vẫn ghi "PHẢI bằng giá trị của Worker (Worker giữ D1 đúng chừng đó)".
- Ví dụ: `EVENT_RETENTION_DAYS=3`, Worker giữ D1 7 ngày. Bản phát lại có tuổi 3–7 ngày mất chữ ký lưới và bị coi là gọi thẳng từ IP Cloudflare. Stripe trả 401 nên bản phát lại vào `inbox_dead`, và điểm phạt rơi vào IP Cloudflare. Không có log nào báo việc kẹp.
- **Đề xuất:** ghi "Worker phải dùng min(…)" vào DEPLOYMENT và §13, và log cảnh báo một lần khi hạn bị kẹp.

### R2-L3 — Fixture có trường `"secret"` có thể làm gitleaks báo

- **Chỗ:** `libs/crypto/test/fixtures/catchnet-vectors.json:3`.
- Giá trị là chuỗi giả có chữ "NOT-A-REAL-KEY", nhưng không nằm trong allowlist của `.gitleaks.toml`.
- Theo luật dự án, gitleaks phải qua trước khi push. Chạy gate này trước. Nếu nó báo thì thêm regex vào allowlist kèm ghi chú "đã xác minh".

### R2-L4 — Cảnh báo `CATCHNET_FORWARD_SECRET` sai chỉ hiện ở request đầu tiên

- Cảnh báo chạy lười, khi có request mang header lưới đầu tiên, chứ không chạy lúc khởi động.
- Nếu secret của hub-api bị đặt ngắn hơn 32 thì lưới tắt âm thầm cho tới khi có traffic. Còn `edge.js` dùng cùng luật nên cũng tắt nhánh `/hooks` không giới hạn IP, đây là chiều an toàn.
- **Đề xuất:** gọi `catchnetSecrets()` một lần trong `bootstrap` để log ra ngay lúc khởi động.

## Việc trước khi merge

- Không có việc nào chặn merge.
- Trước khi push: chạy gitleaks (R2-L3). Nếu hubv đã chạy bản migration cũ thì reset DB đó.
- R2-L1, R2-L2, R2-L4 ghi nợ vào §16, hoặc sửa luôn vì đều rẻ.
