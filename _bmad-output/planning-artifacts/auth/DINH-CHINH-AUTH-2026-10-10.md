# Đính chính khi giao dev: SPEC-verification (VF1, VF2, VF7) rồi SPEC-auth (AU1–AU6)

> Ngày 10/10/2026 tối, party mode (Winston, Amelia, John, Sally, Mary cùng Admin).
> **File này THẮNG** `SPEC-auth.md` và `verification/SPEC-verification.md` ở mọi chỗ mâu thuẫn. Hai spec gốc vẫn là nguồn sự thật về *nội dung*; file này chỉ chốt **phạm vi, thứ tự, và những chỗ code hiện tại đã khác lúc viết spec**.
> Code nền: `master` sau `e3c2249` (SPEC-3 + 7 sửa sau review).

---

## 1. Quyết định của Admin

| # | Câu hỏi | Admin chốt |
|---|---|---|
| D1 | Thứ tự | **VF1 → VF2 → VF7**, review, rồi **AU1 → AU2 → AU3 → AU4 → AU5 → AU6**, review. Một agent, tuần tự |
| D2 | Dashboard khi AU1/AU3 đổi sang cookie và bắt buộc `?projectId=` | **Agent auth làm luôn phần ống nước web** (§3). Các màn mới để phiên UI |
| D3 | AU6 RLS | **Làm ngay đợt này**, không đợi đa service |
| D4 | Đa service S0–S14 | **Vẫn hoãn** (DINH-CHINH-2026-10-10 §0) |

## 2. Đa service đang hoãn → phần nào của auth bị cắt

| Chỗ trong SPEC-auth | Xử lý |
|---|---|
| §0.3 tiền đề `projects` + `api_keys` | AU1 **tự tạo `projects`** đúng khuôn §4.1 của SPEC đa service: `id, slug, name, environment, createdAt`, có enum `ProjectEnv`. Seed upsert `Project{id: DEFAULT_TENANT_ID, slug:'default', name:'Default', environment:'test'}` **trước** các bảng khác. **Không** tạo `api_keys` |
| Mọi thứ đụng API key: `scope_not_grantable` (UA19), route `manage:keys`, nút "Tạo key đầu tiên" ở onboarding, DX2 quickstart, chặn `hk_live_` khi chưa xác minh (một nửa UA28) | **Hoãn** tới S2. Ghi "hoãn" vào §12 SPEC-auth. `ROLE_SCOPES` **vẫn có** đủ các scope (kể cả `manage:keys`, `publish:events`), vì nó là hằng số dùng chung |
| `ApiKeyGuard` "dùng chung `@RequireScope`" | Thiết kế `Principal` và `@RequireScope` sao cho `kind:'key'` cắm vào được sau này. Chỉ làm nhánh `kind:'user'` |
| TA1 "đăng ký → event đầu tiên" + đồng hồ cà phê | Hoãn phần key/quickstart. TA1 dừng ở "đăng ký → vào dashboard project đầu tiên". Đồng hồ đo sau, khi có S2 + DX2 |
| §6 bảng route `/api/v1/projects/:projectId/keys` | Không làm |
| AU6 "sau S12" | Làm ngay (D3), trên các bảng nghiệp vụ hiện có. Bảng mới của đa service sau này phải tự thêm policy (ghi vào DINH-CHINH-2026-10-10 §2 khi xong) |

## 3. Ống nước web mà agent auth phải làm (D2)

**Làm** (đúng hợp đồng §9 SPEC-auth):
- Xoá `apps/web/src/lib/hub/token.ts`, bỏ Bearer.
- `client.ts`: URL tương đối, `credentials:'include'`, header `x-csrf-token` từ cookie `hub_csrf` cho method thay đổi dữ liệu. 401 → `/auth/refresh` kiểu single-flight → thử lại một lần → hỏng thì về `/login`.
- `next.config`: `rewrites` cho `/api/:path*` và `/auth/:path*` → `HUB_API_INTERNAL_URL`. Không rewrite `/hooks/*`.
- Mọi query gửi `projectId`.
- **Bộ chọn project tối thiểu:** dropdown từ `memberships` của `/auth/me`, nhớ lựa chọn trong `localStorage`. Chỉ lưu id project, **không** lưu token.
- Trang `/login` hiện có: đổi sang email + mật khẩu.
- Socket: xin `/auth/socket-ticket?projectId=` rồi kết nối với `auth:{ticket}`; đổi project thì kết nối lại.
- `npx tsc --noEmit` + build web sạch. Mọi trang dashboard hiện có vẫn chạy với operator.

