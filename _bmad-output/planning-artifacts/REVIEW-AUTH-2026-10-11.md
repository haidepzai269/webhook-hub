# Review độc lập: Auth AU1–AU6 (2026-10-11)

> Người review: phiên review độc lập (không sửa source).
> Phạm vi: `2564d5e` (AU1) · `20e8633` (AU2) · `eb2ac37` (AU3) · `3c426e3` (AU4) · `020396f` (AU5) · `485b83d` (AU6) · `30d7338` (docs). ADR-103..108.
> Căn cứ: `auth/SPEC-auth.md`; khi mâu thuẫn thì `auth/DINH-CHINH-AUTH-2026-10-10.md` thắng. Việc dev để lại cho Admin: `CAN-ADMIN-QUYET-2026-10-10.md`.
> Môi trường: stack `hubv` build lại từ `master@30d7338` (`npm run verify:up`, exit 0). Mọi request trong báo cáo này bắn thật vào `localhost:14000`. Script tấn công nằm trong scratchpad, không nằm trong repo.

---

## 0. Kết luận nhanh

| Story | Kết luận | Lý do chính |
|---|---|---|
| AU1 phiên, cookie, CSRF, rate limit | **Đạt, có điều kiện** | Cookie, CSRF, xoay vòng và thu hồi đều đúng. Còn 2 lỗ ở rate limit: **R-1** (đua song song phá giới hạn 5 lần sai) và **R-2** (sau proxy web mọi người dùng chung một IP). Thêm **R-6**: đăng ký vẫn dò được email |
| AU2 mail, xác minh, quên/đặt lại mật khẩu | **Đạt** về API | Token dùng một lần, đặt lại mật khẩu thu hồi mọi phiên, mật khẩu yếu không đốt token. Nhưng link trong mail trỏ vào trang web **chưa có** (**R-5**) |
| AU3 scope, projectId, operator | **Đạt, có điều kiện** | Không có IDOR qua HTTP (thử 10 kiểu). Lỗ ở socket: socket đã mở **vẫn nhận event** sau khi bị xoá khỏi project hoặc sau `logout-all` (**R-3**) |
| AU4 mời, thành viên, last_owner | **Đạt** | Mời nhầm email bị chặn, developer không leo quyền được, `scope_not_grantable` đúng. Đua hai owner hạ quyền nhau: còn đúng 1 owner |
| AU5 GitHub OAuth | **Đạt phần chạy được, chưa kiểm hết** | state, PKCE và ghép tài khoản theo spec đúng khi đọc code. Luồng thật (TA11) chưa chạy. Còn **R-5** (`/onboarding` 404) và **R-12** |
| AU6 RLS | **Đạt** | Runtime chạy bằng `hub_app` (không superuser, không BYPASSRLS). 9 bảng có FORCE RLS. Không đặt biến thì 0 dòng; INSERT bị policy chặn. Shop → PAID, smoke, polling và flow cross-project vẫn chạy. Chi phí: **+2 ms p50 cho mỗi lời gọi repo** (**R-4**). Deploy bị chặn cho tới khi Admin làm A1 (**R-7**) |

**Mức Cao:** R-2 (khoá đăng nhập toàn hệ thống khi đi qua proxy web; mức Cao *có điều kiện* là chạy deployed hoặc local qua web) và R-7 (vận hành: deploy hiện tại sẽ chết, dev đã khai).
**Mức Trung bình:** R-1, R-3, R-4, R-5, R-6, R-8.
**Không phát hiện:** IDOR HTTP, bỏ qua CSRF, dùng lại token reset/verify/invite, leo quyền qua role/scope, đọc chéo tenant dưới RLS.

---

## 1. Lệnh đã chạy và bằng chứng

| Lệnh | Kết quả |
|---|---|
| `npm run verify` (L0 + L1 + map) | L0 **597/0/0**, L1 **131/0/0** (L1 chạy bằng `hub_app`), map 213 mã · 0 mồ côi · 12 mồ côi có lý do · 0 ma · 0 trùng. Khớp baseline |
| `npm run verify:gates` | 13 luật · 0 vi phạm · 7 ngoại lệ có lý do |
| `npm run verify:e2e:auth` | **12/12 pass** (TA1–TA10, TA13, TA15). TA3: email không tồn tại 373 ms, sai mật khẩu 365 ms, lệch 8 ms |
| `bash scripts/e2e-smoke.sh` (HUB_URL=14000, secret của `.env.verify`) | **OK**: 3 delivery SUCCEEDED, chống trùng đúng, REJECTED ≤ 1, outbox không chứa secret |
| Shop: `POST :14001/orders` → SePay `/hooks/sepay/src_sepay_main` | đơn `DH6248293571` → **PAID**, paidAmount 69000 |
| `bash scripts/demo-multi-project.sh` | Bước 1, 2, 4, 5, 6 chạy đúng (cô lập, 404 chéo key, revoke, GenericAdapter, ba kiểu vào một kiểu ra). **Bước 3 hỏng**, xem R-11 (lỗi có từ trước, không do AU) |
| psql bằng `hub_app` (§4) | 0 dòng ở mọi bảng có RLS; INSERT `audit_logs` → `violates row-level security policy` |
| Script tấn công (§2, §3) | 60 request, kết quả ghi ở từng mục |

Phụ: `npm run verify` tự sinh lại `docs/TEST-MAP.md` (chỉ đổi dòng dấu thời gian/commit). File này đang ở trạng thái `M`; tôi không revert (luật cấm `git restore`). Admin hoặc dev tự quyết.

---

## 2. Kết quả tấn công: phiên, CSRF, chống dò

