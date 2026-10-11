# SPEC — Kiểm chứng: dev agent test thế nào, dev khác chạy thế nào, giáo khảo xem gì

> **Đường dẫn:** `C:\webhook-hub\_bmad-output\planning-artifacts\verification\SPEC-verification.md`
> **Ngày:** 2026-10-10 · **Trạng thái:** sẵn sàng để dev. VF1, VF2, VF7 làm được **ngay sau SPEC-3**, trên code hiện tại. Các story còn lại đi kèm các spec khác (xem §11).
> **Nguồn quyết định:** ADR-067 trong `docs/adr/README.md` (số lấy lúc ghi; kiểm lại trước khi ghi ADR mới).
> **Spec này đứng riêng.** Không sửa `SPEC-3`, `SPEC-hub-multi-service.md`, `DINH-CHINH-2026-10-10.md`. Nó **đọc** các mục test của những file đó, gom lại và quy định *cách chạy*. Mục test trong các spec gốc vẫn là nguồn sự thật về *nội dung* từng test.
> **Ai đọc:**
> - **Phiên DEV (agent):** §0, §2 → §6 trước khi làm **bất kỳ** story nào, của **bất kỳ** spec nào. §6 là luật làm việc.
> - **Phiên TEST/REVIEW (agent):** §4, §6.4, §7, §8.
> - **Admin tập dượt:** §9, §10.1.
> - **Dev khác clone repo:** §10.2 (sau VF8 thì đọc `docs/RUNBOOK.md`).

---

## 0. Vì sao có spec này

> Admin, 10/10: "Chúng ta đã bàn rất kỹ về luồng, logic, và tất cả đều nằm trong các spec, nhưng bỏ quên một vấn đề: nếu hoàn thành sản phẩm, vậy quy trình test, thực thi, mô phỏng cho giáo khảo, hoặc chính tôi, dev khác thực hiện như nào?"
> Admin, tiếp: "Nếu chỉ là mô phỏng luồng sau khi dev xong thì chưa chắc chắn lắm, viết cả luồng cho dev agent test." · CI: "Theo Murat cho chắc chắn."

Giả định: mọi spec đã viết (SPEC-1..3, đa service S0–S14, DX1–DX3, AU1–AU6) đều được build đúng như mô tả. Spec này trả lời:

1. **Trong lúc build:** dev agent chứng minh một story xong bằng cách nào, sao cho không tự chấm điểm cho chính mình (§6).
2. **Sau khi build:** một lệnh nào cho biết hệ thống còn đúng, ở máy nào cũng chạy được (§3, §4, §7).
3. **Mô phỏng:** gửi webhook "như PayOS" mà không phải lừa hội đồng (§5).
4. **Trình diễn:** 10 phút trước hội đồng theo thứ tự nào; Admin tập dượt sao cho lần nào cũng giống lần nào (§9).

Nguyên tắc chung: **chứng minh, không khẳng định.** Mọi dấu ✅ phải kèm lệnh đã chạy và output thật. Một test xanh mà chưa từng thấy nó đỏ thì chưa phải bằng chứng.

---

## 1. Hiện trạng (đọc code 10/10)

| # | Sự thật | Hệ quả |
|---|---|---|
| H1 | 56 file `*.spec.ts`, chạy bằng `jest` ở gốc. Test DB bật bằng `RUN_DB_TESTS=1` (`describeDb = … ? describe : describe.skip`) | Quên đặt biến thì **30 test bị skip mà jest vẫn báo xanh**: "xanh vì không chạy gì" |
| H2 | Test DB dùng `new PrismaClient()` với `hub_user`, là **owner/superuser** của DB | Sau AU6, test RLS chạy bằng superuser luôn pass, vì superuser bỏ qua RLS. Test vô nghĩa mà không ai biết |
| H3 | `scripts/e2e-smoke.sh` (129 dòng) sống trong thế giới **1 tenant, JWT admin, source cố định** `src_github_main`, đọc DB bằng `docker exec … psql -U hub_user` | AU1 + S1 + AU6 xong là smoke đỏ, hoặc tệ hơn, xanh giả vì đọc bằng superuser |
| H4 | Mã test nằm rải ở 5 spec: đa service `U1–U33`/`T1–T14` (+U34..U50 của S14), auth `UA1–UA31`/`TA1–TA15`, DX `UX1–UX16`/`TX1–TX5`, SPEC-1..3 đánh theo story `S1-2`…, review checklist đánh theo dòng `#1–#42` | Không có chỗ nào trả lời "mã UA12 nằm ở file test nào, đã có chưa" |
| H5 | Bốn kịch bản demo: ARCHITECTURE §12 (9 bước, "mở màn bằng gãy rồi tự lành"), đa service §7.3 (6 bước), DX §6.3 ("chèn vào **đầu**"), auth §10.3 ("thêm vào **đầu**") | Hai spec giành ghế đầu, ARCHITECTURE nói một kiểu khác |
| H6 | Review SPEC-1..3 có nhiều dòng "✅ **một phần**" vì phiên review bị **cấm restart docker** (stack dùng chung với phiên dev) | Đúng những kịch bản chứng minh BB-3 (kill worker, restart RabbitMQ) lại không được kiểm độc lập |
| H7 | Dòng review #7: dev ghi "1 event", nhưng sau S3-2 thì thành **0 event** (normalize → DLQ). Review mới bắt được | Kịch bản cũ không được chạy lại sau story mới → hồi quy âm thầm |
| H8 | Chưa có `.github/workflows` | Không có gì chặn một commit làm đỏ test |
| H9 | k6 có sẵn (`k6/ingest-github.js`), network gắn cứng `webhook-hub_default` | Đổi tên compose project thì lệnh k6 sai mạng |
| H10 | Smoke **ký bằng `openssl` ngoài hub**, không import code hub | Đúng tinh thần §5, giữ lại |
| H11 | ADR-066 (phiên khác): seed Telegram mặc định **tắt** ở local | Smoke không còn nhắn Telegram thật. Đã xử lý, không cần làm lại |

---

## 2. Năm tầng kiểm chứng

Mỗi tầng cần nhiều hạ tầng hơn tầng trước. Tầng thấp hơn đỏ thì không chạy tầng cao hơn.

| Tầng | Lệnh | Cần gì | Chứng minh | Ngân sách thời gian | Ai/khi nào |
|---|---|---|---|---|---|
| **L0 unit** | `npm run verify:unit` | Node, không docker | Logic thuần: adapter, chữ ký, catalog, scope, pattern… | < 90 s | Dev mỗi lần lưu; CI mọi push |
| **L1 db** | `npm run verify:db` | Postgres 16 + Redis 7 của **stack verify** (§4) | Truy vấn thật: lease/SKIP LOCKED, RLS, unique, migration | < 3 phút | Dev trước commit; CI mọi push |
| **L2 e2e** | `npm run verify:e2e` | Toàn bộ stack verify | Luồng từ đầu tới cuối qua HTTP: đăng ký → key → ingest → delivery → poll | < 6 phút | Dev cuối story; CI mọi PR + nightly |
| **L3 chaos** | `npm run verify:chaos` | Stack verify, **được phép** kill/restart | BB-2, BB-3: kill worker, restart RabbitMQ, tắt Redis, treo Postgres → 0 mất, 0 trùng | < 10 phút | Test agent cuối mỗi spec; CI nightly |
| **L4 perf** | `npm run verify:perf` | Stack verify, máy rảnh | p95, throughput (ARCHITECTURE §13) | 5–10 phút | Tay, trước khi chốt số cho báo cáo. **Không chạy trong CI** (máy CI dùng chung, số vô nghĩa) |

