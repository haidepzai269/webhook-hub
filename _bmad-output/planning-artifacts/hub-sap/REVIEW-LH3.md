# REVIEW-LH3 — hub nhận request từ lưới hứng

**Người review:** Winston 🏗️ (kiến trúc) + Murat 🧪 (test, bảo mật webhook). Review độc lập, 2026-10-14.
**Phạm vi:** nhánh `feat/lh` (worktree `C:\wt\lh`), 5 commit `0728f2a 958e2b4 79703c6 1d2a5b4 c4145ee` (`6e42b99..HEAD`).
**Đối chiếu:** SPEC-hub-sap ĐÍNH CHÍNH H1/H3/H4/H5 (thắng thân bài), §5, §13, §15b, §16; CLAUDE.md (BB-1..5, timingSafeEqual, ngân sách Redis, §3.1, cạm bẫy rawBody).

## Kết luận: **CHƯA ĐẠT** — 0 Nặng · 1 Trung bình · 7 Thấp

Lõi H1/H3/H4/H5 đúng và test kỹ. Hai chữ ký tách đúng như H3, chữ ký đầu kiểm ở cổng phạt. `verifyAt` chỉ có khi chữ ký body khớp. Mọi so sánh đi qua `timingSafeCompare` (kiểm độ dài trước, không dừng sớm). Không thêm lệnh Redis. Thứ tự §3.1 giữ nguyên. Còn **một lỗ trong phạm vi story**: cầu chì / `limit_conn` EG1 của nginx vẫn khoá chung IP Cloudflare (TB-1). Sửa TB-1 (tài liệu + chặn cấu hình, không phải viết lại) là ĐẠT.

### Đã chạy

| Lệnh | Kết quả |
|---|---|
| `npx jest apps/hub-api/test/ingest-catchnet.spec.ts --maxWorkers=2` | 21/21 PASS |
| `npx jest apps/hub-api/test/redis-budget.spec.ts --maxWorkers=2` | 17/17 PASS (`[LH:T11]` = EVAL + GET + SET) |
| `npx jest apps/hub-api/test/ingest-public-url.spec.ts --maxWorkers=2` | 3/3 PASS |
| `npx tsc --noEmit -p apps/hub-api/tsconfig.json` | sạch |

---

## Trung bình

### TB-1 — Cầu chì EG1 (nginx) vẫn khoá theo IP kết nối = IP Cloudflare. F7 mới giải được nửa

- **Chỗ:** `docker/nginx/nginx.conf.template:63-70` (`limit_req_zone $edge_fuse_key` = `$binary_remote_addr`, `limit_conn_zone $binary_remote_addr`), `:110-111` (location `/hooks/*`). Commit LH3 không đụng tới file này. ADR-217 và DEPLOYMENT cũng không nhắc.
- **Spec đòi:** F7 (spec:174) ghi rõ "Hộp phạt EG2 **và cầu chì EG1** khoá theo IP". §5.2 ghi "IP cho hộp phạt **/ cầu chì** = `x-catchnet-client-ip`". LH3 mới làm hộp phạt.
- **Kịch bản tấn công:** đặt `EDGE_NGINX=1` theo DEPLOYMENT §3.6 bước 1 (`EDGE_TRUSTED_PROXIES=0.0.0.0/0`, recursive off), nginx sẽ lấy IP thật = IP egress của Cloudflare Worker. Mọi request đi qua lưới chung vài IP này.
  - `limit_conn hooks_conn 50` **luôn bật** khi có nginx, không phụ thuộc `EDGE_IP_FUSE`. Kẻ xấu chỉ cần giữ 50 kết nối chậm tới `/hooks/*` qua Worker, gửi body nhỏ giọt trong 10s `client_body_timeout`. Từ đó mọi provider đi qua lưới nhận **429 từ nginx**.
  - Bật `EDGE_IP_FUSE=1` thì 50 r/s + burst 500 là trần chung cho **toàn bộ** lưu lượng lưới. Riêng một đợt phát lại sau sự cố (batch 25, nhiều source) cũng đủ tự vấp.
  - 429 do nginx sinh ra **không có `x-hub-outcome`**. Theo H1, đây là 4xx không phải "hub vắng", nên Worker trả nguyên 429 cho provider và **không ghi D1**. Lưới không hứng được đúng lúc bị tấn công, và provider không retry 429 thì mất sự kiện.
- **Sửa (tối thiểu, chọn một):**
  - (a) `edge.js` từ chối khởi động, hoặc cảnh báo level 50, khi `CATCHNET_FORWARD_SECRET` có giá trị mà `EDGE_IP_FUSE=1`. Đồng thời nâng hoặc bỏ `limit_conn` cho `/hooks/*` khi lưới bật.
  - (b) Ghi luật vào ADR-217 + DEPLOYMENT §3.6: "Bật lưới hứng thì không bật cầu chì IP của nginx. Cầu chì theo IP đã ký chỉ có ở hub-api (cổng phạt)".
  - Thêm một test tĩnh đọc template hoặc `edge.js` để khoá luật này.
  - Không được tin `$http_x_catchnet_client_ip` trong nginx khi chưa kiểm chữ ký.