**Không làm** (để phiên UI):
- `/register`, `/verify-email`, `/forgot-password`, `/reset-password`, `/invite`, `/onboarding`;
- trang Thành viên, trang Thiết bị;
- banner "chưa xác minh email";
- ẩn nút theo role.

Riêng `/register` và `/verify-email` được làm một **form trần** nếu cần để chạy TA14 trên trình duyệt thật. Ghi rõ là bản tạm.

## 4. Code hiện tại khác lúc viết spec

| # | Spec giả định | Thực tế (sau `e3c2249`) | Làm gì |
|---|---|---|---|
| 1 | ADR "số tiếp theo" | Số cuối là **067** (VF) | Bắt đầu từ **068**. Có phiên khác ghi song song → grep ngay trước khi ghi |
| 2 | Rate limit dùng "Lua `INCR+EXPIRE` sẵn có (ADR-054 mục 6)" | Ingest rate limit đã là 1 `EVAL` (S3-5); circuit + throttle gộp `EVAL` (ADR-064) | Tái dùng script `INCR+EXPIRE` của ingest. Rate limit auth chỉ ở đường console, không tính vào R1 |
| 3 | `CleanupJob` | Có, lock `cleanup:lock`, đã mở rộng nhiều lần | AU2 thêm bước dọn `auth_sessions` và `email_tokens` vào job này |
| 4 | Smoke / k6 / script review đăng nhập bằng `ADMIN_USERNAME` | `scripts/e2e-smoke.sh`, `k6/*` | AU1 sửa theo cookie + `OPERATOR_EMAIL` trong cùng commit. Smoke phải xanh sau mỗi story (cho tới khi VF4 thay smoke) |
| 5 | `withAudit` actor | `@CurrentUser()` trả username (`dev-amelia`, `admin`) | Sau AU1: actor = `user.id`, metadata kèm email đã che. Audit cũ giữ nguyên |
| 6 | Role DB | `docker/postgres/init/02-shop-user.sh` đã tạo `shop_user`; runtime đang dùng `hub_user` (owner + superuser) | AU6: thêm `03-hub-app.sh` (local) + migration cấp quyền. Compose đổi `DATABASE_URL` của api/worker sang `hub_app`; migrate dùng `DIRECT_URL` (owner). Ghi bước tạo role trên Neon vào DEPLOYMENT. **Lưu ý:** init script chỉ chạy trên volume mới, nên migration phải tự tạo role nếu chưa có (spec §5.12.1) |
| 7 | `.env` | Có `ADMIN_USERNAME` / `ADMIN_PASSWORD_HASH`, chưa có biến mới | Agent **được thêm** vào `.env` local (không commit): `OPERATOR_EMAIL=admin@hub.local`, `OPERATOR_PASSWORD_HASH` = **chép** từ `ADMIN_PASSWORD_HASH` (Admin giữ mật khẩu cũ), và `CSRF_SECRET`, `SOCKET_TICKET_SECRET`, `OAUTH_COOKIE_SECRET` (ngẫu nhiên ≥ 32 ký tự, khác nhau), `WEB_PUBLIC_URL`, `MAIL_DRIVER=log`. **Không** xoá hay sửa giá trị đã có. Báo lại Admin email operator |
| 8 | Mail capture | SPEC-verification §4.2 có `MAIL_DRIVER=capture` | AU2 làm 3 driver: `log`, `resend`, `capture` |
| 9 | Fake GitHub OAuth | VF4 mới có `fake-github` | AU5: unit test mock `fetch`, cho phép đặt `GITHUB_OAUTH_BASE_URL` (startup assert `https://github.com` khi production). TA11 thủ công, để sau |
| 10 | Lỗi định dạng DX1 | Chưa có DX1 | Dùng `{error, message}` |
| 11 | SPEC-verification §6 luật story | Có hiệu lực **từ khi VF2 xong** | AU1–AU6 phải theo §6: RED → GREEN → GATED → PROBED, commit có khối `Verify:`, mã test `[AU:UAxx]`. REVIEWED do phiên review làm |

## 5. Luật cho phiên dev (cộng thêm luật trong hai spec)