`npm run verify` = L0 + L1 + L2. `npm run verify:all` = L0 → L3.
Mỗi lệnh in một bảng `tầng | pass | fail | skip | thời gian` và **exit ≠ 0 nếu `skip > 0` ở L1 trở lên** (đóng H1).

Ngoài ra, `npm run verify:deployed` chạy tập con L2 có tag `@deployed-safe` vào môi trường Render/Vercel: chỉ trên project `demo`, không chaos, không perf, không xoá dữ liệu ngoài project đó. Nó chứng minh "online thật", không đo gì (ADR-019).

---

## 3. Quy ước test (áp cho mọi spec)

### 3.1 Mã test trong tên test

Mỗi test gắn đúng một mã của spec gốc, viết trong ngoặc vuông ở đầu tên:

```ts
it('[AU:UA12] refresh token dùng lại sau 5s → thu hồi cả họ phiên', …)
it('[MS:U17] payment.link.succeeded khớp payment.* và payment.link.*', …)
```

Tiền tố không gian tên **giữ nguyên số gốc** (không đánh số lại, vì spec gốc đang trỏ tới số đó):

| Tiền tố | Spec |
|---|---|
| `AF:` | audit-fix SPEC-1..3, theo dòng REVIEW-CHECKLIST (`AF:#17`) hoặc story (`AF:S1-2`) |
| `MS:` | SPEC-hub-multi-service (U*, T*) |
| `DX:` | SPEC-dev-experience (UX*, TX*) |
| `AU:` | SPEC-auth (UA*, TA*) |
| `VF:` | spec này (VT*, §12) |
| `BB:` | bằng chứng bất biến (§8.2), có thể **trùng** với một mã khác: một test mang hai mã thì ghi `[AU:TA12][BB:5]` |

Test cũ không có mã thì **không phải sửa ngay**. VF2 thêm mã cho những test đã ứng với một dòng spec. Test không ứng với dòng spec nào thì để nguyên, `verify:map` liệt kê là "không mã".

### 3.2 `verify:map`: bản đồ tự sinh

`npm run verify:map` đọc:
- mọi mã khai báo trong các spec (regex trên bảng test của từng spec, danh sách nguồn nằm ở `verify/spec-sources.json`);
- mọi mã xuất hiện trong tên test (`*.spec.ts`) và trong kịch bản e2e/chaos (§7).

Nó sinh ra `docs/TEST-MAP.md`: `mã | spec | tầng | file:dòng | trạng thái lần chạy cuối`. Gặp các trường hợp sau thì exit ≠ 0:
- **mã mồ côi:** spec có mã, nhưng story của mã đó đã đánh dấu xong mà chưa có test nào mang mã;
- **mã ma:** test mang mã không có trong spec nào (gõ sai, hoặc spec đã bỏ dòng đó);
- **mã trùng:** hai test khác nhau mang cùng một mã mà không đánh dấu `(phần a/b)`.

Story chưa làm thì mã của nó được phép mồ côi. `verify:map` đọc checklist `[x]` của từng spec để biết story nào đã làm.

### 3.3 Bánh cóc số test

`verify/baseline.json` lưu số test **pass** theo từng tầng. Nếu một lần `verify` cho số **nhỏ hơn** baseline thì đỏ, trừ khi commit có dòng `Verify-Baseline: giảm N vì <lý do>` **và** có ADR. Tăng thì tự cập nhật baseline.
Mục đích: chặn agent "làm xanh" bằng cách xoá hoặc skip test.

### 3.4 Điều cấm (grep trong CI, §7.3)

- `describe.skip` / `it.skip` / `xit` / `.only` mới. Riêng `describeDb` thì được, vì L1 bắt skip = 0.
- Mock chính đơn vị đang test. Ví dụ: test `TenantScopedRepository` mà mock Prisma thì phải đổi thành test L1.
- Đổi giá trị mong đợi của một test có mã mà commit không trích dòng spec đã đổi.
- `--no-verify`, `--passWithNoTests` trong script verify.
- Test L1/L2 kết nối DB bằng role owner cho **code đang được test** (xem §4.3).

---

## 4. Môi trường kiểm chứng tách biệt (đóng H6)

### 4.1 Stack `hubv`

Stack verify là **một compose project khác** chạy cạnh stack dev mà không đụng nó:

```bash
npm run verify:up     # docker compose -p hubv -f docker-compose.yml -f docker-compose.verify.yml --env-file .env.verify up -d --build --wait
npm run verify:down   # … down -v (xoá sạch volume của hubv, không đụng volume của stack dev)
```

- `docker-compose.verify.yml` chỉ chứa phần **ghi đè**:
  - cổng cộng 10000 (postgres `15433`, redis `16379`, rabbit AMQP `15673` (không phải 15672: trùng cổng UI RabbitMQ của stack dev) / UI `25672`, hub-api `14000`, shop `14001`, web `13000`, sink `14100`; sửa theo VF1 `3ea2cb5`);
  - volume riêng (`hubv_pgdata`…), mạng tự sinh `hubv_default`;
  - `container_name` bỏ trống để không trùng `webhook-hub-postgres`.
- **Được phép** kill, restart, pause bất kỳ container nào của `hubv`. Đây là chỗ L3 chạy, và là chỗ phiên review làm những dòng trước đây chỉ được "✅ một phần".
- Không có Prometheus/Grafana (giảm RAM), trừ khi đặt `VERIFY_WITH_METRICS=1`.
- Script verify **không bao giờ** gọi `docker` với tên container cứng. Mọi lệnh đi qua `docker compose -p hubv …` (đóng H9; k6 dùng `--network hubv_default`).

### 4.2 `.env.verify`: commit được, không chứa bí mật thật

- Mọi secret là giá trị giả cố định, ví dụ `VERIFY_ONLY_…`. Startup assert: `NODE_ENV=production` mà có secret bắt đầu bằng `VERIFY_ONLY_` thì **thoát**.
- `MAIL_DRIVER=capture`: driver mới, cùng giao diện `MailSender` của SPEC-auth §5.9. Nó ghi mỗi thư ra một file JSON trong `MAIL_CAPTURE_DIR`, được mount ra `verify/.mail/`. Runner e2e đọc link xác minh hoặc link mời từ file, **không** grep log. Production mà `MAIL_DRIVER=capture` thì startup assert thoát.
- `GITHUB_OAUTH_BASE_URL=http://fake-github:8080`: compose verify có service `fake-github` (khoảng 80 dòng, ở `tools/fake-github-oauth/`). Nó cấp `code`, đổi lấy token, trả `/user` + `/user/emails` theo kịch bản. Kịch bản chọn qua header test (`x-fake-user: verified|unverified|no-primary`) để chạy được TA của AU5. Production không được đặt biến này: startup assert yêu cầu `https://github.com` khi `NODE_ENV=production`.
- Đích Telegram/Discord trỏ vào `/mock/*` có sẵn (ADR-054: chỉ tồn tại ngoài production).
- Không có secret thật nào trong stack verify: mọi fixture được ký lại bằng secret giả lúc phát (§5.3). Vì vậy L2 cũng không được có skip.

### 4.3 Hai role trong test (đóng H2)

Sau AU6, test L1/L2 dùng hai kết nối:

| Biến | Role | Dùng cho |
|---|---|---|
| `VERIFY_DB_OWNER_URL` | owner (`hub_owner`) | **Chỉ** dựng/dọn fixture, tức `beforeAll`/`afterAll`, và đọc để assert khi cần nhìn xuyên tenant |
| `DATABASE_URL` | `hub_app` (không superuser, không BYPASSRLS) | **Mọi** code đang được test: repository, service, app |