| # | Thử | Kết quả | Đánh giá |
|---|---|---|---|
| 1 | Cờ cookie | `__Host-hub_at` / `__Host-hub_rt`: `HttpOnly; Secure; SameSite=Lax; Path=/`, at 900 s, rt 7 ngày. `hub_csrf`: `Secure; SameSite=Lax`, không HttpOnly (cố ý) | ✓ |
| 2 | POST tạo đích thiếu `x-csrf-token` | 403 | ✓ |
| 3 | Header CSRF lấy từ phiên của B | 403 | ✓ |
| 4 | Cookie tossing: cookie và header đều là của B | 403 (chữ ký gắn sid) | ✓ |
| 5 | `GET` kèm `X-HTTP-Method-Override: POST` | chỉ là GET (200), không ghi gì | ✓ |
| 6 | `POST /auth/refresh` thiếu CSRF | 403 | ✓ |
| 7 | Xoay vòng: access token cũ sau refresh | vẫn 200 tới khi hết 15 phút | ✓ đúng thiết kế (identity.repository.ts:243) |
| 8 | Dùng lại rt cũ sau 5 s | TA5 xanh: thu hồi cả family, có `session.reuse_detected` | ✓ |
| 9 | Logout rồi dùng at/rt cũ | `/auth/me` 401, refresh 401 | ✓ |
| 10 | B xoá phiên của A (`DELETE /auth/sessions/<id của A>`) | 404, A vẫn sống | ✓ |
| 11 | Dùng lại token reset; đặt mật khẩu yếu trước rồi mới đặt mạnh | yếu → 422 (token **không** bị đốt) → đặt mạnh 204 → dùng lại 400 `token_invalid`; phiên cũ 401 | ✓ |
| 12 | Dùng token reset ở `/auth/verify-email` | 400 (khác purpose) | ✓ |
| 13 | Đăng nhập: email không có vs sai mật khẩu | cùng body; lệch 8 ms (TA3) | ✓ |
| 14 | Đăng ký email đã có vs email mới | **201 + 0 cookie** vs **201 + 3 cookie** | ✗ R-6 |
| 15 | Quên mật khẩu, email có vs không có (5 mẫu mỗi bên) | 10–19 ms vs 7–13 ms | Thấp (R-13) |
| 16 | 18 lần login sai **song song** cho một email | **17 lần 401, 1 lần 429** (spec: tối đa 5) | ✗ R-1 |
| 17 | 7 lần đăng ký từ một IP | 201×5, 429×2 | ✓ đúng giới hạn, nhưng xem R-2 |
| 18 | `POST /auth/login` dạng form urlencoded từ origin lạ | **200 + 3 cookie** | Thấp (R-10) |

## 3. Kết quả tấn công: phân quyền, IDOR, socket, lời mời

| # | Thử (B không thuộc project A) | Kết quả |
|---|---|---|
| 1 | B `PATCH`/`DELETE` đích của A, gửi kèm `projectId` của B | 404 / 404 ✓ |
| 2 | B `PATCH` đích của A, gửi kèm `projectId` của A | 404 ✓ |
| 3 | B đọc `/api/v1/projects/A/members`, và cùng route đó với `?projectId=B` | 404 / 404 ✓ (path thắng query) |
| 4 | B đọc `/api/v1/projects/A/keys?projectId=B` | 404 ✓ |
| 5 | `?projectId=B&projectId=A` | dùng phần tử đầu (B), 200 trên project của B ✓ |
| 6 | B đọc `/api/v1/flow/topology?projectId=A` | 404 ✓ |
| 7 | B xin vé socket cho A; xin vé thiếu projectId | 404 / 400 ✓ |
| 8 | Một vé dùng 2 lần trong 60 s | cả 2 đều nối được (spec §5.7 chấp nhận) |
| 9 | **E bị A xoá khỏi project, socket vẫn mở** | HTTP → 404 ✓, nhưng **socket vẫn nhận `event.received`** ✗ R-3 |
| 10 | **E `logout-all`, socket vẫn mở** | socket vẫn `connected`, vẫn nhận event mới ✗ R-3 |
| 11 | B nhận lời mời gửi cho E | 403 `invite_email_mismatch`, token không bị đốt ✓ |
| 12 | E nhận lời mời lần 2 | 400 `token_invalid` ✓ |
| 13 | Developer mời owner / tự nâng mình lên owner / xoá owner | 403 `missing_scope` ×3 ✓ |
| 14 | Developer tạo key với `manage:keys` / `read:project` | 422 `scope_not_grantable` ✓ |
| 15 | Đua: hai owner A và F hạ quyền nhau cùng lúc | [403, 204], còn **đúng 1 owner** ✓ (`FOR UPDATE` chạy đúng) |
| 16 | User chưa xác minh: mời người / tạo project `live` | 403 `email_not_verified` ×2 ✓ |
| 17 | User chưa xác minh tạo 20 project test liên tiếp | 20/20 thành công (R-14) |
| 18 | `/auth/github` khi chưa cấu hình; callback không có cookie | 503; 400 `oauth_state_mismatch` ✓ |

## 4. RLS (AU6)

- Runtime: `DATABASE_URL` của hub-api và hub-worker là `hub_app`. `pg_roles`: `hub_app` có `rolsuper=f`, `rolbypassrls=f`. `DIRECT_URL` = `hub_user` (owner, superuser) chỉ dùng cho migrate và seed. TA13 xanh: chạy bằng superuser thì app thoát và log `superuser/BYPASSRLS`.
- Có `relrowsecurity` **và** `relforcerowsecurity` trên: `sources, events, destinations, subscriptions, deliveries, audit_logs` và 3 bảng con có policy EXISTS: `source_secrets, raw_events, delivery_attempts`.
- psql bằng `hub_app`, không đặt `app.project_id`: cả 5 bảng thử đều 0 dòng. INSERT `audit_logs` → lỗi policy. `app.project_id='not-a-uuid'` → lỗi cast (đóng). `_prisma_migrations` không đọc được. `CREATE TABLE hub.x` → permission denied.
- Các chỗ dùng `systemTx`/`rls_system` (grep): tra source lúc ingest (`prisma.service.ts:105`, batch), xoá events theo retention (`:127`), cleanup theo lô (`cleanup.job.ts:172`: processed_messages, raw_events REJECTED), sweeper delivery kẹt (`delivery.sweeper.ts:118`). **Cả 4 đều có lý do** (chưa biết tenant, hoặc xuyên tenant có chủ đích). Worker consumer lấy `tenantId` từ message rồi `forTenant`/`tenantTx`.
- Đường `/v1/p` (API key) và module flow vẫn chạy dưới RLS: demo bước 1, 2, 4, 5, 6 · polling `cursor` 81 · flow 404 chéo project · TA1 publish → console.
- Không bật RLS: `api_keys` (có `tenant_id`), `project_members`, `projects`, `users`, `auth_sessions`, `email_tokens`, `auth_audit`, `outbox`, `processed_messages`. Lựa chọn này khớp chú thích trong migration và §5.12.3 (danh sách bảng của spec không có `api_keys`). Xem R-9.

---

## 5. Phát hiện

### R-2 · Cao (có điều kiện) · Sau proxy web, rate limit theo IP thành giới hạn chung cho cả hệ thống
- **Chỗ:** `apps/hub-api/src/main.ts:61` (`trust proxy` = 1 hop), `apps/hub-api/src/modules/auth/auth.service.ts:34-39` (LIMITS), `docs/DEPLOYMENT.md:336`, `apps/web/next.config.mjs` (rewrites).
- **Vấn đề:** request console đi qua `rewrites` của Next.
  - **Local:** web gọi api trong compose, không có `TRUST_PROXY`, nên `req.ip` luôn là IP container web.
  - **Deployed:** chuỗi là client → Vercel → LB của Render → app. Với `trust proxy=1`, `req.ip` là IP egress của Vercel (một nhóm nhỏ IP dùng chung), không phải IP người dùng.

  Hệ quả: `loginIp` 20 lần / 15 phút, `registerIp` 5 lần / giờ và `refreshIp` 60 lần / phút thành giới hạn **cho mọi người cộng lại**. DEPLOYMENT.md gọi đây là "lớp phụ" nhưng chưa nói tới hệ quả này.