- Mỗi story một commit trên `master`. **Không push.** Commit kết thúc bằng `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- `npx jest -w 2`. Không chạy jest không giới hạn worker.
- **Stack dev** (`webhook-hub`): **không** `down -v`, được `up -d --build`.
- **Stack `hubv`** (sau VF1): được làm gì cũng được, kể cả kill, restart, `down -v`.
- **Không gửi Telegram/Discord thật.** Trên stack dev, subscription Telegram đang tắt, phải giữ tắt. `hubv` trỏ đích vào `/mock/*`.
- Không commit `.env`, `.env.verify.local`, hay `_bmad-output/tmp_template_extract.txt`. Không add file của phiên khác đang sửa: `_bmad-output/planning-artifacts/ui-revamp/README.md`, `SPEC-hub-multi-service.md`, memlog. `docs/adr/README.md` thì commit cả file (append-only) và ghi chú trong báo cáo.
- CI (VF7): viết `.github/workflows/verify.yml` và **chạy thử local** những gì chạy được (vd bằng `act` nếu có, hoặc chạy tay từng bước). Không push, nên CI thật chưa chạy. Câu Q-V2 (repo public hay private) chưa chốt.
- Hết **VF7**: dừng, báo cáo, chờ review. Hết **AU6**: báo cáo cuối.

## 6. Kết quả (dev điền)

| Story | Commit | Bằng chứng (`Verify:`) | Lệch / hoãn |
|---|---|---|---|
| VF1 | `3ea2cb5` | RED `[VF:VT13]` Received [] (stub) · `npm run verify:up` exit 0 (hubv: postgres 15433, redis 16379, AMQP **15673**, api 14000, shop 14001, sink 14100) · seed 3 source/3 subscription, Telegram/Discord → `/mock/*` ✓ · `bash scripts/e2e-smoke.sh` vào 14000 → OK (3 delivery SUCCEEDED) · VT8 `verify:selftest`: 9 container dev cùng ID trước/sau · VT9: `hubv_*` mất, `webhook-hub_*` còn | AMQP 15673 thay 15672 (trùng UI rabbit của dev) · shop 14001 thay 13001 (theo quy tắc +10000; 13001 trùng Grafana +10000) · web chỉ khi `VERIFY_WITH_WEB=1` (bundle nhúng URL API dev) · sink làm luôn ở VF1 (§8 #6) · seed vẫn là seed hiện có (chờ S12, X5) · ADR-068 |
| VF2 | `fabb67e` | RED `[VF:VT3]` Received [] · map trước khi gắn mã: 43 mồ côi · L0 373/0/0 · L1 55/0/0 (hubv) · VT1 `verify:db` khi hubv tắt → exit 1 "skip > 0 ở L1 (55)" · VT2 `it.skip` một test `[AF:#14]` → exit 1 "GIẢM 373 → 372" · map 198 mã, 0 mồ côi/ma/trùng | L0/L1 chia theo FILE (3 file trộn unit+DB chạy cả ở L1) · `acceptedOrphans` có lý do (9 dòng AF + VT15) · `doneOverrides` MS:U34–U45,U50 · 45 test cũ gắn mã (30 AF + 15 MS) · L2 chưa có (VF4) · ADR-069 |
| VF7 | `c96bf6b` | RED `[VF:VT7]` (stub) · gates repo thật 0 vi phạm / 7 ngoại lệ có lý do · probe `tools/hub-sim/probe.ts` import libs → exit 1 · CI chạy tay trong `node:22`: unit (npm ci, gates, L0 379/0/0) ✓, map ĐỎ vì spec nguồn chưa commit (có spec → xanh), db (migrate 5 + L1 55/0/0) ✓, gitleaks toàn lịch sử **3 phát hiện** (giá trị ví dụ trong spec, commit `0b2cef42`) | Không có `act` → chạy tay. CI thật CHƯA chạy (không push). Job e2e/chaos → VF8; bước role `hub_app` → AU6 · jest bỏ qua `.claude/` (worktree agent khác làm 34 suite chết) · ADR-070 |
| AU1 | `2564d5e` | RED UA6 401≠200, UA12, UA22 (stub) · L0 581/0/0 · L1 104/0/0 · TA1 TA3–TA7 6/6 trên hubv (đỏ trên stack dev code cũ: register 404) · TA3 lệch TB 1ms · probe P-AU-01,02,04,05,06,07 ĐỎ | Làm sớm (ADR-103): vé socket + membership tối thiểu + `/api/v1/projects` theo membership (tránh IDOR khi đã mở đăng ký); trang web chuyển `/login`,`/register` (trùng proxy `/auth/*`); danh sách mật khẩu = top 1000 ∪ 51 mục ≥10 ký tự; email operator **admin@hub.local** (hash chép từ ADMIN_PASSWORD_HASH, mật khẩu cũ) |
| AU2 | `20e8633` | RED mail 4/4, auth-mail-db 6/6 (stub); TA2/TA10 đỏ trên hubv AU1 · L1 111/0/0 · e2e 8/8 · probe P-AU-08,09,10 ĐỎ | Reset mật khẩu cũng đặt emailVerifiedAt (bấm link mail = sở hữu email; spec không nói) · trang `/verify-email` bản trần; `/forgot-password`, `/reset-password` để phiên UI |
| AU3 (+ web) | `eb2ac37` | RED UA20 32 route thiếu scope, UA17 · TA2/TA8/TA15 đỏ trên hubv AU2 · L0 594 · L1 112 · e2e 10/10 · probe P-AU-03,11,12,13,14 ĐỎ · web tsc + build sạch; proxy web kiểm qua :13000 (login, me, api, refresh, vé socket, CSRF 403) | Giữ tên `ProjectScopeGuard` (= ProjectAccessGuard); `GET …/keys` = read:project (lệch §6.1, chỉ prefix); `/api/v1/projects` GET/POST `@NoProjectScope`; sửa bug AU1 DI gateway (Pick<>) do TA8 bắt · TA14 (trình duyệt thật) mồ côi có lý do |
| AU4 | `3c426e3` | RED members-db 7/7 (stub); TA9 đỏ trên hubv AU3 (invite 404) · L1 119 · e2e 11/11 · probe P-AU-16,17,18,19 ĐỎ | `DELETE …/members/:userId` khai read:project (tự rời); xoá người khác kiểm manage:members trong service · capture mail ghi nguyên tử (TA9 từng đọc JSON dở) · không có trang `/invite`, Thành viên (phiên UI) |
| AU5 | `020396f` | RED github-oauth-db 10/10 (stub) · L1 129 · e2e 11/11 · curl `/auth/github` 503 (chưa cấu hình), callback state sai 400 · probe P-AU-20,21,22 ĐỎ | fetch giả thay fake-github (§4 #9) · TA11 mồ côi có lý do (cần OAuth App thật) · người mới về `/onboarding` (chưa có trang — phiên UI) |
| AU6 | `485b83d` | RED TA12 (hub_app thấy 122 dòng khi chưa có policy), UA30, UA31 · TA13 đỏ trên image AU5 · L0 597 · **L1 131/0/0 chạy bằng hub_app** · e2e 12/12 + smoke + demo dưới RLS · VT12 (owner → đỏ tiền đề) · probe P-BB5-02, P-AU-23, P-AU-24 ĐỎ; P-BB5-01 (repo quên lọc) test CÒN XANH | **p95 trước/sau: 25,46 → 27,39 ms (+7,6%)** — lần đo đầu +16,7% (vượt trần) → tra source lúc ingest đổi sang batch transaction · 3 bảng con policy EXISTS theo bảng cha · P-BB5-01 của spec tự mâu thuẫn (expectRed nhưng claim 'RLS vẫn chặn') · DoD3: `localStorage` giữ id project (DINH-CHINH §3 thắng §8.1) |

## 7. Kết quả review (phiên review điền)

| Chặng | Phát hiện | Mức | Trạng thái |
|---|---|---|---|
| AU1 | R-1 khoá email bị phá bằng request song song (17/18 lượt lọt) | Trung bình | đã sửa `275abbd` (ADR-109) |
| AU1 | R-2 rate limit theo IP sau proxy web thành giới hạn chung | Cao* | đã sửa `d237654` (ADR-110) |
| AU1 | R-6 register dò email qua Set-Cookie | Trung bình | đã sửa `3714d44` (ADR-120, §9 #1) |
| AU1 | R-10 login CSRF bằng form urlencoded | Thấp | đã sửa `1eb26a2` (ADR-114) |
| AU3 | R-3 socket không bị cắt khi bị xoá thành viên / logout-all | Trung bình | đã sửa `e43a60d` (ADR-112) |
| AU3 | R-8 guard mở mặc định, UA20 danh sách cứng | Trung bình | đã sửa `3dbb7cd` (ADR-113) |
| AU5 | R-12 GitHub: tài khoản đã gắn GitHub khác; P2002 → 500 | Thấp | đã sửa `8c61554` (ADR-116) |
| AU6 | R-4 per-call tx trên đường giao | Trung bình | đã đo + batch `4609265` (ADR-119): worker +33 % → +16,8 %, đầu-cuối +1,4 % |
| AU6 | R-7 migration dữ liệu trên Neon bị FORCE RLS chặn | Cao (vận hành) | đã sửa `c05299f` (gate + ADR-111); A1 vẫn là việc Admin |
| AU6 | R-9 `api_keys` không bật RLS | Thấp | hoãn — CAN-ADMIN-QUYET A7 |
| UI | R-5 link mail và `/onboarding` → 404 | Trung bình | đã sửa `81f6e2f` (ADR-115) |
| — | R-11 demo bước 3 · R-13 lệch nhỏ · R-14 trần project | Thấp | đã sửa `baadc21` · `e8a6594` (ADR-117) · `4244c64` (ADR-118) |

## 8. Xung đột SPEC-verification × SPEC đa service: Admin chốt (10/10, chuyển qua phiên webhook-hub-54)

| # | Chỗ | Bên thắng / làm gì | Ở story |
|---|---|---|---|
| 1 | Script jest | `verify:unit`/`verify:db` tự gắn `-w 2`; chỉ CI được ghi đè | VF2 |
| 2 | `verify:map` với U34–U45, U50 | Đã làm ở SPEC-3/S3-2. Thêm bảng ghi đè `MS:U34..U45,U50` → `AF:S3-2 (done)` trong `verify/spec-sources.json` | VF2 |
| 3 | Endpoint của Shop | **Đa service thắng** (S11/T11): Shop tự đăng ký. Sau S11, `verify:seed` không seed endpoint Shop; trước S11 giữ như hiện nay | VF1/VF4, S11 |
| 4 | Hai seed cho cùng thế giới | Gộp làm một: `verify:seed` = seed S12 (`cafe`/`bookstore`) + phần riêng của verify (project `demo`, user theo role, key cố định theo `VERIFY_SEED`) | VF1, S12 |
| 5 | E2E T1–T15 đa service | **Verify thắng**: chạy trên `hubv` (cổng 14000) bằng runner TS; không `down -v` stack dev; đăng nhập bằng cookie operator sau AU1 | VF4, khi mở lại đa service |
| 6 | Đích nhận thử | Service **sink** trong `hubv`: trả challenge, ghi lại request và có API đọc lại, `?mode=fail` / `?mode=slow`. `/mock/*` giữ cho Telegram/Discord | VF4 (hoặc VF1) |
| 7 | Đường dẫn ingest | `/hooks/<provider>/<sourceKey>`. Viết `/hooks/<sourceId>` ở SPEC-verification §5.2 là sai | VF3 |
| 8 | T10 noisy neighbor có số đo | Tầng L4: local, chạy tay, không vào CI. Phần chức năng của T10 vẫn ở L2 | VF4/VF5 |

## 9. Đính chính sau review AU (2026-10-11, REVIEW-AUTH R-1..R-14)

| # | Spec cũ | Giờ (thắng spec) | ADR |
|---|---|---|---|
| 1 | §5.2 + §6: register 201 kèm cookie phiên (đăng nhập luôn) | register 201 `{ok,message}` cố định, **không cookie**; tài khoản mật khẩu chưa xác minh login → 401 `invalid_credentials`; `POST /auth/verify-email` xác minh **và** đặt cookie phiên. TA1 = đăng ký → bấm link → console; TA2 = login trước xác minh 401 | ADR-120 |
| 2 | §5.5 rate limit theo IP | sau proxy web, IP lấy từ `x-hub-client-ip` kèm `WEB_PROXY_SECRET` (biến mới ở hub-api + web) | ADR-110 |
| 3 | §5.7 socket chỉ kiểm lúc handshake | socket bị ngắt khi logout/logout-all/thu hồi thiết bị/đổi-đặt lại mật khẩu/bị xoá khỏi project (ngay ở instance đó, ≤ 30 s ở instance khác) | ADR-112 |
| 4 | UA20 quét 4 controller | mọi route của mọi controller khai `@RequireScope`/`@NoProjectScope`/`@PublicRoute`; guard thiếu khai báo → 500 | ADR-113 |
| 5 | (không có) | `/auth/login`, `/auth/register` chỉ nhận `application/json` (415) · trần project 3/10 · migration dữ liệu sau RLS phải `SET LOCAL app.rls_system='on'` | ADR-114, 118, 111 |
| 6 | (sau vòng 2, N-1) `POST /auth/verify-email {token}` | tài khoản mật khẩu chưa xác minh: `{token}` → 400 `password_required` (token chưa đốt); `{token, password, name?}` → đặt mật khẩu mới + xoá dấu vết người trước (tên, githubId, token/lời mời chờ, phiên, key project riêng). Reset mật khẩu trên tài khoản chưa xác minh cũng vậy | ADR-121 |