- Helper `libs/database/test/support/test-db.ts` xuất `owner` và `app`. Grep CI: `new PrismaClient(` trong `*.spec.ts` ngoài helper này → đỏ.
- **Đây không mâu thuẫn với ADR-057** (bác chuỗi kết nối BYPASSRLS cho *app*). Owner chỉ sống trong test và trong `DIRECT_URL` của migrate. Grep §7.3 cấm `VERIFY_DB_OWNER_URL` xuất hiện trong `apps/*/src` và `libs/*/src`.
- Test RLS (TA12, BB:5) phải **assert tiền đề trước**: `select current_user, rolsuper, rolbypassrls from pg_roles where rolname = current_user` cho `hub_app/false/false`. Tiền đề sai thì test **đỏ**, không pass âm thầm.

### 4.4 Seed tất định

`npm run verify:seed`, chạy tự động sau `verify:up`, tạo một thế giới cố định:

| Thứ | Giá trị |
|---|---|
| Operator | `operator@verify.local` |
| User | `owner@cafe.test` (verified), `dev@cafe.test` (developer), `viewer@cafe.test`, `owner@book.test`, `new@unverified.test` |
| Project | `cafe` (test mode), `bookstore` (test mode), `demo` (dùng cho §9) |
| Key | mỗi project một key `hk_test_…` cho mỗi bó scope. Giá trị key cố định, sinh từ seed `VERIFY_SEED=42` |
| Source | PayOS, SePay, Stripe, GitHub, Generic "AB Bank" cho mỗi project, secret giả cố định |
| Endpoint | Shop (`cafe`), `/mock/discord`, `/mock/fail` |

Chạy lại thì cho ra cùng id, cùng key, nên kịch bản e2e hard-code được. `verify:reset` = `down -v` + `up` + `seed`, khoảng 60–90 s.

---

## 5. Bộ giả lập provider và fixture vàng

### 5.1 Vì sao không để hub tự ký

Hub tự ký rồi tự verify thì nếu cả hai cùng sai **theo một kiểu** (ví dụ cùng ký trên JSON đã parse thay vì bytes), test vẫn xanh. Đó là "hub tự đồng ý với chính hub", đúng điều Sally đã bác ở nút "Gửi thử" (ADR-041).

Luật:
- Bộ giả lập nằm ở `tools/hub-sim/`. **Không import bất cứ thứ gì** từ `apps/*`, `libs/*` (grep CI §7.3). Thuật toán ký viết lại độc lập, theo tài liệu công khai của từng provider: PayOS HMAC-SHA256 trên chuỗi `key=value&` đã sắp xếp, Stripe `t=…,v1=…`, GitHub `sha256=`, SePay `Apikey`, Standard Webhooks cho outbound.
- Bộ giả lập **chỉ** giữ secret phía provider, hub vẫn tự verify như với provider thật. Khác duy nhất là ai cầm chìa khoá.

### 5.2 Fixture: dữ liệu mẫu cố định để test phát lại

> **Admin chốt 10/10:** *"Thật ra chúng ta test luồng thật mà lo gì… cần gì sandbox."* Phòng đồng ý **bỏ buổi ghi sandbox riêng** (Q-V3 cũ). Lý do và phạm vi ở §5.5.

"Fixture" = một file dữ liệu đầu vào cố định nằm trong repo, test nào cũng dùng lại (giống 14 body mẫu đã có trong `canonical-contract.spec.ts`). `tools/hub-sim/fixtures/<provider>/<case>.json`:

```json
{
  "provider": "payos",
  "case": "paid-69000",
  "origin": "synthetic",          // synthetic = dựng theo docs/SDK chính thức (mặc định) | real = chép từ một lần chạy thật
  "method": "POST",
  "headers": { "content-type": "application/json" },
  "bodyBase64": "…",              // BYTES NGUYÊN BẢN, không parse rồi stringify lại
  "signature": { "scheme": "payos-body-field", "timestamped": false }
}
```

- **Mặc định là `synthetic`:** body dựng theo tài liệu provider; nếu provider có SDK chính thức thì ký bằng SDK đó (PayOS `createSignatureFromObj`, đã làm ở review S3-1), ngoài ra ký bằng code độc lập của `hub-sim` (§5.1). Đủ cho mọi ca biên mà provider thật không bắn theo ý mình được (`code≠00`, ký sai, timestamp cũ, thiếu `id`).
- **`real` là sản phẩm phụ, không phải việc riêng:** khi Admin test thật bằng tay (§5.5), `npx hub-sim capture --raw-event <id>` chép `body_raw` của dòng `raw_events` ACCEPTED vừa nhận thành fixture. PayOS để chữ ký **trong body** nên bytes đủ để phát lại; GitHub thì chép từ trang "Recent Deliveries" của webhook. Bắt buộc `scrub` (thay số tài khoản, tên người bằng giá trị giả cùng độ dài) rồi ký lại bằng secret giả trước khi commit (repo public).
- **Phát lại:** `npx hub-sim send payos/paid-69000 --to http://localhost:14000/hooks/<sourceId>`.

### 5.3 Ký khi phát lại

Mọi fixture được ký lại bằng secret giả của `.env.verify` lúc phát (Stripe/Standard Webhooks lấy `t = now`). Không giữ secret thật nào trong repo hay CI.

- **[VF:VT5]** (đổi 10/10) Với mỗi provider có SDK chính thức, chữ ký `hub-sim` tự tính phải **bằng đúng** chữ ký SDK tính trên cùng body + secret. Đó là bằng chứng bộ giả lập ký như provider, không phải "hub tự đồng ý với chính hub".
- **[VF:VT6]** Phát lại fixture Stripe với timestamp cũ (không ký lại `t`) thì hub trả **401** (chống phát lại).

### 5.4 Danh mục fixture tối thiểu

| Provider | Ca |
|---|---|
| PayOS | trả đủ · `code≠00` (→ `payment.failed`, `amount=0`) · ký sai 1 ký tự |
| SePay | tiền vào · thiếu `id` (khoá = hash body) · `Authorization` thiếu tiền tố |
| Stripe | `payment_intent.succeeded` · timestamp cũ · `v1` sai |
| GitHub | `push` · `pull_request.opened` · `ping` (→ `normalized:false`) |
| Generic "AB Bank" | `x-signature` đúng · `x-sig` (để chế độ lắng nghe báo sai header) |

**Fixture "bytes lạ"** (thay vai trò bắt lỗi ký-trên-JSON-đã-parse mà fixture sandbox định làm): mỗi provider có ít nhất một body cố tình viết **khác** với `JSON.stringify` của chính nó: khoảng trắng sau dấu `:`, thứ tự key không theo bảng chữ cái, chuỗi thoát `\u00e0` thay cho chữ `à`, số `69000.0`. Hub tính HMAC trên bytes thì 200; ai lỡ tính trên JSON đã parse thì 401 ngay (probe P-SIG-02).

Tất cả là `synthetic`. Có fixture `real` từ lần test tay thì thêm, không bắt buộc.

### 5.5 Test thật và test phát lại: mỗi bên chứng minh một việc

Admin nói đúng một nửa quan trọng: hub có **hai phía**, và phía service thì **không cần giả lập gì cả**.