- **Cách tái hiện (đã đo phần cơ chế):** từ một IP gửi 5 lần register → lần 6 trả 429 (§2 #17). Qua web, mọi người dùng mang cùng một IP. Kẻ xấu gửi 20 login sai bất kỳ qua web là **mọi người** dính 429 trong 15 phút. Buổi bảo vệ có hơn 5 người thử đăng ký trong một giờ là người thứ 6 nhận 429.
- **Chưa đo:** chưa chạy trên Render/Vercel thật. Local thì chắc chắn xảy ra (một IP).
- **Sửa đề xuất:** deployed đặt `trust proxy` đúng số hop (2) hoặc danh sách CIDR. Hoặc proxy web gửi IP client trong một header ký HMAC bằng secret chung, và hub-api chỉ tin header đó. Hạ vai trò khoá theo IP xuống làm phụ (vd 200/15 phút), giữ khoá theo email làm chính. Thêm test e2e đi qua proxy web.

### R-7 · Cao (vận hành, dev đã khai ở A1) · Deploy hiện tại sẽ thoát ngay khi khởi động
- **Chỗ:** `libs/database/src/prisma.service.ts:222-240`, `apps/hub-api/src/main.ts:58`, `apps/hub-worker/src/main.ts:68`.
- Render đang dùng `neondb_owner`. Role này có BYPASSRLS hoặc là chủ bảng nên `assertAppRoleNotPrivileged` gọi `exit(1)`. Hành vi này đúng spec. Admin phải làm A1 (tạo `hub_app` trên Neon, đổi `DATABASE_URL`) **trước** lần deploy kế, nếu không bản deployed chết.
- Ghi thêm: trên Neon, owner **không** phải superuser, nên FORCE RLS chặn **cả owner**. Mọi migration *dữ liệu* sau này (UPDATE/backfill trên bảng có RLS) sẽ chạy đúng ở local (owner `hub_user` là superuser) nhưng **ảnh hưởng 0 dòng mà không báo lỗi** trên Neon. Cần thêm luật: migration dữ liệu phải tự `SELECT set_config('app.rls_system','on',true)`. Nên ghi vào DEPLOYMENT/ADR-108.

### R-1 · Trung bình · Khoá theo email bị phá bằng request song song (peek rồi mới hit)
- **Chỗ:** `apps/hub-api/src/modules/auth/auth.service.ts:157-167`. `peek` (đọc) diễn ra trước bcrypt; `hit` (tăng) chỉ diễn ra sau khi sai. N request đến cùng lúc đều đọc được count < 5.
- **Tái hiện:** xoá `rl:*`, gửi 18 `POST /auth/login` song song tới `operator@verify.local` với mật khẩu sai → `{"401":17,"429":1}`. Như vậy đoán được 17 lần chứ không phải 5. Mỗi IP đoán được thêm tối đa 20 lần mỗi 15 phút, nên với nhiều IP thì giới hạn 5 lần không còn ý nghĩa. TA4 xanh vì TA4 gửi tuần tự.
- **Sửa:** tăng bộ đếm **trước** khi so mật khẩu bằng một `EVAL` (INCR + EXPIRE, rồi từ chối nếu > 5). Đăng nhập đúng thì có thể DECR hoặc DEL. Vẫn chỉ 1 lệnh Redis trên đường đi. Thêm test UA dạng song song.
- Hệ quả phụ (Thấp, do spec thiết kế): ai cũng khoá được email của người khác, kể cả **operator**, bằng 5 request mỗi 15 phút.

### R-3 · Trung bình · Socket đã kết nối không bị cắt khi mất quyền hoặc mất phiên
- **Chỗ:** `apps/hub-api/src/modules/realtime/realtime.gateway.ts:143-161` (chỉ kiểm lúc handshake), `:177-181`. Không có chỗ nào ngắt socket khi `removeMember`, `logout`, `logout-all`, reset mật khẩu hay đổi mật khẩu.
- **Tái hiện (§3 #9, #10):** E là viewer của A và mở socket bằng vé của A. A xoá E: HTTP trả 404 nhưng socket vẫn nhận `event.received` khi A publish. Sau đó E gọi `logout-all`: socket vẫn `connected` và vẫn nhận event mới. Payload lộ ra: id/type event, tên và id đích, `httpStatus` và thời gian giao (`DeliveryAttemptNotice`), `metrics.tick`.
- Spec §5.7 chỉ nói "kiểm lại session" lúc handshake. Comment trong code nói "logout-all ngắt được cả socket **mới**". Tuy vậy spec §5.3 hứa "thu hồi tức thì", và một người đã bị xoá vẫn xem được luồng sự kiện vô thời hạn. Với luận điểm cô lập BB-5, đây là kẽ hở.
- **Sửa (rẻ, không tốn Redis):** gắn `socket.data.sid` và `userId`. Khi revoke family, xoá thành viên hoặc reset mật khẩu thì gọi `server.in(room).fetchSockets()` rồi `disconnect` các socket có sid/userId khớp. Cách này đủ cho một instance; nhiều instance thì cần thêm một kênh pub/sub. Phương án gọn hơn: mỗi 60 s kiểm lại session và membership của các socket đang mở, một truy vấn theo lô.

### R-4 · Trung bình · Chi phí per-call transaction trên đường delivery chưa được đo (dev chỉ đo ingest)
- **Chỗ:** `libs/database/src/tenant-scoped.repository.ts:39-62` (proxy). Mỗi phương thức repo gọi trên client gốc thành một interactive transaction: BEGIN, `set_config`, truy vấn, COMMIT, tức 4 round-trip thay vì 1.
- **Đo (microbench, hubv local, 400 lần, cùng một delivery):**

  | Truy vấn | p50 | p95 |
  |---|---|---|
  | `delivery.findUnique` như trước AU6 (owner, không tx) | 4,07 ms | 6,22 ms |
  | như proxy AU6 (`$transaction{set_config; findUnique}`, hub_app) | **6,07 ms** | **9,24 ms** |
  | batch `$transaction([set_config, findUnique])` | 4,79 ms | 9,44 ms |
  | đếm `delivery_attempts` trước AU6 | 1,38 ms | 2,72 ms |
  | đếm `delivery_attempts` sau AU6 (tx + policy EXISTS) | **4,77 ms** | **9,01 ms** |

- Mỗi delivery có ít nhất 2 lời gọi repo bọc tx (`findDeliveryForSend`, `claimForSend`, thỉnh thoảng thêm `getDeliveryLeaseState`) cộng một `set_config` trong `tenantTx`. Ước tính **+5 đến 7 ms mỗi delivery ở local**. Trên Neon (round-trip pooled 1–3 ms), mỗi lời gọi tốn thêm 3 round-trip, tức khoảng **+10 đến 25 ms mỗi delivery**. Đây là **ước tính, chưa phải k6 E2E**.
- Rủi ro phụ:
  - transaction tương tác giữ connection pool lâu hơn: `hub-api` không đặt `connection_limit`, worker đặt 10;
  - timeout mặc định 5 s của interactive tx áp lên mọi phương thức repo chạy lâu (`getTimeseries`, `findOrphanRawEvents`, `pollEvents`). `pollEvents` giờ giữ advisory lock suốt cả lần đọc vì `assignPollSeq` và SELECT chạy chung một tx. Vẫn đúng nhưng tranh chấp lâu hơn.
- **Sửa:** đo k6 cho delivery (độ trễ từ event tới SUCCEEDED, trước và sau) rồi ghi vào §11 hoặc ADR-108. Phương thức đọc một câu thì dùng batch transaction (như ingest đã làm) thay cho interactive. Đặt `connection_limit` cho hub-api.

### R-5 · Trung bình (chức năng và demo; dev đã khai A6) · Link trong mail và redirect OAuth trỏ vào trang web chưa có
- **Chỗ:**
  - `auth.service.ts:94` (`/forgot-password`), `:271` (`/reset-password`);
  - `members.service.ts:76` (`/invite`);
  - `github-oauth.service.ts:151` (`/onboarding`).

  Trong `apps/web/src/app` chỉ có `/login`, `/register`, `/verify-email` và `/dashboard/*`.
- **Hệ quả:**
  - Quên mật khẩu, nhận lời mời và mail "có người thử đăng ký" đều dẫn tới **404**. Người dùng không tự cứu được tài khoản qua giao diện. Đây cũng là cách duy nhất để user chỉ có GitHub đặt mật khẩu.
  - User GitHub mới đăng nhập xong rơi vào 404. Phiên đã được tạo nên gõ `/dashboard` thì vào được.
- **Về mức độ:** API đã đủ và DINH-CHINH §3 giao trang cho phiên UI, nên **không phải lỗi bảo mật**. Nhưng nếu demo luồng quên mật khẩu hoặc mời thành viên trước hội đồng thì sẽ hỏng.
- **Sửa nhanh nếu UI chưa kịp:** đổi redirect `/onboarding` thành `/dashboard`. Làm 2 trang trần `/reset-password` và `/invite` giống `/verify-email`, gồm `no-referrer` (đã có trong `next.config` cho 3 đường này) và `replaceState`.

### R-6 · Trung bình · Đăng ký vẫn dò được email đã có tài khoản
- **Chỗ:** `auth.service.ts:90-96` kết hợp `auth.controller.ts` hàm `register`. Email đã có thì trả 201 với body giả và **không có Set-Cookie**. Email mới thì 201 với 3 cookie.
- **Tái hiện:** §2 #14: `[201,3]` vs `[201,0]`. Thử thêm `GET /auth/me` thì phân biệt chắc chắn. Spec §5.2 hứa "201 giống hệt, không lộ email nào đã có tài khoản", và TA3 chỉ so hình dạng body nên vẫn xanh.
- **Hệ quả phụ:** dò kiểu này là *tạo* luôn tài khoản chưa xác minh dưới email nạn nhân (đăng ký trước). Nạn nhân phải dùng quên mật khẩu, mà trang đó đang 404 (R-5).
- **Sửa:** chọn một trong hai.
  1. Đăng ký **không** đăng nhập ngay: luôn trả 201 `{ok:true, verifyEmailSent}`, đăng nhập sau khi xác minh. Giá phải trả là Quickstart 60 s.
  2. Giữ thiết kế hiện tại nhưng **ghi ADR** rằng đánh đổi DX lấy khả năng dò qua register (giới hạn 5/giờ/IP), và sửa câu chữ trong spec.

  Tôi nghiêng về phương án 2, cộng với sửa R-2.

### R-8 · Trung bình · Guard mở mặc định, và UA20 chỉ quét 4 controller ghi cứng
- **Chỗ:** `console/project-scope.guard.ts:73` (`if (required && …)`: route thiếu `@RequireScope` thì **qua**), `apps/hub-api/test/auth-scope.spec.ts:90` (danh sách controller cứng).
- Hiện tại không route nào thiếu scope (grep 33 route ✓). Nhưng controller console mới thêm sau này mà quên decorator thì mở cho mọi role, và UA20 không phát hiện.
- **Sửa:** guard ném 500/403 khi route không có `@RequireScope` và cũng không có `@NoProjectScope` (đóng mặc định). UA20 tự quét mọi controller đăng ký trong `AppModule` (qua `DiscoveryService` hoặc glob `*.controller.ts`).

### R-9 · Thấp · `api_keys` có `tenant_id` nhưng không bật RLS
- **Chỗ:** `libs/database/prisma/migrations/20261011110000_rls_hub_app/migration.sql:33` (danh sách bảng), bảng `api_keys`.
- Tra theo hash là bước *xác định* tenant (escape hatch hợp lý). Nhưng liệt kê và thu hồi key theo project chỉ được lọc ở tầng ứng dụng. psql bằng `hub_app` không đặt biến vẫn thấy 3 dòng.
- **Sửa:** bật RLS, cho đường `findApiKeyByHash` đi `systemTx` hoặc batch. Hoặc ghi rõ ngoại lệ vào ADR-108 và DINH-CHINH-2026-10-10 §2 (bảng mới của đa service phải tự thêm policy, như DINH-CHINH đã dặn).

### R-10 · Thấp · Login CSRF (form urlencoded)
- **Chỗ:** body parser mặc định của Nest nhận `application/x-www-form-urlencoded`. `/auth/login` không đòi CSRF (spec loại trừ).
- **Tái hiện:** §2 #18: form POST từ `Origin: https://evil.example` → 200 kèm 3 cookie. Trang độc có thể đăng nhập nạn nhân vào tài khoản của kẻ tấn công, và nạn nhân sẽ cấu hình đích webhook vào tài khoản đó.
- **Sửa:** `/auth/login` và `/auth/register` chỉ nhận `application/json`, 415 cho kiểu khác. Request JSON cross-origin buộc preflight, mà CORS đã khoá origin.

### R-11 · Thấp (có từ trước AU, ADR-094) · Bước 3 của `demo-multi-project.sh` hỏng
- **Chỗ:** `scripts/demo-multi-project.sh:43`. `/v1/p/cafe/endpoints` chỉ trả endpoint do *chính key gọi* tạo (`service-resources.controller.ts:316`, R-1/ADR-094), mà script tạo key mới mỗi lần chạy. Kết quả là `EP_CAFE` rỗng và `TypeError` ở bước 3.
- Dev ghi "demo-multi-project chạy hết". Đúng là script chạy tới cuối, nhưng bước 3 lỗi. Không liên quan RLS: `destinations` của cafe vẫn đọc được bằng `forTenant`.
- **Sửa:** demo dùng endpoint do chính key đó tạo, hoặc đọc id bằng psql.

### R-12 · Thấp · GitHub: các nhánh lệch nhỏ
- `github-oauth.service.ts:138-144`: user đã liên kết GitHub **khác** (`linkGithub` trả 0) mà email GitHub mới trùng thì vẫn được **đăng nhập** vào user đó. Kẻ tấn công phải kiểm soát email đã xác minh (khi đó cũng reset mật khẩu được) nên tác động thấp. Nên trả `/login?error=github_account_mismatch`.
- `auth.service.ts:136`: P2002 trên email khi GitHub tạo user đồng thời → ném lỗi → 500 thay vì redirect.
- TA11 (luồng thật) chưa chạy. Unit test mock `fetch` 10/10.

### R-13 · Thấp · Các lệch nhỏ khác
- Quên mật khẩu: email có thật tốn thêm khoảng 4 ms (thêm một transaction tạo token). Đo được bằng thống kê. Có thể đưa việc tạo token ra sau response.
- Vé socket do operator xin cho project không phải của mình không ghi `operator.access` (`socket-ticket.service.ts:22-29`). Chỉ request HTTP mới ghi.
- Lời mời còn hiệu lực sau khi người mời bị hạ quyền hoặc bị xoá (`members.service.ts:97-119`). Nên kiểm người mời còn `manage:members` lúc accept, hoặc vô hiệu lời mời khi người mời mất quyền.
- `webLink` lùi về `http://localhost:3000` khi thiếu `WEB_PUBLIC_URL` (`auth.service.ts:354`, `members.service.ts:76`). Production nên assert biến này lúc khởi động như các secret.
- `hub_app` tự `SET app.rls_system='on'` được (ở mức phiên). Đây là bản chất của RLS kiểu GUC, và gate grep chỉ chặn được chuỗi literal. Nên ghi vào ADR-108 là giới hạn đã biết: RLS chống *quên lọc*, không chống SQL injection.

### R-14 · Thấp · User chưa xác minh tạo project test không giới hạn
- `projects.controller.ts:115-143`: tạo 20 project liên tiếp đều thành công (§3 #17). Nên đặt trần, vd 10 project mỗi user, hoặc rate limit.

---

## 6. Kết luận từng story

| Story | Kết luận | Phải sửa trước khi coi là xong | Nên sửa |
|---|---|---|---|
| **AU1** | Đạt, có điều kiện | R-1, R-2 | R-6 (hoặc ghi ADR), R-10 |
| **AU2** | Đạt (API) | — | R-5 (trang `/reset-password`, phiên UI), R-13 |
| **AU3** | Đạt, có điều kiện | R-3 | R-8, vé operator (R-13) |
| **AU4** | Đạt | — | R-5 (`/invite`), lời mời của người mất quyền (R-13) |
| **AU5** | Đạt phần đã kiểm; **TA11 chưa chạy** | — | R-5 (`/onboarding` → `/dashboard`), R-12 |
| **AU6** | Đạt | R-7 trước lần deploy kế (việc của Admin, A1) | R-4 (đo delivery, cân nhắc batch tx), R-9, luật migration dữ liệu trên Neon (R-7) |

**Đánh giá các gap dev đã khai:**
- `/onboarding` 404: Trung bình về DX. Sửa một dòng thành `/dashboard`.
- Thiếu trang `/forgot-password`, `/reset-password`, `/invite`, Thành viên, Thiết bị: Trung bình. Luồng khôi phục tài khoản và mời người không dùng được qua giao diện. Không phải lỗ bảo mật.
- TA11 và TA14 làm tay: chấp nhận được. TA14 nên làm trước buổi demo vì cookie `__Host-` trên `http://localhost` phụ thuộc trình duyệt.

## 7. Dòng điền vào DINH-CHINH-AUTH §7

| Chặng | Phát hiện | Mức | Trạng thái |
|---|---|---|---|
| AU1 | R-1 khoá email bị phá bằng request song song (17/18 lượt lọt) | Trung bình | mở |
| AU1 | R-2 rate limit theo IP sau proxy web thành giới hạn chung toàn hệ thống | Cao* | mở |
| AU1 | R-6 register dò email qua Set-Cookie | Trung bình | mở / ADR |
| AU3 | R-3 socket không bị cắt khi bị xoá thành viên hoặc logout-all | Trung bình | mở |
| AU3 | R-8 guard mở mặc định, UA20 danh sách cứng | Trung bình | mở |
| AU6 | R-4 per-call tx: +2 ms p50 mỗi lời gọi repo, delivery chưa đo | Trung bình | mở |
| AU6 | R-7 deploy cần A1; migration dữ liệu trên Neon bị FORCE RLS chặn | Cao (vận hành) | Admin |
| UI | R-5 link mail và `/onboarding` → 404 | Trung bình | phiên UI |
| — | R-9..R-14 | Thấp | mở |

---

# Vòng 2 (2026-10-11): kiểm lại sau 14 commit sửa (`275abbd` … `fa20f49`, ADR-109..120)

> hubv dựng lại từ HEAD `fa20f49`: `VERIFY_WITH_WEB=1 npm run verify:reset` (exit 0), có thêm web proxy ở cổng 13000. Đã chạy `docker builder prune` sau khi build (đĩa còn 39 GB).
> Script tấn công vòng 2 nằm trong scratchpad, không nằm trong repo. Source không sửa gì. `docs/TEST-MAP.md` lại bị `verify:map` sinh lại (dấu thời gian), tôi để nguyên.

## V2.0 Kết luận nhanh

- 12/13 mục đã sửa **đứng vững khi tấn công lại**: R-1, R-2, R-3, R-5, R-7, R-8, R-10, R-11, R-12, R-13, R-14, và R-4 đã đo.
- **Bản sửa R-6 mở ra một lỗ mới mức Cao (N-1): chiếm tài khoản bằng cách đăng ký trước**. Đã tái hiện trọn vẹn.
- Trang `?next=` vẫn bị **open redirect** (N-2, Trung bình).
- R-9 đang hoãn (A7): chấp nhận.

## V2.1 Bộ kiểm

| Lệnh | Kết quả |
|---|---|
| `npm run verify` | L0 **611/0/0** · L1 **136/0/0** · map 227 mã · 0 mồ côi · 12 mồ côi có lý do · 0 ma · 0 trùng. Khớp baseline |
| `npm run verify:gates` | **14 luật** (thêm `data-migration-rls`) · 0 vi phạm · 7 ngoại lệ |
| `npm run verify:e2e:auth` | **16/16 pass** (thêm AR:R-2c, R-3d, R-5, R-6b). TA3 lệch 6 ms |
| `e2e-smoke.sh` (14000, `PG_CONTAINER=hubv-postgres-1`) | OK |
| `demo-multi-project.sh` | exit 0. Bước 3 đã chạy: "bị lỡ: 3 sự kiện [10001, 10002, 10003]". Hai dòng 404 còn lại là kết quả mong đợi của bước 2 |
| Shop: tạo đơn → SePay | **PAID** |

## V2.2 Chạy lại các repro gốc

| Mục | Repro | Vòng 1 | Vòng 2 | Kết luận |
|---|---|---|---|---|
| R-1 | 18 login sai song song, cùng một email | 17×401, 1×429 | **5×401, 13×429**. Mật khẩu đúng lúc đang bị khoá → 429 (đúng thiết kế). 8 lần đăng nhập đúng liên tiếp → 8×200 (`release` chạy đúng) | ✓ đóng |
| R-2 | qua web, `x-forwarded-for` 1.1.1.1 ×6, rồi 2.2.2.2 ×2 | mọi người chung một IP | `[201×5, 429]`, `[201, 201]`. Khoá Redis `rl:reg:ip:1.1.1.1` và `:2.2.2.2` | ✓ đóng |
| R-2 | gửi thẳng API: `x-hub-client-ip` không kèm secret ×6 | — | bị bỏ qua (khoá theo IP socket `::ffff:172.20.0.1`), lần 6 → 429 | ✓ |
| R-2 | gửi thẳng API: IP giả + secret sai | — | bị bỏ qua | ✓ |
| R-2 | qua web: client tự gửi `x-hub-client-ip: 5.5.5.5` + `x-hub-proxy-secret` giả | — | proxy xoá cả hai header, khoá theo XFF `6.6.6.6` | ✓ |
| R-2 | `/hooks/*` và `/v1/p/*` qua web | — | 404 / 404 (không bị proxy) | ✓ |
| R-3 | socket của E sau khi A xoá E khỏi project | vẫn nhận event | **bị ngắt sau 128 ms** | ✓ đóng |
| R-3 | E logout ở thiết bị 1 | — | socket thiết bị 1 bị ngắt, socket thiết bị 2 còn (đúng: chỉ thu hồi family đó) | ✓ |
| R-3 | E logout-all ở thiết bị 2 | vẫn nối | bị ngắt. Vé cũ dùng lại → bị từ chối | ✓ đóng |
| R-6 | đăng ký email mới vs email đã xác minh | `[201,3 cookie]` vs `[201,0]` | cả hai `201`, 0 cookie, body giống từng byte | ✓ |
| R-6 | thời gian đăng ký (4 mẫu mỗi bên) | — | mới 347–378 ms, đã có 348–393 ms | ✓ |
| R-6 | login tài khoản chưa xác minh (đúng mật khẩu) vs email không tồn tại | — | cùng 401 `invalid_credentials`, 358 / 410 ms | ✓ |
| R-8 | route console không khai scope | guard cho qua | guard trả 500 `scope_not_declared` (unit AR:R-8a). UA20 tự quét mọi `*.controller.ts` | ✓ đóng. Không thử được bằng HTTP vì không được thêm controller |
| R-10 | login / register dạng urlencoded; `text/plain; application/json` | 200 + cookie | **415 / 415 / 415** | ✓ đóng |
| R-14 | 15 lần tạo project song song (user đã xác minh, đang có 1) | 20/20 thành công | 9×201, 6×403, tổng **đúng 10** | ✓ (khoá advisory chạy đúng) |
| R-5 | `/forgot-password`, `/reset-password`, `/invite` | 404 | 200. Trang token có `Referrer-Policy: no-referrer`. GitHub user mới → `/dashboard` | ✓ |
| R-12 | GitHub: user đã gắn GitHub khác; callback đồng thời | — | đọc code: không đăng nhập, `github.link_mismatch`; P2002 → ghép lại một lần (unit). TA11 vẫn thủ công | ✓ |

## V2.3 Phát hiện mới

### N-1 · **Cao** · Chiếm tài khoản bằng đăng ký trước (hồi quy do bản sửa R-6)
- **Chỗ:**
  - `apps/hub-api/src/modules/auth/auth.service.ts`, hàm `registerInBackground`: email đã có nhưng chưa xác minh thì chỉ gọi `sendVerification(existing.id, …)` và **giữ nguyên `passwordHash` của người đăng ký đầu tiên**;
  - `verifyEmail` đặt cờ xác minh **và đăng nhập luôn**;
  - `login` mở lại cho mọi tài khoản đã xác minh.
- **Tái hiện (hubv, đã chạy):**
  1. Kẻ tấn công đăng ký `victim@…` với mật khẩu A → 201. Link xác minh đi vào hộp thư nạn nhân, kẻ tấn công không cần đọc.
  2. Nạn nhân tự đăng ký cùng email với mật khẩu V → 201 giống hệt, nhận link mới.
  3. Nạn nhân bấm link → **200, đã đăng nhập**, tên hiển thị là `"Attacker"`.
  4. Nạn nhân login bằng mật khẩu V của mình → **401**.
  5. Kẻ tấn công login bằng mật khẩu A → **200** và thấy project của nạn nhân (memberships = 1).
  6. Link đầu tiên đã bị vô hiệu (400) nên không phải lý do.
- **Vì sao Cao:** đây đúng kiểu tấn công mà spec §5.10 viết riêng để chặn ("chặn chiếm tài khoản bằng cách đăng ký trước email của người khác"). Ở vòng 1, nạn nhân được mail dẫn sang quên mật khẩu, tức là đặt lại mật khẩu, nên kẻ tấn công mất quyền. Bây giờ nạn nhân đăng nhập vào tài khoản mà kẻ tấn công biết mật khẩu, và mọi key, endpoint, dữ liệu nạn nhân tạo sau đó kẻ tấn công đều đọc được.
- **Sửa đề xuất:** tài khoản tạo bằng đăng ký có mật khẩu **chưa được xác nhận** cho tới khi email được xác minh. Hai cách:
  - (a) **Khuyên dùng, đơn giản.** Link xác minh của tài khoản loại này đưa tới bước **đặt mật khẩu**, giống reset-password, rồi mới đăng nhập. Ai nắm hộp thư thì người đó chọn mật khẩu. Thu hồi mọi phiên khác.
  - (b) Gắn `passwordHash` đang chờ vào **chính token** (thêm cột trong `email_tokens`), xác minh thì áp hash của token được bấm. Cách này vẫn rủi ro vì hộp thư có cả link của kẻ tấn công, nạn nhân không phân biệt được hai link. Vì vậy chọn (a).

  Kèm theo:
  - Ngay khi xác minh: `revokeUserSessions` toàn bộ.
  - Thêm test e2e `[AR:N-1]` với kịch bản trên.

### N-2 · **Trung bình** · Open redirect qua `?next=` (ký tự điều khiển)
- **Chỗ:** `apps/web/src/app/(admin)/(auth)/_components/next-path.ts` (`safeNext` chỉ kiểm tiền tố `/`, `//`, `/\`). Dùng ở `login-form.tsx:46` và `:84` qua `router.replace`.
- **Tái hiện:**
  - `safeNext` cho qua `/\t/evil.com`, `/\n/evil.com`, `/\t\evil.com` (query `next=/%09/evil.com`, `/%0a/evil.com`).
  - Parser URL theo chuẩn WHATWG bỏ tab/newline, nên `new URL('/\t/evil.com', origin)` ra `http://evil.com/` (đã chạy bằng node).
  - Router của Next (`app-router-instance.js`, hàm `dispatchNavigateAction`) dựng `new URL(href, location.href)` và chuyển trang kiểu MPA khi `isExternalURL`.

  Nghĩa là link `https://<web>/login?next=/%09/evil.com` đưa người dùng sang site lạ **ngay sau khi họ đăng nhập thành công**, rất hợp cho phishing. Chưa chạy trên trình duyệt thật, mới suy từ code của Next và parser URL.
- **Sửa:** `const u = new URL(raw, location.origin); if (u.origin !== location.origin) return fallback; return u.pathname + u.search + u.hash;`, và từ chối `raw` có ký tự `< 0x20` hoặc `\`. Thêm unit test với `/%09/`, `/%0a/`, `/%5C`, `%2F%2F`.

### N-3 · Thấp · `forgot-password` vẫn nhận form urlencoded
- `POST /auth/forgot-password` dạng urlencoded → 202. Trang lạ có thể buộc trình duyệt nạn nhân bắn mail reset (đã có giới hạn 1/phút, 5/ngày theo email; không lộ gì). Nên dùng chung `requireJsonBody` cho mọi POST công khai của `/auth/*` cho nhất quán.

### N-4 · Thấp (đã ghi ở ADR-110) · Local: client tự đặt được XFF khi đi qua proxy web
- Gửi 8 lần register qua web với `x-forwarded-for` khác nhau → 8×201, lách được giới hạn IP. Deployed dựa vào việc Vercel ghi đè `x-real-ip` / `x-forwarded-for`. Nên kiểm một lần trên Vercel thật: gửi XFF giả rồi xem khoá `rl:*` trên Upstash. Khoá theo email vẫn là lớp chính.

## V2.4 Ý kiến cho Admin: A10 (DX đăng ký) và A11 (+16,8 %)

- **A11, R-4, ADR-119: chấp nhận.**
  - Thời gian worker xử lý +16,8 % (129,5 so với 110,9 ms). Độ trễ người dùng thấy (event → SUCCEEDED) chỉ +1,4 % vì chu kỳ outbox chiếm phần lớn.
  - Với đồ án, đây là đánh đổi có số đo và có ADR, nên kể được trước hội đồng: "RLS tốn 1,4 % độ trễ đầu-cuối".
  - Không cần gộp `tenantTx` thêm. Chỉ cần ghi rõ baseline C là bản build tạm không nằm trong repo, và trên Neon chênh tuyệt đối sẽ lớn hơn.
- **A10, R-6, ADR-120: hướng đúng, nhưng có 2 điều kiện.**
  1. Phải sửa **N-1** trước, nếu không thì R-6 tạo ra lỗ nặng hơn lỗ nó vá.
  2. Trên **deployed**, đăng ký phụ thuộc mail thật (A2). Resend chưa xác minh domain thì **chỉ gửi được tới email chủ Resend**, tức thành viên hội đồng **không tự đăng ký được**.

  Cho buổi demo: xác minh một domain, hoặc demo bằng email của Admin hay GitHub login (A3), hoặc tạo sẵn tài khoản. Ở local, `MAIL_DRIVER=log` vẫn demo được: copy link từ log. Câu "Quickstart 60 giây" giờ phải tính cả thời gian mở mail.

## V2.5 Kết luận từng story (cuối vòng 2)

| Story | Kết luận | Còn lại |
|---|---|---|
| **AU1** | **Đạt** | R-1, R-2, R-10 đã đóng. N-2 (open redirect `?next=`, file web của AU1/R-5) phải sửa. N-4 Thấp |
| **AU2** | **Chưa đạt, chặn bởi N-1 (Cao)** | Luồng đăng ký → xác minh → tự đăng nhập cho phép chiếm tài khoản đăng ký trước. Phần còn lại (token một lần, reset thu hồi phiên, trang có thật) đạt. N-3 Thấp |
| **AU3** | **Đạt** | R-3 và R-8 đã đóng, có test e2e và unit |
| **AU4** | **Đạt** | lời mời chết khi người mời mất quyền (R-13). Trang `/invite` có thật |
| **AU5** | **Đạt** (phần kiểm được) | R-12 đã đóng. TA11 vẫn cần làm tay với OAuth App thật (A3) |
| **AU6** | **Đạt** | R-4 đã đo, nên chấp nhận A11. R-7 có gate. R-9 hoãn (A7), chấp nhận cho đồ án nếu ghi vào phần "giới hạn" |

**Việc phải làm trước khi đóng chặng auth:** N-1 (Cao), N-2 (Trung bình). Sau đó chạy lại `verify:e2e:auth` cùng kịch bản N-1.

---

# Vòng 3 (2026-10-11): kiểm N-1..N-4 sau `752d4bd`, `25d3505`, `a20f0e3`, `7f4ae67` (ADR-121..123)

> hubv dựng lại từ HEAD `7f4ae67` kèm web (`VERIFY_WITH_WEB=1 npm run verify:reset`, exit 0). Đã prune build cache. Source không sửa gì. `docs/TEST-MAP.md` lại được `verify:map` sinh lại dấu thời gian, tôi để nguyên.

## V3.1 Bộ kiểm

| Lệnh | Kết quả |
|---|---|
| `npm run verify` | L0 **628/0/0** · L1 **138/0/0** · map 231 mã · 0 mồ côi · 0 ma · 0 trùng |
| `verify:gates` | 14 luật · 0 vi phạm |
| `verify:e2e:auth` | **17/17 pass** |
| `e2e-smoke.sh` (hubv) | OK |
| `demo-multi-project.sh` | exit 0 |
| Shop: tạo đơn → SePay | **PAID** |

## V3.2 N-1: chiếm tài khoản bằng đăng ký trước. Đã đóng

| Thử | Kết quả |
|---|---|
| 1. Kẻ tấn công đăng ký email nạn nhân (mật khẩu A) → 2. nạn nhân đăng ký (V) | 201 / 201, nạn nhân nhận link mới |
| 3a. Bấm link chỉ gửi `{token}` | 400 `password_required`, **token không bị đốt** |
| 3b. `{token, password: "123"}` | 422 `password_weak`, token vẫn còn |
| 3c. `{token, password: V2, name}` | 200, tên "Victim", 3 cookie |
| 4. Đăng nhập bằng A / V / V2 | **401 / 401 / 200**: kẻ tấn công mất quyền hoàn toàn |
| Dùng lại link; dùng link cũ của lượt đăng ký đầu | 400 / 400 |
| Biến thể: kẻ tấn công gọi `forgot-password` trước. Nạn nhân dùng link reset | reset trên tài khoản chưa xác minh → `claimAccount` (204). Đăng nhập bằng A → 401, bằng mật khẩu mới → 200. Link xác minh cũ → 400 (bị vô hiệu) |
| Đua: hai lần claim song song cùng token, hai mật khẩu khác nhau | [400, 200]. Chỉ mật khẩu của lượt thắng đăng nhập được, không lẫn trạng thái |
| Biến thể: kẻ tấn công đi đường GitHub | Không khả thi: cần email GitHub *đã xác minh* trùng email nạn nhân, tức là đã nắm hộp thư. Nạn nhân đi GitHub vào tài khoản chưa xác minh → `email_exists_unverified` (giữ nguyên). `claimAccount` xoá `githubId` |
| Những thứ ADR-121 giữ lại | Project tự tạo giữ **slug và tên của kẻ tấn công** (đo được: slug `attacker`, tên `Attacker's project`). Chỉ là hiển thị, không cấp quyền. Key ở project nhiều thành viên không bị thu hồi. Sau R-6, tài khoản chưa xác minh không đăng nhập được, nên không thể nhận lời mời hay tạo key; nhánh này chỉ áp cho dữ liệu cũ trước R-6. **Không còn đường chiếm quyền.** Thấp: nên cho đổi tên/slug project (hoặc đặt lại tên theo `name` khi claim) để nạn nhân không thấy tên kẻ tấn công |

## V3.3 N-2: open redirect qua `?next=`. Đã đóng

Fuzz 22 payload qua `safeNext` thật (`next-path.ts`), rồi phân giải bằng `new URL(s, origin)`. **0/22 ra ngoài origin.** Các payload gồm:
- `//evil.com`, `/%09/`, `/%0a/`, `/%0d/`, `/%00/`, `/%5C`;
- `/%2F%2F`, `/%252F%252F` (giải mã hai lần ra path `/%2F%2Fevil.com`, vẫn cùng origin);
- `/.//evil.com`, `/./%2F/`, `/..//`, `/%2e%2e//`;
- unicode `/%E3%80%80/`, `/%EF%BC%8F%EF%BC%8F` (dấu `/` toàn khổ), NBSP;
- `/@evil.com`, `/javascript:alert(1)` (thành path nội bộ).

Hàm trả `pathname + search + hash` đã phân giải chứ không trả chuỗi gốc, nên đúng hướng.

## V3.4 N-3 và N-4. Đã đóng (N-4 còn giới hạn đã ghi)

- **N-3:** POST urlencoded tới `login`, `register`, `forgot-password`, `verify-email`, `reset-password` → **415** cả 5. `refresh` / `logout` → 401 vì không có cookie, không đọc body. Có test quét nguồn.
- **N-4:** proxy xoá `x-hub-*`, `x-real-ip`, XFF của client rồi đặt lại đúng một IP hợp lệ. XFF rác → không gửi `x-hub-client-ip` → API rơi về IP của container web.
  - Ở local, client vẫn tự chọn `x-real-ip` / XFF: 7 lần đăng ký xoay IP → 7×201. Đây là giới hạn ADR-123 đã khai (Next không cho Proxy đọc địa chỉ socket). Chấp nhận được vì khoá theo email mới là lớp chính.
  - **Admin cần làm bước kiểm trên Vercel thật** (A8, DEPLOYMENT): gửi XFF giả qua web deployed rồi xem khoá `rl:reg:ip:*` trên Upstash phải là IP thật.

## V3.5 Ý kiến cho Admin: DX "nhập mật khẩu hai lần" (không chặn)

- Thiết kế hiện tại an toàn: ai nắm hộp thư thì người đó chọn mật khẩu.
- Cái giá DX: người đăng ký thật nhập mật khẩu lúc đăng ký, rồi **nhập lại** khi bấm link. Mật khẩu lúc đăng ký thực chất bị bỏ đi.
- **Phương án nhẹ hơn, an toàn ngang bằng:** *đăng ký chỉ bằng email (+ tên)*, kiểu "magic link". Form đăng ký không có ô mật khẩu; link trong mail mở form đặt mật khẩu (đúng luồng `claimAccount` đã có).
  - An toàn tương đương vì mật khẩu chỉ được chọn sau khi chứng minh hộp thư.
  - Người dùng chỉ nhập mật khẩu **một lần**.
  - Code gần như sẵn có: bỏ `password` khỏi `POST /auth/register`, giữ nhánh `password_required`.
  - Câu chuyện kể trước hội đồng cũng gọn hơn: "mật khẩu chỉ tồn tại sau khi email được chứng minh".
- Nếu muốn giữ ô mật khẩu ở form đăng ký thì ít nhất trang `/verify-email` nên ghi rõ "Đặt mật khẩu để kích hoạt" để người dùng không tưởng hệ thống lỗi.
- Phụ thuộc mail thật trên deployed (A2/A10) không đổi; GitHub login (A3) vẫn là đường đăng ký không cần mail.

## V3.6 KẾT LUẬN CUỐI từng story

| Story | Kết luận cuối | Ghi chú |
|---|---|---|
| **AU1** phiên, cookie, CSRF, rate limit, vé socket, proxy web | **ĐẠT** | R-1, R-2, R-10, N-2, N-3, N-4 đã đóng. Còn: kiểm IP trên Vercel thật (A8) |
| **AU2** mail, xác minh, quên/đặt lại mật khẩu | **ĐẠT** | N-1 đóng, các biến thể (forgot trước, đua, dùng lại) đều an toàn. R-6 dò email đã đóng. Gợi ý DX ở V3.5. Deployed cần mail thật (A2) |
| **AU3** scope, projectId, operator, socket | **ĐẠT** | R-3, R-8 đã đóng, có e2e |
| **AU4** mời, thành viên, last_owner | **ĐẠT** | R-13 (lời mời chết khi người mời mất quyền). Trang `/invite` có thật |
| **AU5** GitHub OAuth | **ĐẠT có điều kiện** | Code và unit đạt (R-12). **TA11 với OAuth App thật vẫn phải làm tay** (A3) trước khi demo luồng GitHub |
| **AU6** RLS | **ĐẠT** | Runtime `hub_app`, FORCE RLS, gate migration dữ liệu (R-7). R-4: +16,8 % thời gian worker, +1,4 % đầu-cuối, nên chấp nhận A11. R-9 (`api_keys` chưa RLS) hoãn theo A7, ghi vào "giới hạn" của đồ án. **Deploy cần A1 + A8 trước** |

**Chặng auth có thể đóng.** Việc còn lại thuộc Admin hoặc vận hành: A1 (role `hub_app` trên Neon), A2 (mail thật), A3 + TA11 (GitHub), A8 (`WEB_PROXY_SECRET`, `WEB_PUBLIC_URL`, kiểm IP trên Vercel), TA14 (trình duyệt thật). Không còn phát hiện mức Cao hay Trung bình nào đang mở.