---

## Thấp

### T-1 — Header `x-catchnet-*` lưu nguyên trong `raw_events.headers`. Phát lại chữ ký đầu sẽ "đóng khung" IP đã ký

- **Chỗ:** `ingest.service.ts:590` (`redactHeaders` không che `x-catchnet-*`), cùng việc spec H3 cố ý chọn "body lệch thì vẫn giữ IP đã ký".
- **Kịch bản:** thành viên project (tab Lắng nghe `findRecentRawEventsForInspect` trả `headers`) hoặc người có log thấy được bộ `x-catchnet-*` của một request thật. Trong 7 ngày, người đó gửi thẳng tới Render: chữ ký đầu chép lại, body rác.
  - Cổng phạt nhận IP đã ký (IP của provider). Ingest gọi `recordBadSignature(IP provider, sourceKey)` (`:602`), nên cặp (IP PayOS, source) bị phạt. Webhook thật của source đó từ IP ấy nhận 429.
  - Phạm vi chỉ một source, vì path đã ký. Kiểu tấn công cấu hình provider gửi chữ ký sai vào sourceKey vốn đã có từ trước, nên không phải lỗ mới về bản chất. Nhưng đây là một **primitive mới**: đặt được một IP không phải của mình.
  - `via` và base URL công khai cũng giả được theo cách này (đếm "lưới đã cứu" sai, trong project của chính mình).
- **Sửa:** thêm `x-catchnet-signature` và `x-catchnet-body-signature` vào danh sách che, hoặc bỏ hẳn cả bộ `x-catchnet-*` khỏi header lưu. `via` và `received_at` đã có cột riêng, và việc này còn tiết kiệm dung lượng. Nên thêm một ý (ghi ADR, lệch spec H3 có lý do): **body lệch → chấm điểm theo IP kết nối** (`req.ip`). Worker thật luôn ký body khớp, nên body lệch nghĩa là có người sửa hoặc phát lại. Kẻ gọi thẳng Render tự nhận điểm phạt về IP của mình.

### T-2 — `received_at` cho phép tương lai tới 7 ngày (`Math.abs`)

- **Chỗ:** `catchnet.ts:110`.
- Muốn đặt được giá trị này phải có secret, hoặc đồng hồ Worker lệch, nên không phải lỗ từ bên ngoài. Nhưng nếu xảy ra, `raw_events.received_at` và `events.received_at` sẽ nằm ở tương lai: retention bị lùi, sổ khoảng hở (LH0) sai, và tab Lắng nghe xếp sai thứ tự.
- **Sửa:** tách hai ngưỡng: quá khứ ≤ `CATCHNET_RETENTION_DAYS`, tương lai ≤ vài phút lệch đồng hồ (vd 5 phút). Thêm một ca test.

### T-3 — Nghĩa của `raw_events.received_at` đổi, nhưng các chỗ đọc nó chưa được rà

- **Chỗ:** spec §5.2/H5 bắt `received_at` = giờ Worker. Mặc định ADR-217 chỉ xét tới retention. Còn các chỗ khác coi `received_at` ≈ lúc INSERT:
  - `findOrphanRawEvents` (`tenant-scoped.repository.ts:~978`): `received_at < now() − 120s`. Mọi bản phát lại cũ hơn 2 phút thành "mồ côi" ngay lúc COMMIT, khi normalize chưa kịp chạy. Banner và `normalize.backlog` sẽ nháy đúng lúc phát lại hàng loạt sau sự cố.
  - Cũng câu đó: `received_at >= now() − retention`. Bản phát lại có `received_at` gần mốc retention gần như không được cứu theo đường mồ côi.
  - `findRecentRawEventsForInspect` lọc `receivedAt >= since`. Bản phát lại có thể không hiện ở tab Lắng nghe.
  - `CATCHNET_RETENTION_DAYS` (1..30) có thể lớn hơn `EVENT_RETENTION_DAYS`. Không có kiểm tra chéo nào.
- **Sửa:** ghi ADR cho các chỗ đọc này. Kẹp `CATCHNET_RETENTION_DAYS ≤ EVENT_RETENTION_DAYS` lúc khởi động (hoặc cảnh báo). Về lâu dài, cân nhắc thêm cột thời điểm COMMIT riêng cho orphan/inspect.

### T-4 — Migration: "NOT VALID rồi VALIDATE" không giảm khoá như chú thích nói