| Phía | Ai gửi, ai nhận | Test bằng gì |
|---|---|---|
| **Ra (hub → service)** | Hub gửi, service của dev nhận (push Standard Webhooks, poll, `hub listen`, SDK) | **Luồng thật hoàn toàn** trong stack `hubv`: Shop thật, app mẫu thật, SDK thật. Mình làm chủ cả hai đầu nên không có gì phải giả |
| **Vào (provider → hub)** | Tài khoản PayOS/SePay/GitHub **của chính user** gửi, hub nhận. User đăng ký hub, tạo source, dán URL hub vào trang quản trị của provider (SPEC đa service S0–S14) | **Thật**: Admin đóng vai user, dùng tài khoản PayOS, GitHub của mình; SePay dùng Test Mode của SePay (vẫn là server SePay gửi thật). **Phát lại fixture**: chỉ cho test tự động L2/L3 và CI |

Vì sao phía vào vẫn cần phát lại, dù đã có test thật:
1. CI và `verify` chạy **hàng trăm lần**; không thể mỗi lần chuyển khoản, mở tunnel, chờ PayOS.
2. Provider thật **không bắn ca biên theo yêu cầu**: không bảo PayOS gửi `code≠00`, gửi chữ ký sai, hay gửi trùng ba lần đúng lúc mình kill worker được.
3. Chaos (L3) cần bắn **đúng lúc** container vừa chết; tunnel + provider thật làm thời điểm đó ngẫu nhiên.

**Lúc demo không có gì là sandbox hay giả lập** (Admin, 10/10): ô trái là tài khoản provider thật của user; ngoại lệ duy nhất là SePay Test Mode. Bước 12 (cô lập cafe/bookstore) mà dùng `hub-sim` thì phải nói rõ là phát lại.

Phần **đã bỏ** theo lời Admin: buổi ghi sandbox riêng và mục tiêu "mỗi provider một fixture sandbox". Lý do bỏ được: rủi ro "hiểu sai định dạng provider" mà fixture sandbox định bắt thì **lần test tay thật của Admin bắt được** (hub trả 401 hoặc normalize lỗi là thấy ngay), và chữ ký đã đối chiếu với SDK chính thức (VT5).

---

## 6. Luồng làm việc của dev agent (luật cho mọi story, mọi spec)

### 6.1 Vòng đời một story

```
TODO → RED → GREEN → GATED → PROBED → REVIEWED → DONE
         ↑ dev agent ───────────────────────┘     ↑ test agent (phiên khác)
```

| Bước | Dev agent làm | Bằng chứng ghi vào commit/checklist |
|---|---|---|
| **1. Đọc** | Đọc story và **các mã test** của story trong spec gốc. Chạy `verify:map --story AU1` để xem mã nào đang mồ côi | Danh sách mã sẽ phủ |
| **2. RED** | Viết test cho từng mã **trước** code, chạy, thấy đỏ **đúng lý do**: assert sai chứ không phải lỗi import hay biên dịch | Dòng lỗi đỏ, chép nguyên văn 1–3 dòng |
| **3. GREEN** | Viết code tối thiểu cho xanh | — |
| **4. GATED** | `npm run verify` (L0+L1+L2) trên **toàn bộ** repo, không chỉ test của story (đóng H7: hồi quy). `verify:map` không còn mã mồ côi của story | Bảng tóm tắt `verify` (§2) |
| **5. PROBED** | Story chạm **bất biến hoặc bảo mật** (BB-1..5, chữ ký, scope, RLS, CSRF, SSRF, chống trùng) thì chạy `verify:probe` cho các probe liên quan (§6.3). Mỗi probe phải làm test mục tiêu **đỏ** | Bảng `probe | test mục tiêu | đỏ?` |
| **6. Commit** | Một story một commit, kèm khối bằng chứng (§6.2). Không push nếu spec gốc nói không push | — |
| **7. REVIEWED** | **Test agent ở phiên khác** đọc spec, **không** đọc test của dev trước. Nó chạy các kịch bản E2E/chaos của story trên stack `hubv` của chính nó (hoặc sau `verify:reset`), rồi điền cột "Review" **độc lập**, như REVIEW-CHECKLIST đang làm | Cột Review |
| **8. DONE** | CI xanh, cột Review ✅ (không còn "một phần"), probe đỏ-xanh đủ | Đánh `[x]` ở checklist spec gốc |

Dev agent **không bao giờ** tự điền cột Review hay bảng "Kết quả (phiên TEST điền)".

### 6.2 Khối bằng chứng trong commit

```
feat(AU1): đăng ký + đăng nhập + refresh xoay vòng

Verify:
  RED   [AU:UA3] expected 401, received 200   (trước khi có code)
  L0    412 pass / 0 fail / 0 skip   61s
  L1     47 pass / 0 fail / 0 skip  142s
  L2     23 pass / 0 fail / 0 skip  288s
  map   AU1: 9/9 mã có test · 0 ma · 0 trùng
  probe P-AU-01 (bỏ so sánh hash refresh) → [AU:UA12] ĐỎ ✓
Verify-Baseline: +14

Co-Authored-By: …
```

`npm run verify -- --evidence` in sẵn khối này, gồm cả dòng RED lấy từ lần chạy đỏ gần nhất có ghi trong `verify/.last-red.json`. Agent dán khối đó vào commit, không tự gõ số.

### 6.3 Probe: phá có chủ đích để chứng minh test biết đỏ

Một test xanh chưa từng đỏ thì không chứng minh gì. Probe là đột biến **nhắm đích** (mutation testing thu nhỏ, chỉ cho những dòng mà hội đồng sẽ hỏi):

`verify/probes/<id>.json`:

```json
{
  "id": "P-BB5-01",
  "claim": "Quên lọc tenant trong repository thì RLS vẫn chặn",
  "file": "libs/database/src/tenant-scoped.repository.ts",
  "find": "where: { tenantId: this.tenantId,",
  "replace": "where: {",
  "expectRed": ["[AU:TA12]", "[BB:5]"],
  "layer": "L1"
}
```

- `verify:probe` áp từng probe trong một **git worktree tạm**, chạy đúng tầng, kiểm các test trong `expectRed` **đỏ** rồi bỏ worktree. Cây làm việc thật không bao giờ bị sửa.
- `find` không còn khớp (code đã đổi) thì probe **đỏ** ("probe mục"), buộc người sửa code cập nhật probe. Nhờ vậy probe không mục âm thầm.
- Probe khởi điểm (VF6), mỗi cái là một câu hội đồng có thể hỏi:

| Probe | Phá gì | Test phải đỏ |
|---|---|---|
| P-BB2-01 | Bỏ unique `(source_id, idempotency_key)` của `raw_events` (hoặc bắt lỗi P2002 rồi tạo bản ghi mới), chỉ còn Redis chặn trùng | chống trùng khi Redis trống (`BB:2`) |
| P-BB3-01 | Trả 200 trước `COMMIT` | chaos "kill hub-api giữa ingest" (`BB:3`, L3) |
| P-BB3-02 | `ack` trước khi xử lý ở consumer delivery | chaos kill worker → mất delivery |
| P-BB5-01 | Bỏ lọc tenant ở repository | `[AU:TA12]`, `[BB:5]` |
| P-BB5-02 | Bỏ `set_config('app.project_id')` | mọi L1 đọc dữ liệu → 0 dòng (đỏ) |
| P-SIG-01 | `timingSafeEqual` → so sánh luôn true | test ký sai → 401 của mọi adapter |
| P-SIG-02 | Tính HMAC trên `JSON.stringify(body)` thay vì raw | fixture có "bytes lạ" (§5.4) → 401 |
| P-AU-01 | Bỏ phát hiện dùng lại refresh | `[AU:UA12]` |
| P-AU-02 | Bỏ kiểm CSRF | TA CSRF |
| P-AU-03 | Guard bỏ kiểm membership | IDOR `?projectId=` → phải 404 |
| P-SSRF-01 | Bỏ chặn IP nội bộ | `ssrf-*.spec` |
| P-BB1-01 | Thêm `orderCode` vào `apps/hub-worker` | grep BB-1 (§7.3) |

