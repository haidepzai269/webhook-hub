# SPEC EG — Chống quá tải ở cửa vào: nginx trong container + hộp phạt IP trong hub-api + khối "Lưu lượng"

> Phòng party viết ngày 2026-10-12. Spec chỉ mô tả việc cần làm, **chưa có code**. Admin sẽ giao spec cho phiên dev.
> **Trạng thái 2026-10-12:** Admin đã chốt hết (Q5, Q6; Admin trả lời trong phòng của phiên webhook-hub-02, phiên đó chuyển lời). **Admin tạm dừng, chưa giao dev.**
> Tiền tố mã test là `EG:`. Phải thêm namespace `EG` vào `verify/spec-sources.json` **trước** khi viết test đầu tiên, theo dạng khai báo của `KN`.
> Số ADR của spec này **bắt đầu từ ADR-175**:
> - ADR-163..164 đã nằm trên master.
> - ADR-165..173 thuộc alerts CB1–CB7 (nhánh `feat/alerts`).
> - ADR-174 dành cho DS4 của `docs-sync`.
> - ADR-180 dành cho `feat/email-cuckoo`. Spec này dùng ADR-175..179, ADR thứ sáu dùng **ADR-181**.
>
> Vẫn phải grep lại số ADR trước khi ghi.

## ĐÍNH CHÍNH SAU KHI CODE (2026-10-12): **phần này thắng phần thân khi mâu thuẫn**

> Nguồn: góp ý của phiên webhook-hub-02, phiên giữ `feat/edge` (EG2–EG5) và `feat/edge-nginx` (EG1), sau hai lượt review. Admin chốt Q7, Q8 và cho ghi toàn bộ (Q9).
> Agent dev đọc phần thân trước, rồi đọc mục này.