- **Chỗ:** `migrations/20261014150000_raw_events_via/migration.sql:5-12`.
- Prisma gửi cả file trong một lượt (simple query). PostgreSQL chạy chuỗi nhiều lệnh đó trong **một transaction ngầm**. Đây cũng là lý do `CREATE INDEX CONCURRENTLY` phải nằm riêng một file.
- Vì vậy khoá ACCESS EXCLUSIVE của `ADD COLUMN` / `ADD CONSTRAINT` được **giữ suốt lúc `VALIDATE` quét** `raw_events`. Bảng này giữ ACCEPTED vô hạn (ADR-045). Trong lúc quét, ingest INSERT và normalize SELECT đều đứng chờ. Câu "ingest vẫn ghi được trong lúc quét" là sai.
- Với Neon free hiện nay, bảng nhỏ nên chỉ chặn chưa tới giây, và BB-3 vẫn giữ (chờ, không ACK sớm). Mọi dòng cũ đều NULL, nên VALIDATE không bắt được gì.
- **Sửa:** bỏ `VALIDATE` (để NOT VALID, ràng buộc vẫn áp cho dòng mới), hoặc tách sang một migration riêng. Sửa lại chú thích. `lock_timeout 5s`, việc chỉ thêm cột NULL và dùng TEXT thay enum là đúng.
- **Rollback về master cũ:** an toàn. Cột thừa nullable bị code cũ bỏ qua. RLS theo dòng, không đổi. Không có GRANT theo cột.

### T-5 — Có nhánh trả lời không qua Express nên không có `x-hub-outcome`. ADR-221 viết "mọi"

- Node `clientError` (header > 16KB → 431, request hỏng → 400) và nginx khi `EDGE_NGINX=1` (404 khuôn sai `:121-124`, 413 `client_max_body_size`, 429 `limit_req`/`limit_conn`, 503 upstream) đều không đi qua `hubOutcomeMiddleware`.
- 503 không có outcome thì đúng nghĩa "hub vắng". Còn 4xx không outcome thì LH2 phải có luật rõ: H2 hiện chỉ nói 404 → `inbox_dead`.
- **Sửa:** ghi giới hạn vào ADR-221 và §16, kèm luật cho LH2: "4xx không outcome ≠ 404 thì retry có hạn, rồi `inbox_dead`".

### T-6 — Không kiểm độ dài tối thiểu của `CATCHNET_FORWARD_SECRET`

- **Chỗ:** `catchnet.ts:52-56`. DEPLOYMENT ghi "≥ 32 byte" nhưng code nhận cả `"a"`. Chữ ký đầu là HMAC trên dữ liệu kẻ xấu biết hết, nên secret ngắn bị dò offline từ một header lộ ra (xem T-1).
- **Sửa:** production có giá trị < 32 ký tự thì app thoát lúc khởi động, như `testOnlyConfigProblems`. Giá trị thứ ba trở đi bị `slice(0, 2)` bỏ âm thầm, nên log cảnh báo.

### T-7 — Lỗ test và khuôn ADR

- Thiếu ca:
  - header lặp (Node nối thành `"a, b"`; `one()` nhánh mảng gần như không bao giờ chạy, nên regex mới là thứ chặn — nên test thật);
  - `received_at` có dấu `-`, rỗng, 16 chữ số;
  - IP sai khuôn;
  - `target` dạng tuyệt đối (`POST http://host/hooks/...`);
  - 414 `uri_too_long`, 400 `handshake_invalid`;
  - **header không lọt ra route ngoài `/hooks`** (vd `/health`, `/api/v1/...`);
  - OPTIONS trên `/hooks/*` (204, không có outcome — nên ghi đây là chủ ý).
- Test `timingSafeEqual` lọc theo `Buffer` dài 64. Nó chỉ đúng vì Stripe SDK so bằng `Uint8Array`, khá mong manh. Có thể spy thẳng `timingSafeCompare` của `@hub/crypto` hoặc đếm theo đối số.
- Thiếu một **test vector cố định** (id, at, ip, mode, method, target, secret → hex) dùng chung với LH2. Worker phải ký **đúng chuỗi target nó đưa vào `fetch`**: `new URL()` bỏ dấu `?` đứng một mình và chuẩn hoá percent-encoding. Lệch thì header bị bỏ qua (fail-safe), nhưng lưới mất tác dụng một cách âm thầm.
- ADR-217 và ADR-221 có đủ ba mục Vấn đề/Chọn/Đánh đổi, số nằm trong dải 211–229. Nhưng mục "Chọn" dài nhiều gạch đầu dòng, không phải "3 dòng". Repo đã quen khuôn này nên chỉ ghi nhận.

---

## Đối chiếu từng câu hỏi