### 6.4 Luật cho test agent (phiên review)

1. Chạy trên `hubv` **của mình**: `verify:reset` trước khi bắt đầu. Được kill/restart thoải mái, nên không còn "✅ một phần vì bị cấm restart".
2. Đọc spec trước, test của dev sau. Viết kịch bản từ spec. Nếu test của dev kiểm một điều **khác** spec thì đó là phát hiện.
3. Cuối mỗi spec (không phải mỗi story) chạy `verify:all` + `verify:probe --all`. Mọi dòng của REVIEW-CHECKLIST spec cũ phải được **chạy lại**, không chép kết quả cũ (H7).
4. Phát hiện ghi theo khuôn hiện có: mức (Cao/TB/Thấp), bằng chứng, đề xuất. Phát hiện Cao chặn DONE.

### 6.5 Khi một test chập chờn

Không có tự động chạy lại. Test chập chờn **là bug**, hoặc của test hoặc của hệ thống (thường là race thật).
- Lần đầu thấy: ghi `verify/FLAKY.md` (mã, lần thấy, nghi ngờ).
- Muốn cách ly (`[quarantine]` trong tên test) phải có ADR. Test cách ly vẫn chạy, chỉ không chặn CI. Quá 3 ngày chưa gỡ thì CI đỏ lại.

---

## 7. CI (Admin chọn theo Murat)

### 7.1 `.github/workflows/verify.yml`

| Job | Khi | Chạy | Ghi chú |
|---|---|---|---|
| `unit` | mọi push, mọi PR | `npm ci` → `verify:unit` → `verify:map` → grep §7.3 | ~3 phút |
| `db` | mọi push, mọi PR | service containers `postgres:16`, `redis:7` → `prisma migrate deploy` → tạo role `hub_app` → `verify:db` | ~5 phút. Dùng đúng migration thật, không `db push` |
| `e2e` | mọi push (repo public) + bấm tay | `verify:up` (compose `hubv` trên runner ubuntu) → `verify:e2e` → upload log + `verify/.mail` khi đỏ | ~10–12 phút |
| `chaos` | nightly + bấm tay | `verify:up` → `verify:chaos` → `verify:probe --all` | ~15 phút |
| `secrets` | mọi push | `gitleaks detect` trên toàn lịch sử | ~1 phút. Repo public |

- Không secret thật nào trong CI. Chỉ `.env.verify`; mọi fixture được ký lại bằng secret giả nên **không có skip** ở L1/L2 (§4.2). Vòng provider thật chỉ chạy tay (§9).
- **Repo public (Admin chốt Q-V2, 10/10):** runner chuẩn của GitHub không giới hạn phút, nên **`e2e` chạy mọi push** chứ không chỉ khi PR, và `chaos` chạy nightly. Vẫn giữ `concurrency` huỷ lượt cũ của cùng nhánh, và `paths-ignore` cho commit chỉ sửa `*.md`/`docs/**`/`_bmad-output/**` (cho nhanh, không phải để tiết kiệm).
- **Public nghĩa là ai cũng đọc được toàn bộ lịch sử git.** Vì vậy:
  - job `secrets` chạy `gitleaks` (pin version) trên **toàn bộ lịch sử** ở mọi push;
  - **trước lần push public đầu tiên**, Admin chạy `gitleaks detect` tay một lần. Lộ secret thì **xoay secret đó** (đổi key ở PayOS/SePay/GitHub/Telegram), không chỉ xoá khỏi git, vì bản sao đã tồn tại;
  - kiểm 10/10: `.env` chưa từng được commit (`git log --all -- .env` rỗng), `.gitignore` chặn `.env`, `.env.local`, `.env.*.local`;
  - workflow dùng `pull_request` (không `pull_request_target`): PR từ fork không đọc được secret nào. CI vốn không cần secret thật (§4.2);
  - fixture `real` **bắt buộc qua `scrub`** trước khi commit (§5.2, rủi ro §14.3), vì giờ cả thế giới đọc được.
- **Bảo vệ nhánh:** `unit` + `db` là required check để merge vào `main`. Hiện mọi phiên commit thẳng `master` không push, nên CI chạy khi Admin push. **Đỏ trên CI = sửa trước khi làm story tiếp**, ghi vào checklist spec đang làm.

### 7.2 Windows vs Linux

Dev chạy Git Bash trên Windows, còn CI chạy Linux. Bẫy:
- **CRLF trong `*.sh`:** thêm `.gitattributes` với `*.sh text eol=lf`. `docker-entrypoint.sh` mang CRLF vào image thì container chết với `no such file`.
- **Đường dẫn:** script verify viết bằng TypeScript (`ts-node`), không viết bash mới. `e2e-smoke.sh` được VF4 thay bằng runner TS; file bash giữ làm vỏ gọi `npm run verify:e2e -- --tag smoke` để lệnh cũ trong tài liệu vẫn chạy.
- Lệnh docker luôn đi qua `docker compose -p hubv`, không tên container cứng.

### 7.3 Grep gác cổng (chạy trong job `unit`)

| Luật | Grep | Nguồn |
|---|---|---|
| BB-1 | `orderCode\|DH\\d+\|\borders\b` trong `apps/hub-*` `libs/*/src` = 0 | CLAUDE.md |
| BB-5 | `prisma\.(rawEvent\|event\|delivery\|…)\.` ngoài `libs/database/src` = 0 | CLAUDE.md |
| RLS | `app.rls_system` chỉ ở `PrismaService.systemTx` | SPEC-auth §5.12 |
| Chữ ký | `===\|!==` cạnh `signature\|hmac\|digest` trong `libs/providers/src` = 0 | CLAUDE.md, ADR-058 |
| Topology | `assertQueue\|assertExchange` ngoài `libs/messaging/src/topology.ts` = 0 | CLAUDE.md |
| Test | `\.only(\|it\.skip\|xit(\|describe\.skip(` mới = 0; `new PrismaClient(` trong spec ngoài helper = 0 | §3.4, §4.3 |
| Giả lập | `from '(@hub\|\.\./\.\./(apps\|libs))` trong `tools/hub-sim` = 0 | §5.1 |
| Test-only | `VERIFY_DB_OWNER_URL\|MAIL_DRIVER.*capture` trong `src` chỉ ở chỗ assert khởi động | §4 |
| Shop | `wc -l apps/shop/src/main.ts` ≤ 300 | CLAUDE.md |

---

## 8. Bản đồ chứng minh: thứ hội đồng chấm → test nào

### 8.1 Bảng tổng (VF2 sinh khung, VF8 điền đủ, nằm trong `docs/TEST-MAP.md`)