| # | Phần thân ghi | Đính chính | Lý do |
|---|---|---|---|
| D1 | §0: "Không có Cloudflare đứng trước bản deployed" | Render đã bảo vệ **L3/L4** (dồn lưu lượng ở tầng mạng) bằng hạ tầng Cloudflare, tự động, mọi gói ([Render docs](https://render.com/docs/ddos-protection)). Render cũng nói rõ **lạm dụng tầng ứng dụng là việc của người dùng** ([bài viết](https://render.com/articles/how-render-handles-ddos-attacks)). EG lo đúng phần đó: flood L7 hợp lệ vào `*.onrender.com`. | Sai một nửa. Lớp bảo vệ có thật, nhưng không chặn L7. |
| D2 | §2–§3: nginx là lớp chắn | nginx **chung container** nên request vẫn chạm máy mình, ăn chung CPU, RAM và băng thông. nginx là **cửa từ chối rẻ** (C, ở phase header, trước khi đọc body), không phải tường. Muốn request rác *không chạm máy* thì cần Cloudflare riêng đứng trước (P2, D13). | Admin hỏi: "host nginx cùng backend thì vẫn chọc vào backend?" Đúng. |
| D3 | §4.1: hộp phạt kiểm trong `ingest.service` | **Thêm gate trước body parser:** `app.use('/hooks', penaltyGate)` đặt **ngay trước** `configureBodyParsers` (`main.ts`, sau `trust proxy`, helmet, `installErrorHandling`, CORS). Gate chỉ **kiểm** (`checkIp`, `checkPair`). Phần **chấm điểm** (`recordUnknownSource`, `recordBadSignature`, `markGood`) giữ trong ingest. Danh sách route của gate **cấu hình được** (mảng), không viết cứng. Bốn bẫy phải xử lý ở D4. **Một commit riêng**, giao sau khi lượt review hiện tại của `feat/edge` đạt. | Hiện IP đã bị cấm vẫn khiến Node đọc và parse body tới 1MB. |
| D4 | — | Bốn bẫy của gate: **(1)** PenaltyBox là **một instance dùng chung** cho gate và ingest. Tách thành provider, lấy qua `app.get(...)`; hai instance thì trạng thái bị tách đôi. **(2)** Trả 429 khi chưa đọc body thì đặt `Connection: close` (`res.shouldKeepAlive = false`), để không phải nhận nốt body rác. **(3)** sourceKey lấy từ path phải **decode giống param của Nest**. Dùng regex của nginx `^/([a-z0-9-]+)/([A-Za-z0-9_-]{1,64})$` trên path sau `/hooks`. Không khớp thì gate **cho đi** (fail-open), để ingest trả lỗi như cũ. **(4)** Body 429 theo khuôn `docs/ERRORS.md`, có `Retry-After` và `requestId`, **dùng chung hàm dựng lỗi** với ingest. Metric `BLOCKED` và trace phải giữ nguyên (§7), không được câm. | Góp ý a) của 02. |
| D5 | Đề xuất của phòng: chặn theo Content-Length trong Node | **Bỏ.** `raw-body` của body-parser đã từ chối ngay khi `Content-Length` vượt giới hạn, chưa đọc byte nào. Chỉ request chunked mới bị đọc tới đủ giới hạn, và nginx đã lo (`client_max_body_size` + `proxy_request_buffering`). | Thừa. |
| D6 | Gate cho `/v1/p/*` | **Không làm.** 401 của API key nằm ở `ApiKeyGuard`, luật (b) chưa áp cho `/v1/p` (ADR-177), nên gate không có gì để kiểm. Mở rộng chấm điểm sang guard thì để P2. | Góp ý a) của 02. |
| D7 | §4.2 luật (a): ≥20 lần 404 thì **cấm cả IP** | **Lỗ chặn chéo tenant.** Kẻ xấu tạo repo GitHub trỏ webhook vào key không tồn tại, IP của GitHub bị cấm, **mọi tenant** mất webhook GitHub. Sửa theo mô hình của 02 (Admin chốt, Q8): cache **"cặp tốt"** (ip, sourceKey) đã verify thành công, giữ **LRU riêng cho từng sourceKey** (≤ 64 IP) để kẻ xấu không xả cache bằng dải /48 IPv6. `markGood` chỉ chạy **sau khi qua rate limit**. Cặp tốt được **nâng ngưỡng 401 ×10**, không miễn hẳn. §4.2 phải ghi mô hình đe doạ này. Test T17, T18 trên nhánh. | Phòng viết luật (a) mà không nghĩ tới IP dùng chung của provider. |
| D8 | — | Hộp phạt **tự dọn lệnh cấm hết hạn** và có **trần riêng cho số lệnh cấm**. | Không có thì đầy rồi câm vĩnh viễn. |
| D9 | — | **IP private/loopback không chấm điểm** (cloudflared, NAT Docker, nginx khi chưa tin proxy). Bắt buộc có metric `hub_ingest_penalty_skipped_private_total`, để không bị câm mà không ai biết trên production. | Không thì cả hệ thống chung một IP, một lần cấm là sập hết. |
| D10 | §3.1: SIGQUIT nginx và SIGTERM hub-api "đồng thời" | **Tuần tự:** SIGQUIT nginx, đợi drain **tối đa 16s**, rồi mới SIGTERM hub-api. Tổng vẫn trong 22s của con / 25s của supervisor. | Làm đồng thời thì T9 đỏ, vì `shutdown.ts` không drain kết nối của nginx. |
| D11 | §3.2: `set_real_ip_from <dải Render>` + `real_ip_recursive on` | Mặc định `set_real_ip_from 0.0.0.0/0` (+ `::/0`) với **`real_ip_recursive off`**, tương đương `trust proxy 1` (lấy phần tử **cuối** của XFF, do Render nối vào). Đo xong (D12) mới thu hẹp dải. **Từ chối khởi động** khi: `EDGE_NGINX=1` mà `EDGE_TRUSTED_PROXIES` trống; hoặc dải `/0` đi kèm `recursive on`, vì như vậy là tin IP giả ở đầu chuỗi. location `/socket.io/` mà tự đặt `proxy_set_header` thì phải **đặt lại đủ** các header kế thừa (kể cả XFF ghi đè), vì nginx không kế thừa khi location có `proxy_set_header` riêng. | Render **nối thêm** vào XFF chứ không xoá XFF client gửi lên ([phản hồi cộng đồng Render](https://feedback.render.com/features/p/send-the-correct-xforwardedfor)), nên phần tử đầu tiên giả được. |
| D12 | §3.3, Q2: cầu chì IP "bật ngay" | **Công tắc riêng `EDGE_IP_FUSE`, mặc định `0` (tắt)** cho tới khi đo xong IP thật trên Render (Admin chốt, Q7). Cách đo ghi ở §3.2-bis bên dưới. | Chưa đo mà bật thì mọi người chung một IP, hoặc tin IP giả. Cả hai đều là tự đánh sập mình. |
| D13 | — | Phía ghi phải **kiểm định dạng sourceKey**: `POST /api/v1/sources` và các đường tạo source khác từ chối key không khớp `^[A-Za-z0-9_-]{1,64}$`. | Không kiểm thì nginx trả 404 lặng lẽ cho key hợp lệ trong DB. 02 đang sửa. |
| D14 | §6.2: khối "Lưu lượng" trên trang **Source detail** | Repo **không có** trang chi tiết Source. Khối Lưu lượng là **Sheet mở từ trang Nguồn** (ADR-181). | Spec viết theo trí tưởng tượng. |
| D15 | §9 P2 | Thêm: **(a)** Cloudflare riêng đứng trước, cần custom domain. nginx trả 403 cho request thiếu **header bí mật** do Cloudflare gắn (Transform Rule), để khoá đường vòng `*.onrender.com`. Chưa ai kiểm Render có cho tắt subdomain `onrender.com` hay không, nên **không hứa trước**. **(b)** Đưa `/auth/email-check` (ADR-180) qua gate (gợi ý của webhook-hub-5b): hiện endpoint này đếm rate limit sau body parser, nhưng body ≤100KB nên không gấp. **(c)** Kịch bản k6 bắn qua `edge` (:18080) so với bắn thẳng, kèm đo CPU/RAM, để có số liệu thật cho câu "nginx rẻ hơn bao nhiêu". | Hiện chưa có số đo tài nguyên nào, chỉ có test hành vi (T10, T9). |

### §3.2-bis. Đo IP thật trên Render (điều kiện để bật `EDGE_IP_FUSE`)

Dễ, khoảng **20–30 phút**, làm một lần. **Không cần biết dải IP của Render.** Chỉ cần xác nhận **Render nối thêm đúng mấy chặng** vào XFF.

1. Deploy với `EDGE_NGINX=1`, `EDGE_IP_FUSE=0`. Thêm tạm vào log format của nginx: `$remote_addr`, `$realip_remote_addr`, `$http_x_forwarded_for`, `$http_cf_connecting_ip`, `$http_true_client_ip`.
2. Lấy IP thật của máy: `curl -s https://ifconfig.me`.
3. Gửi ba request:
   - `curl https://<hub>.onrender.com/health`
   - `curl -H 'X-Forwarded-For: 1.2.3.4' …`
   - `curl -H 'CF-Connecting-IP: 5.6.7.8' …`
4. Lặp lại từ **mạng thứ hai** (4G điện thoại) để chắc không trùng NAT.
5. **Đạt** khi ở cả hai mạng: `$remote_addr` (sau realip) = IP thật; **không** phải `1.2.3.4`, `5.6.7.8`, IP private, hay IP của Render.
   - Nếu XFF có **hai** chặng do Render và Cloudflare nối vào thì đổi sang tin 2 chặng. Ghi lại.
   - Nếu `CF-Connecting-IP` **không** giả được, tức Render ghi đè nó, thì có thể dùng nó làm `real_ip_header`. **Chỉ dùng khi đã thử giả mà thất bại.**
6. Ghi kết quả (log mẫu đã che IP, kết luận số chặng) vào `DEPLOYMENT.md` §3.6, rồi đặt `EDGE_IP_FUSE=1`.
7. **Canh chừng Render đổi hạ tầng:** thêm metric hoặc cảnh báo khi >90% request trong 5 phút đến từ **một** IP, hoặc khi `skipped_private` tăng. Đó là dấu hiệu đếm sai IP. Khi đó tự tắt cầu chì là chuyện của P2; P1 chỉ cảnh báo.

## 0. Bối cảnh và các quyết định của Admin

**Vấn đề:** ingest nạp source từ Postgres **trước** khi rate limit (`ingest.service.ts:264` rồi mới tới `:276`). Rate limit đặt sau là có lý do: khoá rate limit cần `source.id`. Nhưng hệ quả là request mang `sourceKey` ngẫu nhiên **không bị lớp nào chặn trước khi chạm DB**. Trên Neon, `connection_limit` của từng tiến trình rất nhỏ (`DEPLOYMENT.md:85`, `:159`). Vài nghìn request rác là đủ để webhook thật phải xếp hàng sau.

**Không có Cloudflare đứng trước bản deployed.** cloudflared chỉ dùng cho dev local (`DEPLOYMENT.md:44`). hub-api đứng thẳng sau proxy của Render (`TRUST_PROXY=1`).

**Mục tiêu:** sản phẩm được làm **cho production thật**, không chỉ để nộp đồ án. Vì vậy lớp chống quá tải phải có, dù giáo khảo không soi tới.

| # | Quyết định của Admin |
|---|---|
| Q1 | nginx chạy **chung container với hub-api** trên Render, tức tiến trình con thứ ba của supervisor `docker/hub-all.js`. **Không** đặt nginx trong service Shop: hub-api vẫn có URL `*.onrender.com` công khai nên kẻ tấn công đi vòng được, và cửa vào của hub không được phụ thuộc vào client của nó (BB-1). |
| Q2 | Cầu chì theo IP ở nginx **bật ngay và ghi log** (phương án của Amelia), không chạy chế độ chỉ ghi log. **→ Đã thay bằng Q7 (D12).** |
| Q3 | **Không dùng Lua.** Dùng nginx bản thường. Việc phạt IP dựa trên mã phản hồi (404/401) đặt trong hub-api, lưu trong bộ nhớ, không tốn lệnh Redis nào. |
| Q4 | Người xem được lưu lượng là **tài khoản trên hub đang nắm project**, cộng với người vận hành hub. Chi tiết ở §6.1. |
| Q5 | **EG3: ĐỒNG Ý.** Rate limit theo source chạy **sau** `adapter.verify` (§4.3). |
| Q6 | **§6.1: operator + `owner` của project** xem được lưu lượng theo source. `developer`/`viewer` thì không. |
| Q7 | Cầu chì IP **tắt** (`EDGE_IP_FUSE=0`) cho tới khi đo xong IP thật trên Render (§3.2-bis), đo xong mới bật. |
| Q8 | Luật (a) theo mô hình "cặp tốt" của phiên 02 (D7). |
| Q9 | Ghi toàn bộ góp ý của 02 thành mục Đính chính (D1–D15). |

**Ngoài phạm vi:**
- Chống DDoS ở tầng mạng (L3/L4).
- WAF.
- Danh sách IP cho phép của từng provider (để P2, xem §9).
- Đẩy cảnh báo cho chủ project. Spec CB vẫn chỉ gửi cho người vận hành; spec này chỉ cho **xem** (kéo về), không **đẩy**.

## 1. Thực trạng (đã đối chiếu code)

| Lớp | Hiện có | Chỗ hở |
|---|---|---|
| Body | Parser theo route: `/hooks/*` tối đa 1MB, route khác 100KB (ADR-162) | Node vẫn phải nhận hết body mới cắt được. Client gửi chậm (slowloris) giữ kết nối được rất lâu |
| sourceKey lạ | Trả 404 **sau** khi đã query Postgres | Không có giới hạn nào đứng trước query |
| Rate limit theo source | `rate:source:{id}`, 100/phút, fail-open (ADR-090) | Tính **cả request sai chữ ký**. Kẻ chỉ cần biết một `sourceKey` thật là tiêu hết hạn mức của source đó, rồi PayOS thật nhận 429 (§4.3) |
| Chữ ký sai | 401. Chỉ lưu **mẫu** `REJECTED` (≤20/phút/source) | Số lượng thật không được lưu ở đâu |
| Hiển thị cho console | `trace.ingested` theo tenant (`ingest.service.ts:113`): ACCEPTED, DUPLICATE, REJECTED, RATE_LIMITED | **Chỉ phát realtime, không lưu.** `RATE_LIMITED` không để lại dấu vết nào trong DB |
| Tiến trình deployed | `hub-all.js` là supervisor của hub-api và hub-worker. SIGTERM được chuyển cho cả hai, tổng thời gian chờ 25s (con được 22s) | Chưa có nginx |

**Các dạng `sourceKey` đang tồn tại:** `src_payos_bookstore`, `src_sepay_cafe` (seed), `api_<keyId>` (`api-key-create.ts:24`), và key do console sinh ra. Cột trong DB là `VarChar(64)`. Vì vậy kiểm định dạng ở nginx chỉ **lọc rất thô** (§3.4) và **không được** coi là lớp bảo vệ chính.

## 2. Kiến trúc mới

```
Provider ──► Render proxy ──► [ container hub-all ]
                                 nginx :$PORT  ── cầu chì IP, giới hạn kết nối, timeout, cắt body, đệm body
                                   │  (127.0.0.1:4000, X-Forwarded-For được GHI ĐÈ bằng IP thật)
                                   ▼
                                 hub-api  ── hộp phạt IP (bộ nhớ) ─► nạp source (Postgres) ─► rate limit ─► verify ...
                                 hub-worker
```

**Thứ tự hai lớp:**
- **nginx** làm những việc **rẻ, không cần trạng thái, không cần hiểu ngữ cảnh**.
- **hub-api** làm việc **cần ngữ cảnh**: biết request vừa rồi là 404 hay 401, biết nó thuộc tenant nào.

Mỗi lớp được phép sai theo hướng **cho request đi qua (fail-open)**. Không lớp nào được phép **chặn oan một cách lặng lẽ**: mọi lần chặn đều phải có log có cấu trúc, và có metric nếu làm được.

## 3. Lớp nginx

### 3.1. Đóng gói và tiến trình (EG1)

- Cài `nginx` (gói Debian) vào image `node:22-slim`. Cấu hình đặt ở `docker/nginx/nginx.conf.template`, dùng `envsubst` để chèn `$PORT`. Đây là **file cấu hình duy nhất**: local và deployed dùng chung.
- Khi `EDGE_NGINX=1`:
  - `docker/hub-all.js` khởi động thêm tiến trình con `nginx -g 'daemon off;'`.
  - hub-api nghe tại `127.0.0.1:4000`. Cần thêm biến `HOST` vào `main.ts:79`, hiện đang nghe trên mọi interface.
  - nginx nghe tại `$PORT`.

  Khi `EDGE_NGINX` không bật, mọi thứ chạy như hôm nay. Nhờ vậy rollback chỉ cần đổi một biến môi trường.
- **Tắt máy (BB-3):**
  - Supervisor gửi **`SIGQUIT`** cho nginx. Với nginx, `SIGTERM` là tắt **nhanh**, cắt ngang request đang chạy.
  - Đồng thời gửi `SIGTERM` cho hub-api và hub-worker.
  - nginx ngừng nhận request mới, nhưng vẫn giữ các request đang proxy cho tới khi hub-api trả lời xong. Cả ba phải nằm trong ngân sách 25s hiện có (con 22s, mốc SIGKILL 25s).
  - Test `[EG:T9]`.
- **Một tiến trình con thoát ngoài ý muốn**, nginx cũng tính, thì xử lý như hôm nay: dừng cả nhóm, thoát với mã ≠ 0, để Render khởi động lại.
- **Health check của Render** đi qua nginx. Đường `/health` không áp cầu chì.
- **Local:** `docker-compose.yml` thêm service `edge`, dùng cùng file template, đứng trước `hub-api`.
  - Cổng gọi trực tiếp hub-api **vẫn giữ** để chạy k6 đúng quy tắc "bắn vào localhost".
  - Báo cáo số đo phải ghi rõ đã bắn qua `edge` hay bắn thẳng.

### 3.2. IP thật (EG1) — **sai chỗ này là tự đánh sập mình**

- Chuỗi đi qua là: client → proxy Render → nginx → hub-api. nginx dùng `real_ip_header X-Forwarded-For` và `real_ip_recursive on`. `set_real_ip_from` là dải IP proxy của Render. **Dev phải đo thật trên bản deployed**: dùng cách thử của `DEPLOYMENT.md:458` (gửi `x-forwarded-for` giả) và xác nhận `$remote_addr` trong log là IP thật, không phải IP Render, cũng không phải IP giả.
- nginx **ghi đè** header khi chuyển lên hub-api:
  - `proxy_set_header X-Forwarded-For $remote_addr;` (không nối thêm vào chuỗi cũ),
  - `X-Real-IP $remote_addr`.

  hub-api giữ `trust proxy 1`, nên chỉ tin đúng một chặng là nginx. Kết quả: `req.ip` của hub-api **trùng** với IP mà nginx dùng để đếm.
- **Nếu dải IP của Render không xác định được** thì cầu chì IP (§3.3) **không được bật**. Khi đó chỉ chạy các phần của §3.4, và ghi ADR nói rõ lý do. Bật cầu chì khi mọi request trông như đến từ cùng một IP = chặn tất cả mọi người.

### 3.3. Cầu chì theo IP (Q2): bật ngay, ghi log

- **Chỉ áp cho `/hooks/*` và `/v1/p/*`.** Tuyệt đối **không** áp cho `/api/*` và `/socket.io/*`:
  - console đi qua proxy của Vercel (`DEPLOYMENT.md:454`), nên ở nginx mọi người dùng console đều mang IP của Vercel;
  - route đăng nhập đã có giới hạn riêng theo IP + email trong app.
- Cấu hình:
  - `limit_req_zone $binary_remote_addr zone=hooks_ip:10m rate=${EDGE_IP_RATE}r/s;`
  - `limit_req zone=hooks_ip burst=${EDGE_IP_BURST} nodelay;`
  - Mặc định: **50 r/s, burst 500**.
- **Trần này phải đủ cho TỔNG lưu lượng của một provider trên mọi tenant.** GitHub và PayOS gửi webhook của mọi project từ cùng một số dải IP. Hub có nhiều tenant thì lưu lượng cộng dồn trên cùng IP. Ghi rõ điều này trong ADR. Có thể chỉnh trần mà không cần build lại, qua biến môi trường.
- Khi bị chặn:
  - Trả `429` kèm `Retry-After: 1`.
  - Body JSON tĩnh theo khuôn ERRORS.md: `{"error":"edge_rate_limited","message":"…","fix":"…","docsUrl":"…","requestId":"$request_id"}`.
  - `limit_req_status 429; limit_req_log_level warn;`
- **Ghi log có cấu trúc:** dùng `log_format json` gồm `ts, ip, method, uri_path (không có query), status, limit_req_status, request_id, bytes, rt`. Ghi ra stdout. Supervisor đã chuyển tiếp stdout lên log của Render.
- **Đánh đổi đã chấp nhận** (ghi vào ADR):
  - Chặn oan provider đồng nghĩa với mất sự kiện, vì GitHub không tự gửi lại.
  - Trần cao + log được chọn thay cho chế độ chỉ ghi log.
  - Nhìn thấy được ở mức log. Metric riêng cho các lần nginx chặn **chưa có** khi không dùng Lua (§9).

### 3.4. Các lớp rẻ khác, không cần trạng thái

| Việc | Cấu hình | Lý do |
|---|---|---|
| Cắt body | `client_max_body_size 1m` cho `/hooks/*`, `100k` cho route khác | Giống ADR-162. Node vẫn giữ giới hạn của nó (phòng thủ nhiều lớp, và vẫn đúng khi gọi thẳng ở local) |
| Slowloris | `client_header_timeout 10s; client_body_timeout 10s; send_timeout 10s; keepalive_timeout 15s;` | Node không còn phải giữ kết nối nhả từng byte |
| Đệm body | `proxy_request_buffering on` (mặc định) cho `/hooks/*` | nginx nhận **đủ** body rồi mới chuyển lên Node một lần |
| Giới hạn kết nối | `limit_conn hooks_conn ${EDGE_CONN_PER_IP}` (mặc định 50) cho `/hooks/*` | Một IP không chiếm hết worker connection |
| Định dạng `sourceKey` | `location ~ ^/hooks/[a-z0-9-]+/[A-Za-z0-9_-]{1,64}$`. Không khớp thì `404` JSON tĩnh | Lọc thô: path traversal, key quá dài, ký tự lạ. **Regex phải chấp nhận mọi `sourceKey` đang có trong DB**: dev chạy một query đếm số key không khớp regex, kết quả phải bằng 0, rồi ghi lại trong PR. Test `[EG:T3]` |
| Không sửa body | Không bật `gzip` hay `sub_filter` cho request. Không đổi `Content-Type` | **HMAC được tính trên đúng bytes gốc.** Test e2e đi qua nginx `[EG:T2]` |
| `x-request-id` | `proxy_set_header X-Request-Id $request_id` **chỉ khi** client không gửi lên. hub-api giữ nguyên id hợp lệ có sẵn (kiểm `errors/request-id.ts`) | Log của nginx và log của hub nối được với nhau |
| WebSocket | `/socket.io/`: `proxy_http_version 1.1`, `Upgrade`/`Connection`, `proxy_read_timeout 1h` | Realtime của console không bị đứt |
| Timeout lên hub-api | `/hooks/*`: `proxy_read_timeout 30s` | Ingest phải trả lời nhanh. Hết 30s là có chuyện bất thường |

## 4. Hộp phạt IP trong hub-api (EG2)

### 4.1. Vị trí và chi phí

- Thêm module `apps/hub-api/src/modules/ingest/penalty-box.ts` (hàm thuần + lớp lưu trạng thái trong bộ nhớ).
- Hộp phạt được kiểm **đầu tiên** trong `receiveWebhook`, **trước** `findSourceBySourceKeyForIngest`.
- **0 lệnh Redis, 0 truy vấn DB.** `redis-budget.spec.ts` **không đổi**.
- Mỗi instance hub-api có trạng thái riêng. Ngưỡng thực tế nhân lên theo số instance. Chấp nhận điều này, ghi vào ADR.
- Áp cho `/hooks/*`. Riêng `publishFromService` (`/v1/p/*`) đã có API key, nên chỉ áp phần §4.2-b (401 theo cặp IP + key), nếu có.

### 4.2. Luật chấm điểm

Áp cho IPv4 theo địa chỉ. IPv6 gộp theo prefix **/64**, vì một máy có cả dải /64.

| Sự kiện | Khoá | Ngưỡng (mặc định) | Phạt |
|---|---|---|---|
| **a.** 404 do **không tìm thấy source** (`source == null`) | `ip` | ≥ 20 trong 60s | Chặn **mọi `/hooks/*`** từ IP đó trong 10 phút |
| **b.** 401 do sai chữ ký | `(ip, sourceKey)` | ≥ 30 trong 60s | Chặn **chỉ cặp đó** trong 10 phút |
| 404 do source **tắt hoặc đã lưu trữ** | — | **Không tính điểm** | — |
| 2xx, trùng, 429 | — | Không tính điểm | — |

> **Đính chính sau review (2026-10-12, ADR-177 bổ sung):** IP hook của GitHub/PayOS là IP CHUNG của mọi tenant — kẻ xấu tự kích 404 (luật a) hoặc đặt secret sai vào key của nạn nhân (luật b) từ chính IP đó. Vì vậy: cặp (IP, sourceKey) đã verify đúng trong `EDGE_PENALTY_GOOD_TTL` (24h) **không bị luật (a) chặn**; với luật (b) cặp tốt dùng ngưỡng ×10 (lượt 2: không miễn vô hạn). Cache tốt chia theo sourceKey (≤ 64 IP mỗi key), chỉ ghi khi đã qua rate limit. IP loopback/private không chấm điểm; `EDGE_PENALTY_ENABLED=0` tắt hẳn. Ban có trần riêng (≤ 50% `MAX_ENTRIES`), ban hết hạn được quét; đầy thì không phạt thêm (log + metric). Test `[EG:T17]`, `[EG:T18]`.

**Vì sao luật được thiết kế như vậy:**

- **404 vì source đã lưu trữ thì không tính điểm.** Provider thật vẫn tiếp tục gửi vào source đã bị "Xoá" (ADR-161). Đếm 404 kiểu đó sẽ khoá **IP của GitHub**, và mọi tenant dùng GitHub mất webhook.
- **401 phạt theo cặp, không phạt cả IP.** Khi một tenant cấu hình sai secret GitHub, IP của GitHub sẽ ra 401 hàng loạt. Phạt cả IP thì **tenant khác dùng chung GitHub cũng bị chặn**. Phạt theo cặp chỉ ảnh hưởng đúng source đang cấu hình sai, mà source đó đằng nào cũng đang hỏng.
- Khi bị phạt:
  - Trả `429`, `error: "ip_temporarily_blocked"`, kèm `Retry-After` (số giây phạt còn lại), theo khuôn ERRORS.md.
  - Ghi log `warn` một lần **khi bắt đầu phạt**, không ghi lại mỗi request.
- **Bộ nhớ có trần:**
  - Tối đa `EDGE_PENALTY_MAX_ENTRIES` khoá (mặc định 50.000), loại bỏ theo LRU.
  - Ưu tiên giữ các khoá **đang bị phạt** hơn các khoá chỉ đang được đếm.
  - Kẻ tấn công dùng nhiều IP chỉ làm hộp phạt đầy, **không làm cạn RAM**.
- **Lỗi trong hộp phạt thì cho đi qua (fail-open).** Mọi lỗi trong `check`/`record` đều bị nuốt, ghi log, và request chạy tiếp như chưa có hộp phạt.
- **Tham số qua biến môi trường:** `EDGE_PENALTY_404_THRESHOLD`, `EDGE_PENALTY_401_THRESHOLD`, `EDGE_PENALTY_BAN_SECONDS`, `EDGE_PENALTY_MAX_ENTRIES`. Giá trị phải được kẹp trong khoảng hợp lý, giống cách `resolveSendTimeoutMs` đang làm.
- **Metric:**
  - `hub_ingest_penalty_bans_total{reason="unknown_source|bad_signature"}`
  - `hub_ingest_penalty_blocked_total{reason}`
  - `hub_ingest_penalty_entries` (gauge)
  - `hub_ingest_unknown_source_total`

### 4.3. Đổi thứ tự: rate limit theo source chạy **sau** verify (EG3). **Admin đã đồng ý (Q5).**

**Vấn đề (Mary phát hiện):** rate limit theo source (`:276`) chạy **trước** bước verify. Request sai chữ ký vẫn **tiêu hạn mức** của source. Kẻ biết một `sourceKey` thật (lộ qua log, qua ảnh chụp màn hình) chỉ cần bắn 100 request sai chữ ký mỗi phút là **khoá được webhook thật** của nạn nhân. Hộp phạt §4.2-b chỉ ra tay sau 30 lần, nên vẫn còn lọt khoảng 30 lần mỗi phút.

**Đề xuất:** chuyển `checkRateLimit` xuống **sau** `adapter.verify`. Chỉ request có chữ ký hợp lệ mới tiêu hạn mức.
- Chi phí thêm cho mỗi request sai chữ ký: một lần HMAC, chỉ vài micro giây. Bước nạp source vốn đã chạy rồi.
- Số lệnh Redis của một sự kiện hợp lệ **không đổi**. Request sai chữ ký giờ **ít hơn** một lệnh.
- Rate limit theo source vẫn chặn được hai trường hợp nó cần chặn: provider gửi lại dồn dập, và secret bị lộ.

**Đánh đổi:** tốn thêm HMAC cho request sai chữ ký (có trần 1MB/body), đổi lại source không bị khoá oan. `ARCHITECTURE.md` §3.1 phải sửa thứ tự cho khớp. - DS1 (docs-sync, nhánh `docs/ds-sync`, commit `df21a5a`) ghi **thứ tự hiện tại**: nạp source → rate limit → verify.
- EG3 khi code phải sửa lại `ARCHITECTURE.md` §3.1 **trong cùng PR**, thành nạp source → (hộp phạt) → verify → rate limit, kèm câu lý do: request sai chữ ký không tiêu hạn mức của source.
- Spec QT §4 ghi thứ tự "kiểm khoá dung lượng trước rate limit và verify". Theo EG3, thứ tự đầy đủ là nạp source (kèm trạng thái khoá) → khoá dung lượng → hộp phạt → verify → rate limit.

## 5. Lưu lượng theo source: dữ liệu (EG4)

### 5.1. Bảng `hub.source_traffic_minutely`

| Cột | Kiểu | Ghi chú |
|---|---|---|
| `tenant_id` | uuid | RLS + `TenantScopedRepository` (BB-5) |
| `source_id` | uuid | |
| `minute` | timestamptz | Làm tròn xuống đầu phút |
| `outcome` | enum `ACCEPTED, DUPLICATE, REJECTED, RATE_LIMITED, BLOCKED` | `BLOCKED` = bị hộp phạt chặn theo cặp (§4.2-b). Lúc tạo khoá phạt đã biết `source`, nên lưu kèm `tenantId`/`sourceId` vào khoá |
| `count` | int | |
| `top_ips` | jsonb | Tối đa 5 phần tử `{ip, count}` của phút đó. IPv6 ghi dạng prefix /64 |

- PK là `(tenant_id, source_id, minute, outcome)`.
- **404 do `sourceKey` lạ KHÔNG nằm trong bảng này**, vì không thuộc tenant nào. Phần này chỉ có ở metric và log (§6.2). Cũng **không** tạo bảng nào không có `tenant_id` (BB-5).

### 5.2. Ghi dữ liệu: gộp trong bộ nhớ, đẩy xuống DB mỗi 60s

- **Đường nóng không có thêm truy vấn DB nào.** `traced()` (`ingest.service.ts:111`, chỗ đã có `trace.tenantId` và `trace.outcome`) chỉ cộng vào một `Map` trong bộ nhớ.
- Cứ 60s (`TRAFFIC_FLUSH_MS`), dữ liệu được nhóm theo tenant rồi upsert theo lô qua `TenantScopedRepository`: `ON CONFLICT (pk) DO UPDATE SET count = count + excluded.count, top_ips = <gộp và lấy 5 IP lớn nhất>`. Nhiều instance cùng ghi vẫn cộng đúng.
- **Đẩy dữ liệu bị lỗi** (DB chậm):
  - giữ lại bộ đệm cho lượt sau, với trần 10 phút dữ liệu;
  - vượt trần thì bỏ phần cũ nhất, tăng metric `hub_traffic_flush_dropped_total`.

  Đây là số liệu quan sát, không phải idempotency: được phép thiếu, không được phép làm chậm ingest.
- Khi tắt máy: đẩy một lần cuối, best-effort, nằm trong ngân sách 22s của tiến trình con.
- **Lưu giữ 7 ngày.** Thêm việc xoá dữ liệu cũ vào `cleanup.job.ts`, dùng chung `DEFAULT_RETENTION_DAYS` hoặc một biến riêng `TRAFFIC_RETENTION_DAYS`.

### 5.3. Liên hệ với spec CB (cảnh báo)

- Luật `source.signature_failing` của CB hiện đếm dựa trên mẫu `REJECTED` trong `raw_events`, mà mẫu này có trần 20/phút nên **đếm thiếu**. Khi EG4 xong, evaluator nên đọc `source_traffic_minutely` để có số thật. Đây là yêu cầu thay đổi gửi sang CB, ghi ở §10.
- **Đề xuất luật mới cho CB:** `source.rate_limited`, mức warning, bật khi có ≥ 1 phút `RATE_LIMITED` trong 15 phút gần nhất. Người nhận vẫn **chỉ là người vận hành** theo §0 của CB.

## 6. Giao diện và quyền xem (EG5)

### 6.1. Ai xem được gì (Q4)

Admin nói: "chủ project không xem được mà chủ hub xem được, tức tài khoản đăng ký vào hub, nắm giữ các project". **Admin đã chốt (Q6):** bảng dưới là đúng.

| Vai trong hub | Xem khối Lưu lượng của project | Xem lớp biên toàn hub (§6.2) |
|---|---|---|
| Người vận hành (`users.is_operator`) | ✅ mọi project | ✅ |
| Tài khoản **nắm project** (`MemberRole = owner`, tức người tạo project, `projects.controller.ts:144`) | ✅ các project mình nắm | ❌ |
| `developer`, `viewer` của project | ❌ | ❌ |
| Hệ thống bên ngoài dùng hub (Shop, cafe, bookstore…) | ❌ (không đăng nhập console) | ❌ |


Quyền xem dùng scope mới `traffic:read`, thêm vào `ROLE_SCOPES` cho `owner`. Người vận hành đi qua `viaOperator`. Không viết lệnh `if` theo vai trò rải trong controller.

### 6.2. Màn hình

- **Khối "Lưu lượng" ở trang chi tiết Source**, đặt cạnh nhật ký. **Không** tạo trang mới (Sally).
  - Biểu đồ cột xếp chồng request/phút theo `outcome`. Phạm vi 1h, 24h hoặc 7 ngày. 24h và 7 ngày thì gộp theo 5 phút hoặc 1 giờ khi truy vấn.
  - **Một câu nhận định** ở đầu khối, sinh từ `code` + `facts` theo khuôn `I-*` của spec CB: "1 giờ qua: 1.240 request · 31% sai chữ ký · phần lớn từ 1 IP (203.0.113.7)".
  - Bảng "IP gửi nhiều nhất" (gộp `top_ips`) gồm các cột: IP · số request · tỷ lệ sai chữ ký · lần cuối.
  - Có `BLOCKED` thì hiện thêm dòng "Hub đang tạm chặn 1 IP gửi sai chữ ký vào source này (còn 7 phút)". Dữ liệu này lấy từ hộp phạt của instance đang trả lời, nên **ghi rõ là ước lượng** khi chạy nhiều instance.
- **Lớp biên toàn hub (chỉ người vận hành):** trong P1 chỉ có **panel Grafana** gồm `hub_ingest_unknown_source_total`, bans/blocked theo `reason`, và `penalty_entries`. Màn hình trong console để P2, vì nếu làm cần dữ liệu không thuộc tenant.
- **Hai ngôn ngữ vi/en.** Màu chuẩn AA ở cả hai theme. Không có dữ liệu thì hiện trạng thái trống thân thiện: "Chưa có request nào trong 1 giờ qua".

### 6.3. API

- `GET /api/v1/projects/:p/sources/:id/traffic?range=1h|24h|7d`.
  - Trả về `{ buckets: [{t, ACCEPTED, DUPLICATE, REJECTED, RATE_LIMITED, BLOCKED}], topIps: [...], insight: {code, facts}, blockedNow: [...] }`.
  - Yêu cầu scope `traffic:read`. Lỗi theo khuôn chuẩn.
  - Truy vấn đi qua `TenantScopedRepository`, nằm trong một chỉ mục `(tenant_id, source_id, minute)`.

## 7. Bất biến (reviewer đối chiếu)

- [ ] **BB-2:** hộp phạt, cầu chì nginx và bảng lưu lượng **không** tham gia quyết định trùng hay không trùng.
- [ ] **BB-3:** nginx không trả 2xx thay cho hub. Tắt máy dùng `SIGQUIT`, không cắt ngang request đang ở giữa COMMIT (`[EG:T9]`).
- [ ] **BB-4:** nginx là tiến trình thứ ba. hub-api và hub-worker vẫn là hai tiến trình riêng.
- [ ] **BB-5:** `source_traffic_minutely` có `tenant_id` + RLS. Không tạo bảng toàn hub nào không có `tenant_id`.
- [ ] **R1 / `redis-budget.spec.ts` không đổi.** Nếu làm EG3 thì request sai chữ ký **bớt** một lệnh, sự kiện hợp lệ không đổi.
- [ ] **Không có `if (provider === …)`** trong nginx lẫn trong hộp phạt. Regex `sourceKey` dùng chung cho mọi provider.
- [ ] **Không chặn oan một cách lặng lẽ:** mọi lần chặn đều có log có cấu trúc. Lần chặn ở hub-api có thêm metric.
- [ ] **`EDGE_NGINX=0` quay về đúng hành vi hôm nay.**

## 8. Test

| Mã | Mức | Nội dung |
|---|---|---|
| `[EG:T1]` | L0 | Hộp phạt: 20 lần 404 do `source==null` từ một IP thì request thứ 21 nhận 429 `ip_temporarily_blocked` + `Retry-After`, và **không** gọi `findSourceBySourceKeyForIngest` (dùng spy) |
| `[EG:T2]` | L2 | Webhook GitHub + PayOS ký thật **đi qua nginx** thì verify đúng (bytes không bị đổi). Body 1MB + 1 byte thì nginx trả 413 |
| `[EG:T3]` | L1 | Mọi `sourceKey` do seed sinh ra, do `api-key-create` sinh ra (`api_<id>`), và do bộ sinh key của console, đều khớp regex của nginx. Test đọc regex từ `nginx.conf.template`, không chép lại |
| `[EG:T4]` | L0 | 404 do source **lưu trữ hoặc tắt** không tính điểm: 100 lần vẫn không bị phạt |
| `[EG:T5]` | L0 | 401 phạt **theo cặp**: IP X bị phạt trên source A, nhưng vẫn gửi vào source B bình thường (giả lập tình huống một tenant cấu hình sai secret GitHub) |
| `[EG:T6]` | L0 | IPv6 trong cùng một /64 bị tính là một khoá. Trần `MAX_ENTRIES` được tôn trọng, khoá đang bị phạt không bị loại trước |
| `[EG:T7]` | L0 | Hộp phạt ném lỗi thì request vẫn chạy bình thường (fail-open) |
| `[EG:T8]` | L1 | `redis-budget.spec.ts` không đổi. Có EG3 thì thêm ca: request sai chữ ký **không** gọi `checkRateLimit` |
| `[EG:T9]` | L1 | Supervisor: SIGTERM thì nginx nhận SIGQUIT. Request đang chạy dài 3s vẫn nhận được phản hồi. Cả nhóm thoát trước 25s |
| `[EG:T10]` | L2 | Cầu chì: vượt `EDGE_IP_RATE`/`BURST` trên `/hooks/*` thì 429 `edge_rate_limited` và log JSON có `limit_req_status=REJECTED`. Cùng tải đó trên `/api/*` thì **không** bị chặn |
| `[EG:T11]` | L2 | IP thật: gửi `X-Forwarded-For: 6.6.6.6` giả thì `req.ip` của hub-api **không phải** 6.6.6.6 |
| `[EG:T12]` | L1 | EG3: 100 request sai chữ ký vào source A, sau đó request PayOS hợp lệ vẫn nhận 200, không phải 429 |
| `[EG:T13]` | L1 | Đẩy dữ liệu lưu lượng: hai instance cùng upsert một `(tenant, source, minute, outcome)` thì `count` là tổng của hai. DB lỗi thì bộ đệm được giữ có trần, ingest không chậm đi |
| `[EG:T14]` | L1 | API traffic: `developer`/`viewer` nhận 403, `owner` nhận 200, tenant khác nhận 404 (RLS). 404 do `sourceKey` lạ không xuất hiện trong dữ liệu của tenant nào |
| `[EG:T15]` | L0 | Hàm nhận định: trả `code` + `facts` đúng ngưỡng. Không có dữ liệu thì trả trạng thái trống |
| `[EG:T16]` | L1 | `EDGE_NGINX=0` thì hub-api nghe như cũ, không có tiến trình nginx, mọi test ingest hiện có vẫn xanh |
| `[EG:T17]` | L0 | *Đính chính sau review (2026-10-12):* luật (a) không chặn cặp (IP, sourceKey) đã verify đúng gần đây của một IP đang bị phạt; key lạ từ IP đó vẫn bị 429 trước DB |
| `[EG:T18]` | L0 | *Đính chính sau review (2026-10-12, lượt 2):* luật (b) với cặp tốt dùng ngưỡng × `EDGE_PENALTY_401_GOOD_MULTIPLIER` (10) — sai/đúng xen kẽ không bị ban oan, flood 401 vô hạn trên cặp tốt cuối cùng vẫn bị ban; cặp chưa từng verify đúng bị ban ở ngưỡng thường |

## 9. P2 (ghi lại, chưa làm)

- **Danh sách IP cho phép của provider:** dải hook IP của GitHub lấy từ `/meta`, PayOS phải hỏi họ. Danh sách này được miễn cầu chì §3.3. Phải có cơ chế tự đồng bộ, nếu không danh sách cũ sẽ chặn oan.
- **Metric cho các lần nginx chặn:** parse log JSON bằng vector hoặc mtail, hoặc để supervisor đếm dòng `limit_req_status=REJECTED` từ stdout của nginx (supervisor đã đọc stdout sẵn).
- **Màn hình "Lớp biên" trong console cho người vận hành.** Cần quyết dữ liệu không thuộc tenant lưu ở đâu, kiểu `IdentityRepository` như `alert_preferences` của CB.
- **Lua (OpenResty):** chỉ cân nhắc lại khi có **số đo** cho thấy request bị phạt vẫn làm Node quá tải. Luật của Winston khi đó: Lua không giữ nguồn sự thật nào, lỗi thì cho request đi qua, bộ đếm riêng từng instance, không gọi Redis.
- **Cắt tải khi pool DB bão hoà:** trả `503 + Retry-After` sớm thay vì để request chờ tới timeout.

## 10. Story và thứ tự

| Story | Nội dung | Mã test |
|---|---|---|
| **EG1** | nginx trong `hub-all` + service `edge` ở compose, IP thật, cầu chì, các lớp ở §3.4, tắt máy bằng SIGQUIT, `EDGE_NGINX` | T2, T3, T9, T10, T11, T16 |
| **EG2** | Hộp phạt IP trong hub-api + metric | T1, T4, T5, T6, T7 |
| **EG3** | Rate limit theo source chạy sau verify (Admin đồng ý, Q5) + sửa ARCHITECTURE §3.1 trong cùng PR (DS1 đã ghi thứ tự cũ) | T8, T12 |
| **EG4** | Bảng `source_traffic_minutely` + đẩy dữ liệu từ bộ nhớ + dọn dữ liệu cũ + yêu cầu thay đổi gửi sang CB (§5.3) | T13 |
| **EG5** | API traffic + scope `traffic:read` + khối Lưu lượng + câu nhận định + panel Grafana (§6.1 đã chốt, Q6) | T14, T15 |
| **EG6** | ADR, `docs/DEPLOYMENT.md` (biến `EDGE_*`, `TRAFFIC_*`, `HOST`, cách đo IP thật), `docs/ARCHITECTURE.md` (sơ đồ §2, mục chống quá tải), `verify/spec-sources.json` (`EG`) | — |

- **Ưu tiên:** EG2 → EG3 → EG1 → EG4 → EG5. Hộp phạt **bịt được lỗ hổng 404 vào DB ngay**, kể cả khi chưa có nginx.
- **Có thể cắt:** bảng IP trong EG5, các dải 24h/7 ngày.
- **Không được cắt:** EG2, và §3.2 của EG1 (IP thật). Bật cầu chì khi chưa đo IP thật = chặn mọi người.

## 11. ADR cần ghi (ADR-175..179 rồi ADR-181. **ADR-180 đã giữ cho `feat/email-cuckoo`**, xem `auth/SPEC-email-cuckoo.md`. Grep lại trước khi ghi)

1. nginx là tiến trình thứ ba trong `hub-all` (không đặt trong Shop, không chạy service riêng). `EDGE_NGINX` là công tắc rollback.
2. Cầu chì IP chỉ áp cho `/hooks/*` và `/v1/p/*`, bật ngay, trần 50 r/s burst 500. Rủi ro chặn oan provider (GitHub không gửi lại) được chấp nhận, kèm điều kiện phải có log.
3. Không dùng Lua. Việc phạt dựa trên phản hồi đặt trong hub-api, trạng thái trong bộ nhớ, không dùng Redis. 401 phạt theo cặp (IP, sourceKey). 404 của source đã lưu trữ không tính điểm.
4. (Nếu làm EG3) Rate limit theo source chạy sau verify.
5. Lưu lượng gộp theo phút, đẩy xuống DB mỗi 60s, giữ 7 ngày. Được phép thiếu dữ liệu, không được làm chậm ingest. 404 của key lạ không lưu.
6. Quyền xem lưu lượng là scope `traffic:read` (owner + operator, Q6).

## Xong khi

- [ ] EG1–EG6 xong, `[EG:T1–T16]` xanh (L2 chạy trên hubv).
- [ ] Đã đo IP thật trên Render và ghi kết quả vào `DEPLOYMENT.md`.
- [ ] Query chứng minh mọi `sourceKey` trong DB khớp regex đã được dán vào PR.
- [x] Admin đã chốt §4.3 (EG3) và §6.1 (quyền xem).
- [ ] Commit tách riêng theo từng story. Không gộp với commit docs-sync hoặc alerts.