1. **Giả mạo.** Gọi thẳng Render không đặt được IP, `receivedAt`, `via` hay URL khi không có secret. Thiếu, sai hoặc quá hạn thì `catchnetOf` trả null và bỏ cả bộ. Header lặp, rỗng, khổng lồ đều bị regex có giới hạn chặn. `received_at` âm, NaN hay không phải số đều bị `MS_RE` loại. Tương lai thì xem T-2. Secret trống thì tính năng tắt hẳn. Xoay khoá 2 giá trị không dừng sớm.
   - Phát lại chữ ký đầu với body khác: **không** được `verifyAt` (đã test). Vẫn được IP đã ký, `via`, base URL (T-1).
   - Không có chỗ nào dùng `===` trên giá trị bí mật. Cả hai chữ ký đi qua `timingSafeCompare`, kiểm độ dài trước.
   - `path_and_query` = `req.originalUrl` thô (Node không decode), giống nhau ở cổng và ở controller nhờ memo. Rủi ro lệch nằm phía Worker (T-7).
2. **Cửa sổ thời gian.**
   - Stripe: `constructEvent(..., receivedAt)` của SDK 22.6.2. SDK chỉ kiểm tuổi (`timestampAge > tolerance`). NaN thì fail-closed.
   - Standard Webhooks: `nowSec`. Signed-template: `nowMs`. Cả hai lấy từ `ctx.verifyAt` (`generic.adapter.ts:454`).
   - hmac/static-token không có timestamp. GitHub, PayOS, SePay không có cửa sổ.
   - Cửa sổ 7 ngày **không** thành lỗ replay cho người chỉ có bản ghi request cũ: muốn có `verifyAt` thì phải có bộ chữ ký lưới của chính request đó. Nếu có, phát lại cùng bytes thì cùng `evt_…`, `UNIQUE(source_id, idempotency_key)` nuốt thành duplicate, và raw ACCEPTED không bị retention xoá (ADR-045). Đổi body thì chữ ký body lệch, quay về `Date.now()`, Stripe trả 401.
3. **Hộp phạt.** Cổng (`checkIp`/`checkPair`/BLOCKED) và ingest (`recordUnknownSource`, `recordBadSignature`, `markGood`, lưu lượng) đều dùng IP đã ký. Chữ ký sai thì dùng IP kết nối (đã test `[LH:T13]`). Rate limit EG3 tính theo source nên không dính IP. **Cầu chì nginx vẫn dính: TB-1.**
4. **x-hub-outcome.**
   - Đã có trên mọi nhánh trong Express: filter Nest 500 → `unavailable`; 404 segment sai và source lạ → `rejected`; 405; 413 và 400 parser; 414 và `handshake_invalid` 400 (fallback); 429 cổng → `refused`.
   - 503 `rejectStatus` → `rejected` qua trace (đã test). Transaction lỗi hoặc exception → `unavailable` (đã test).
   - Không lọt ra route khác: `isHooksPath` khớp đúng `/hooks` và `/hooks/` (chưa có test, T-7).
   - Ngoài Express thì xem T-5.
5. **Migration.** Thêm cột NULL kèm CHECK là đúng. Rollback và RLS ổn. VALIDATE cùng transaction thì không giảm khoá (T-4).
6. **Redis/hiệu năng.** 0 lệnh mới (`[LH:T11]`). HMAC đầu chạy một lần nhờ memo trên req, HMAC body cũng một lần. Request thường tốn 0 HMAC. Không thêm I/O.
7. **Test.**
   - 21 ca tính chữ ký độc lập (`createHmac` trong test, secret sinh lúc chạy), chạy qua app Nest thật với thứ tự middleware giống `main.ts`.
   - Test cũ chỉ **thêm** trường `outcome` vào `toEqual`; status và body giữ nguyên, nên không che đổi hành vi.
   - `publicHooksUrl` mặc định đổi sang `direct` là đúng H4, có test cho cả hai nhánh.
   - T12 trả 200 thay 202: chấp nhận được. Stripe adapter không khai `successStatus`, và lệch này đã ghi ở §16.
8. **Docs.** ARCHITECTURE §3.1 (0', 2b, đoạn outcome), DEPLOYMENT, `.env.example`, spec §13 và §16 khớp code, trừ ba điểm: thiếu luật nginx (TB-1), chú thích migration (T-4), "≥ 32 byte" không được ép (T-6).

## Việc cần làm để ĐẠT

- [ ] TB-1: luật và chặn cấu hình cho cầu chì / `limit_conn` nginx khi bật lưới, ghi vào ADR-217 + DEPLOYMENT §3.6, kèm test tĩnh.
- Khuyến nghị, không chặn: T-1 (che hoặc bỏ `x-catchnet-*` khỏi header lưu) và T-4 (bỏ VALIDATE) nên làm cùng lượt vì rẻ. T-2, T-3, T-5, T-6, T-7 ghi nợ ở §16.