| Hội đồng chấm | Câu sẽ hỏi | Bằng chứng tự động | Probe | Bước demo |
|---|---|---|---|---|
| Hiểu bản chất webhook | Sao phải ký trên raw bytes? | fixture "bytes lạ" qua 4 adapter (§5.4) + lần chuyển khoản thật của Admin | P-SIG-02 | Hồi 3 |
| Logic core | Gửi trùng thì sao? | GitHub redeliver ×3 → 1 event (`MS`/`AF`), Redis trống vẫn 1 | P-BB2-01 | Hồi 2 |
| Logic core | Mất sự kiện khi sập? | chaos kill worker / api / rabbit → đếm 0 mất | P-BB3-01/02 | Hồi 2 |
| Kiến trúc | Thêm provider mới? | GenericAdapter AB Bank (MS T*) + `git diff --stat` chỉ trong `libs/providers` | — | Hồi 3 |
| Kiến trúc | Scale? | k6 + `--scale hub-worker=3` (L4, số đo thật) | — | Hồi 2 |
| Backend/bảo mật | Người khác xem được dữ liệu tôi không? | IDOR → 404, key project khác → 404, `[AU:TA12]` RLS | P-BB5-01, P-AU-03 | Hồi 1, 3 |
| Backend/bảo mật | Token bị đánh cắp? | reuse refresh → thu hồi họ phiên | P-AU-01 | (hỏi đáp) |
| Giá trị sản phẩm | Sao không tự viết module? | ba payload khác nhau → một hình dạng `payment.received` (`MS:U37` same-shape) | — | Hồi 3 |

### 8.2 Năm bất biến, mỗi cái một kịch bản đỏ-xanh có thể chiếu

`npm run verify:bb` chạy đúng các test mang mã `BB:*` cùng probe của chúng. Nó in bảng 5 dòng: *bất biến · test · xanh trên code thật · đỏ khi probe*. Bảng này dán thẳng vào chương Kiểm thử của báo cáo.

---

## 9. Trình diễn cho hội đồng (thay H5, một kịch bản duy nhất)

### 9.1 Thứ tự: ba hồi, khoảng 10 phút

Thứ tự này **thay** ARCHITECTURE §12, đa service §7.3, DX §6.3 và auth §10.3. VF8 cập nhật ARCHITECTURE §12 để trỏ về đây; ba spec kia giữ nguyên chữ, spec này thắng về thứ tự.

Mở bằng đăng ký là theo lời Admin ("phần quan trọng nhất bao giờ cũng là ban đầu vào đăng ký đăng nhập ra sao"). ARCHITECTURE §12 muốn mở bằng "gãy rồi tự lành" thì chuyển cảnh đó lên **hồi 2**, vẫn ở 4 phút đầu của phần kỹ thuật.

| Hồi | Môi trường | Bước | Nguồn |
|---|---|---|---|
| **1. Một service mới vào hub** (~3') | DEPLOYED | 1. Đăng ký bằng email thật → **bấm giờ** (Sally 60 / Winston 120) · 2. Tạo key → `npx hub listen` → `hub trigger payment.received` → app mẫu in event → **dừng giờ** · 3. Bấm link xác minh trong mail · 4. Key thiếu scope → lỗi kèm `fix` | auth §10.3 b1–3, DX §6.3 |
| **2. Gãy rồi tự lành** (~4') | LOCAL `hubv` | 5. k6 50 rps + `--scale hub-worker=3`, Grafana · 6. `kill` worker giữa chừng → đếm 0 mất · 7. Tắt Shop → `RETRYING` → bật → tự giao · 8. Đích lỗi → circuit OPEN → DLQ → Replay · 9. GitHub redeliver ×3 → 1 event | ARCHITECTURE §12 b1–4, b7 |
| **3. Thật, và cô lập** (~3') | DEPLOYED | 10. Thanh toán PayOS **thật** 2.000đ → đơn PAID. Source PayOS của project `demo` do **Admin tự tạo trên web như một user bình thường** (khai báo key PayOS của mình, dán URL hub vào trang PayOS; PayOS bắn request xác nhận, xem cạm bẫy 4), làm trước ngày bảo vệ; trong demo chiếu trang source và trang cấu hình webhook của PayOS · 11. Ba payload (PayOS, SePay, AB Bank) → một hình dạng; mở `apps/shop/src/main.ts`: một hàm, không `if` provider · 12. Hai cửa sổ cafe/bookstore: bên kia im lặng, key chéo → 404 · 13. Người thứ hai (viewer, ẩn danh) thử xoá endpoint → 403 · 14. psql bằng `hub_app` → 0 dòng: *"Kể cả code của em quên lọc, Postgres vẫn chặn"* | đa service §7.3, auth §10.3 b4–6, ARCHITECTURE §12 b5 |
| Dự phòng | — | Đăng nhập GitHub · SePay Test Mode: chuyển thiếu tiền · `curl` ký sai → 401 · Discord báo commit | |

**Ai cầm điện thoại (Admin chốt Q-V1, 10/10):** *"Chính tay tôi sẽ test banking qua PayOS."* Admin tự chuyển khoản 2.000đ thật ở bước 10 và tự đăng ký ở bước 1 bằng email của mình. Không bắt buộc xác minh domain Resend cho buổi bảo vệ (địa chỉ gửi `onboarding@resend.dev` chỉ tới được email chủ tài khoản Resend, mà đó chính là Admin). Giáo khảo xem, và vào bằng tài khoản viewer chỉ đọc của project `demo` nếu muốn tự bấm (§10.3).

### 9.2 `demo:*`: tập dượt lần nào cũng giống lần nào

| Lệnh | Làm gì |
|---|---|
| `npm run demo:reset -- --env local` | `verify:reset` + seed project `demo` + dữ liệu nền: 200 event cũ để dashboard không trống |
| `npm run demo:reset -- --env deployed` | **Chỉ** xoá và seed lại project `demo` qua API operator (`DELETE /api/v1/operator/projects/demo/data`). Không đụng project khác. Hỏi xác nhận gõ chữ `demo` |
| `npm run demo:run -- --step 6` | In lời thoại và thao tác của bước 6, chờ Enter, rồi **tự kiểm** kết quả mong đợi (ví dụ đếm delivery trước/sau kill) và in ✅/❌ kèm thời gian |
| `npm run demo:rehearse` | Chạy hết 14 bước liên tiếp; bước nào cần tay thì chờ Enter. Ghi `verify/results/rehearsal-<ngày>.md`: thời gian từng bước, tổng, bước nào ❌ |
| `npm run demo:warm` | Gọi `/health` của hub-api, hub-worker, shop, web trên Render mỗi 30s trong 10 phút, in quota hiện tại của Upstash/CloudAMQP/Neon nếu API cho đọc |

Lời thoại nằm trong `verify/demo/steps.yaml` (mỗi bước: `say`, `do`, `expect`, `env`, `timeoutS`). Đây cũng là kịch bản in ra giấy cho ngày bảo vệ.

### 9.3 Danh sách trước giờ bảo vệ (`verify/demo/PREFLIGHT.md`)

| Khi | Việc |
|---|---|
| T-1 ngày | `verify:all` xanh trên commit sẽ demo · `demo:rehearse` ≤ 11 phút, không ❌ · quay **video dự phòng** đủ 14 bước · kiểm số dư PayOS, domain Resend, GitHub OAuth App callback đúng URL deployed |
| T-60' | `demo:reset --env deployed` · `demo:reset --env local` · Docker Desktop ≥ 6GB RAM · tắt thông báo hệ điều hành |
| T-10' | `demo:warm` (Render free ngủ sau 15 phút không có request, lần gọi đầu mất cỡ một phút) · mở sẵn các tab: dashboard, RabbitMQ UI, Grafana, psql, hai cửa sổ ẩn danh · cỡ chữ terminal ≥ 18 |
| Sự cố | Deployed chết → chuyển hồi 1 và 3 sang `hubv` local, nói rõ là local. PayOS chậm → phát fixture bằng `hub-sim`, **nói rõ** là phát lại (nếu có fixture `real` từ lần test tay thì dùng nó: *"bytes này PayOS đã gửi hôm trước"*). Mọi thứ chết → video |

---

## 10. Hướng dẫn chạy (khung cho `docs/RUNBOOK.md`, VF8 viết thật)

### 10.1 Admin

```bash
npm run verify:up && npm run verify        # hệ thống còn đúng không? (~10 phút)
npm run verify:bb                          # bảng 5 bất biến cho báo cáo
npm run demo:rehearse                      # tập dượt bấm giờ
```

### 10.2 Dev khác clone repo

Yêu cầu: Node 22, Docker Desktop (≥ 6GB RAM cho Docker), Git Bash trên Windows. Các bước:

```bash
git clone … && cd webhook-hub
npm ci
npm run verify:up         # lần đầu build image 5–8 phút
npm run verify            # mong đợi: bảng L0/L1/L2 toàn pass, skip = 0
npm run verify:map        # mở docs/TEST-MAP.md để biết test nào chứng minh gì
```

Muốn **dùng** hub như một dev bên ngoài, xem Quickstart (DX2): đăng ký trên web `hubv` ở `http://localhost:13000`, tạo key, `npx hub listen`.

Năm lỗi hay gặp, mỗi lỗi một dòng cách sửa:
1. Cổng 15433 bị chiếm.
2. `no such file` do CRLF trong file `.sh`.
3. Docker thiếu RAM: RabbitMQ bị OOM kill.
4. `PRECONDITION_FAILED` do queue cũ.
5. `verify:db` báo `skip > 0`: chưa `verify:up`.

### 10.3 Giáo khảo (không cài gì)

Một trang `docs/FOR-EXAMINERS.md` gồm:
- link web deployed và tài khoản viewer chỉ đọc của project `demo`;
- QR thanh toán 2.000đ, nếu Q-V1 = có;
- link video;
- link `docs/TEST-MAP.md` và bảng `verify:bb`;
- một lệnh duy nhất cho ai có Docker: `npm run verify:up && npm run verify`.

---

## 11. Stories (~26h)

| # | Story | Phụ thuộc | Ước lượng |
|---|---|---|---|
| **VF1** | Stack `hubv`: `docker-compose.verify.yml`, `.env.verify`, `verify:up/down/reset`, `verify:seed` (bản đầu theo dữ liệu hiện có, mở rộng khi có S1/AU1), `.gitattributes` | sau SPEC-3 | 3h |
| **VF2** | Runner L0/L1: `verify:unit`, `verify:db` (skip > 0 → đỏ), bánh cóc §3.3, quy ước mã §3.1 + gắn mã cho test đã có, `verify:map` + `docs/TEST-MAP.md`, `--evidence` | VF1 | 4h |
| **VF7** | CI `.github/workflows/verify.yml` job `unit` + `db` + grep gác cổng §7.3 | VF2 | 2.5h |
| **VF3** | `tools/hub-sim`: ký độc lập 5 provider + Standard Webhooks, `capture`/`scrub`/`send`, fixture tối thiểu §5.4 (synthetic; `real` tuỳ chọn từ lần Admin test tay) | VF1 | 4h |
| **VF4** | Runner L2 bằng TS thay `e2e-smoke.sh`: kịch bản có tag (`smoke`, `@deployed-safe`, theo story), đăng nhập theo AU1, đọc mail từ `MAIL_DRIVER=capture`, `fake-github`; nhập các E2E của MS/DX/AU dần theo story | VF3; mở rộng theo AU1–AU3, S1… | 4.5h (+ mỗi spec tự thêm kịch bản của mình) |
| **VF5** | L3 chaos: kill api giữa ingest, kill worker, restart rabbit, stop redis, pause postgres 5s → assert 0 mất / 0 trùng / Redis mất thì chậm chứ không sai | VF4 | 3h |
| **VF6** | `verify:probe` (worktree tạm) + 12 probe §6.3 + `verify:bb` | VF4, VF5; probe AU/RLS sau AU6 | 2.5h |
| **VF8** | `demo:*`, `steps.yaml`, PREFLIGHT, RUNBOOK, FOR-EXAMINERS, ARCHITECTURE §12 trỏ về §9, `verify:deployed`, job CI `e2e` + `chaos` | cuối cùng | 3h |

**Thứ tự gợi ý trong cả dự án** (cập nhật thứ tự ở SPEC-auth §8):

```
SPEC-3 → VF1 → VF2 → VF7 → S0, S1 → AU1–AU3 (dev theo luật §6 từ đây) → VF3 → VF4
       → S2…S12, S14 → AU4, AU5 → AU6 → VF5 → VF6 → DX1–DX3 → VF8
```

Lý do làm VF1, VF2, VF7 sớm: từ AU1 trở đi mọi story đi theo §6. Nếu làm hạ tầng kiểm chứng sau cùng thì 40 story trước đó không có bằng chứng theo khuôn này.

### 11.1 Definition of Done (áp thêm vào DoD của mọi spec, kể từ khi VF2 xong)

- `npm run verify` xanh, skip = 0 ở L1/L2 (không có ngoại lệ, §4.2).
- `verify:map`: 0 mồ côi của story, 0 ma, 0 trùng.
- Story chạm bất biến/bảo mật: probe liên quan đỏ khi phá.
- Commit có khối `Verify:` do `--evidence` sinh.
- Cột Review do phiên khác điền, không "một phần".

---

## 12. Test cho chính bộ kiểm chứng (VT)

| # | Kịch bản | Mong đợi |
|---|---|---|
| VT1 | `verify:db` khi chưa `verify:up` | exit ≠ 0, báo "skip > 0 ở L1" |
| VT2 | Xoá một test có mã rồi chạy `verify` | đỏ do bánh cóc |
| VT3 | Spec có mã `UA99` thuộc story đã `[x]`, không test nào mang | `verify:map` đỏ, liệt kê `AU:UA99` |
| VT4 | Test mang `[AU:UA999]` không có trong spec | `verify:map` đỏ "mã ma" |
| VT5 | Provider có SDK chính thức (PayOS…) | chữ ký `hub-sim` tính **bằng** chữ ký SDK trên cùng body + secret (§5.3) |
| VT6 | Phát fixture Stripe cũ không ký lại | hub trả 401 |
| VT7 | `hub-sim` import từ `libs/` | grep CI đỏ |
| VT8 | `verify:up` khi stack dev đang chạy | cả hai cùng sống; `docker compose -p webhook-hub ps` không đổi |
| VT9 | `verify:down` | volume `hubv_*` mất, volume stack dev còn |
| VT10 | Probe có `find` không còn khớp | `verify:probe` đỏ "probe mục" |
| VT11 | Mọi probe §6.3 | mỗi probe làm đúng test mục tiêu đỏ; cây làm việc không đổi (`git status` sạch) |
| VT12 | Test RLS chạy bằng owner URL | tự đỏ ở assert tiền đề §4.3 |
| VT13 | `NODE_ENV=production` + `MAIL_DRIVER=capture` hoặc secret `VERIFY_ONLY_` | app thoát lúc khởi động |
| VT14 | `demo:reset --env deployed` | chỉ dữ liệu project `demo` đổi; đếm event các project khác trước/sau bằng nhau |
| VT15 | Commit làm đỏ `unit` trên CI | check đỏ, chặn merge `main` |

---

## 13. Câu mở

| # | Câu | Mặc định nếu Admin chưa trả lời |
|---|---|---|
| Q-V1 | Giáo khảo có tự tay trả 2.000đ / tự đăng ký không? | **Đã chốt 10/10:** Admin tự tay chuyển khoản qua PayOS và tự đăng ký (§9.1) |
| Q-V2 | Repo GitHub public hay private? | **Đã chốt 10/10: public.** CI không giới hạn phút; thêm gitleaks + kiểm lịch sử trước lần push đầu (§7.1) |
| Q-V3 | Ai ghi fixture `sandbox`? | **Bỏ 10/10** (Admin: test luồng thật là đủ). Fixture mặc định `synthetic`; `real` chỉ là bản chép tuỳ chọn từ lần Admin test tay (§5.2, §5.5) |

## 14. Rủi ro

1. **26h thêm vào lịch.** VF1, VF2, VF7 (9.5h) là phần không được cắt. VF5, VF6 cắt được nếu trễ, nhưng khi đó §8.2 chỉ còn "xanh" chứ không có "đỏ khi phá", và hội đồng mất câu trả lời mạnh nhất.
2. **RAM máy dev.** Chạy cùng lúc stack dev và `hubv` cần khoảng 5–6GB cho Docker. Máy yếu thì tắt stack dev khi chạy verify; spec không bắt buộc chạy song song.
3. **Fixture lộ dữ liệu thật:** bắt buộc `scrub` trước khi commit; grep CI tìm mẫu số tài khoản 9–14 chữ số trong `tools/hub-sim/fixtures` → đỏ.
4. **Runner CI khác máy dev:** số đo L4 không lấy từ CI, không bao giờ (ADR-019).
5. **Hai phiên song song:** phiên dev đang chạy stack dev thì phiên test vẫn có `hubv` riêng. Nhưng **build image** dùng chung cache Docker, nên tránh hai phiên `--build` cùng lúc.

---

## 15. Checklist (phiên DEV đánh dấu)

- [x] VF1 · [x] VF2 · [x] VF7 · [x] VF3 · [x] VF4 · [ ] VF5 · [ ] VF6 · [ ] VF8
- ADR mới: ADR-068 (VF1 hubv), ADR-069 (VF2 runner/map), ADR-070 (VF7 CI/gates). Commit: VF1 `3ea2cb5`, VF2 `fabb67e`, VF7 `c96bf6b`.
- Bằng chứng (lệnh đã chạy, output rút gọn): `npm run verify:unit` → `L0 379 | 0 | 0`; `verify:db` (Postgres/Redis thật) → `L1 55 | 0 | 0`; `verify:db` khi hubv tắt → exit 1 "skip > 0 ở L1 (55)" (VT1); `it.skip` một test có mã → exit 1 "GIẢM 373 → 372" (VT2); `verify:map` → 198 mã · 53 có test · 0 mồ côi · 10 mồ côi có lý do · 0 ma · 0 trùng; `verify:gates` → 12 luật · 0 vi phạm · 7 ngoại lệ có lý do; `verify:selftest` → VT8, VT9 ✓.
- Lệch so với spec (kèm lý do):
  1. §4.1 cổng: AMQP hubv **15673** (15672 trùng cổng UI RabbitMQ của stack dev, đã gặp `port is already allocated`); shop **14001** (spec ghi 13001, trái quy tắc +10000 và trùng Grafana +10000); sink 14100 (mới).
  2. §4.1 web của hubv chỉ chạy khi `VERIFY_WITH_WEB=1`: bundle nhúng `HUB_API_URL` lúc build, mặc định là API dev 4000. VF4 xử lý.
  3. §4.4 seed: vẫn là seed hiện có (1 tenant, `src_*_main`); thế giới `cafe/bookstore/demo` gộp với seed S12 (DINH-CHINH-AUTH §8 #4, X5).
  4. §3.2 mồ côi: thêm `acceptedOrphans` (mã đã xong nhưng kiểm bằng docker/grep/tài liệu, bắt buộc lý do, luôn in) và `doneOverrides` (MS:U34–U45, U50 ← AF:S3-2). Không có hai cơ chế này thì map đỏ vĩnh viễn với spec cũ.
  5. §2 L0/L1 chia theo file (file dùng `describeDb` = L1), không theo khối: tránh skip giả ở L1.
  6. §7.1 job `e2e` (mọi push) và `chaos` chưa có: theo §11 thuộc VF8 (cần runner L2/L3). Bước tạo role `hub_app` của job `db` để AU6.
  7. §7.3 có 7 ngoại lệ có lý do (PayOS `orderCode`, lối thoát `rawEvent`/`processedMessage`); luật chữ ký bỏ qua `typeof … === '<kiểu>'`/`=== null`.
- Spec cần phiên viết spec sửa: §7.1 dòng "Fixture 'ký gốc' bị skip có lý do (§4.2)" và §11.1 "trừ skip có lý do ở §4.2" mâu thuẫn §4.2 bản mới ("L2 cũng không được có skip"). §4.1 cổng rabbit 15672 trùng UI dev. Bảng test của SPEC-auth / SPEC đa service không ghi mã → story (map cần `done.groups`).
- **VF3** (ADR-132): `tools/hub-sim` (`npm run hub-sim -- list|show|sign|send|capture|scrub`), 14 fixture synthetic §5.4, [VF:VT5] a–d (PayOS/Stripe/GitHub SDK + vector Standard Webhooks), [VF:VT6] phần a ở L0 (phần b HTTP 401 thuộc runner L2 VF4). Lệch: lệnh `npm run hub-sim --` thay `npx hub-sim`; route thật `/hooks/<provider>/<sourceKey>` (spec §5.2 ghi `/hooks/<sourceId>`); `fixedAt` ISO thay epoch (gate fixture-account). Bằng chứng: `verify:unit` L0 696/0/0; gửi thật vào hubv 7 fixture GitHub/PayOS/SePay đúng 200/401; probe tay (ký GitHub trên JSON đã parse) → 3 test đỏ.
- **VF4** (ADR-135): `npm run verify:e2e [-- --tag smoke|VF3|VF4|auth]` = L2 trong `verify/cli/run.ts` (`npm run verify` giờ L0+L1+L2), `verify/lib/{scenario,e2e-world,e2e-runner}.ts`, `verify/scenarios/ingest-e2e.ts` (7 kịch bản: 14 fixture qua HTTP, [VF:VT6] phần b, [BB:2] phần l, push Standard Webhooks verify độc lập, [AF:#39] outbox, [AF:#35] shop_user, publish→poll `@deployed-safe`), `auth-e2e.ts` chạy như tiến trình con. `scripts/e2e-smoke.sh` = vỏ `--tag smoke`. `npm run verify:deployed` có sẵn (bắt buộc VERIFY_API_URL) — CHƯA chạy vào deployed (luật phiên). Bằng chứng: `verify:e2e` L2 25/0/0 137 s; `--tag smoke` 7/0/0; probe tay (đổi `expect.normalized` của github/ping) → kịch bản 14 fixture đỏ. Lệch: "fake-github" của spec = `fake-google` trong sink (AU5b đổi sang Google, ADR-127); MS/DX E2E chưa nhập hết — mỗi spec tự thêm vào `SCENARIO_MODULES`.
- Chặn trước khi push: commit `auth/SPEC-auth.md` + `verification/SPEC-verification.md` (không thì `verify:map` đỏ trên CI); Admin quyết 3 phát hiện gitleaks (commit `0b2cef42`, giá trị ví dụ trong spec).

## 16. Kết quả (phiên TEST điền)

| Mục | Kết quả | Ghi chú | Ngày |
|---|---|---|---|
| VT1–VT15 | …/15 | | |
| `verify:all` thời gian L0/L1/L2/L3 | … / … / … / … | | |
| `verify:probe --all` | …/12 đỏ đúng | | |
| `demo:rehearse` tổng thời gian | … phút | mục tiêu ≤ 11' | |
| Fixture `synthetic` / `real` | … / … | `real` không bắt buộc | |
