# SPEC — Đăng ký, đăng nhập, phân quyền theo project, RLS

> **Đường dẫn:** `C:\webhook-hub\_bmad-output\planning-artifacts\auth\SPEC-auth.md`
> **Ngày:** 2026-10-10 · **Trạng thái:** sẵn sàng để dev, nhưng **chưa bắt đầu** khi phiên khác còn đang làm SPEC-3 (`audit-fix-2026-10-10/SPEC-3-dung-chuan.md`)
> **Nguồn quyết định:** ADR-056 (đảo ADR-038: có đăng ký) + ADR-057 (chi tiết, ghi cùng ngày) trong `docs/adr/README.md`
> **Spec này đứng riêng.** Không sửa `SPEC-hub-multi-service.md`, `DINH-CHINH-2026-10-10.md`, `SPEC-3`. Chỗ nào mâu thuẫn với các file đó thì xem §2.3 để biết file nào thắng.
> **Ai đọc:**
> - **Phiên DEV:** đọc §0 → §7, làm AU1 → AU6, đánh dấu ở §10.
> - **Phiên TEST:** đọc §0–§2, rồi chạy §8 và ghi kết quả vào §11.
> - **Phiên UI (`ui-revamp`):** đọc §2, §5.9 và §9 (hợp đồng cho web).

---

## 0. Đọc trước khi làm

1. `CLAUDE.md` (BB-1..BB-5). Luật phiên dev:
   - mỗi story một commit, trên `master`, không push;
   - chạy `npx jest -w 2`;
   - ADR lấy số tiếp theo còn trống, kiểm ngay trước khi ghi;
   - mọi so sánh bí mật dùng `crypto.timingSafeEqual`.
2. Schema hiện có thay đổi bằng **migration mới** trong `libs/database/prisma/migrations/`, không dùng `db push` (DINH-CHINH §2 dòng 2).
3. **Tiền đề:** đã có `projects` + `api_keys` (S1 của SPEC-hub-multi-service). Nếu chưa có thì AU1 tự tạo bảng `projects` đúng như §4.1 của spec đó, để hai spec không đẻ ra hai bảng khác nhau.
4. Tài liệu chuẩn mà spec này bám: OWASP ASVS v4 (chương V2 Authentication, V3 Session, V4 Access Control), OWASP Cheat Sheets (Authentication, Session Management, Forgot Password, CSRF), RFC 6749 + RFC 9700 (OAuth 2.0 Security BCP). Gặp chỗ spec không nói thì **làm theo cheat sheet**, rồi ghi ADR.

## 1. Vì sao và Admin đã chốt gì

> Admin, 10/10: "Chúng ta demo cho hội đồng, phần quan trọng nhất bao giờ cũng là ban đầu vào đăng ký đăng nhập ra sao." … "Đã có đăng ký và đăng nhập thì bảo mật là điều bắt buộc. Cứ làm JWT như các ứng dụng bình thường, bảo mật đúng chuẩn."

**Hiện trạng** (`apps/hub-api/src/modules/auth/*`, khoảng 200 dòng):
- một admin duy nhất, danh tính nằm trong env `ADMIN_USERNAME` / `ADMIN_PASSWORD_HASH`;
- JWT gắn cứng `tenantId: DEFAULT_TENANT_ID`;
- web lưu JWT trong `localStorage` (`apps/web/src/lib/hub/token.ts`);
- không có bảng `users`, không có refresh, không thu hồi được phiên;
- SPEC đa service mới mô tả **danh tính của máy** (API key + scope). **Danh tính của người** bị bỏ trống, và `?projectId=` của admin sẽ thành IDOR ngay khi có người thứ hai.

| # | Câu hỏi | Admin chốt |
|---|---|---|
| Q1 | Xác minh email | **Làm thật.** Admin cung cấp key mail |
| Q2 | Đăng nhập GitHub | **Có** |
| Q3 | Mời thành viên vào project | **Có**: Owner mời qua link gửi email |
| Q4 | RLS | **Bắt buộc.** Thay S13 (vốn tuỳ chọn) của SPEC đa service |
| Q5 | Giữ token ở đâu | "Session cookie, hoặc access/refresh ở Redis, cái nào cũng được". Phòng chọn phương án ở §4 và lý do ở ADR-057 |

**"DB cho từng người" nghĩa là gì trong spec này:** không có database hay schema riêng cho từng người hoặc từng project. Mọi project dùng chung schema `hub`. Mỗi bảng nghiệp vụ mang `tenant_id` (= project id). Người dùng thuộc project qua bảng `project_members`. Việc cô lập được giữ bởi **ba lớp**, lớp sau bắt được cái lớp trước để lọt:

```
(1) Guard: người/key có thuộc project trong URL không?   → không: 404
(2) TenantScopedRepository: mọi query mang tenant_id     (BB-5, đã có)
(3) Postgres RLS: kể cả code quên (2), DB trả 0 dòng      (AU6)
```

Đã bác DB/schema riêng mỗi project (kiểu RabbitMQ vhost): Prisma `multiSchema` khai báo tĩnh, nên migrate phải chạy N lần, pool nhân N, và giới hạn connection của Neon free hết ngay.

**Ngoài phạm vi:** Organization/team phía trên project · billing · 2FA/TOTP (ghi "hướng phát triển") · SSO SAML · đăng nhập Google · passkey · đăng nhập cho `apps/shop` (Shop vẫn không đăng nhập, mục "Chống phình Shop" của ARCHITECTURE giữ nguyên).

---

## 2. Mô hình

### 2.1 Thuật ngữ

| Từ | Nghĩa | Lưu ở |
|---|---|---|
| **User** | Người đăng nhập console. Có email (duy nhất), có thể có mật khẩu, có thể liên kết GitHub | `hub.users` |
| **Membership** | User X là thành viên project P với role R | `hub.project_members` |
| **Role** | `owner` · `developer` · `viewer`. **Role là một bó scope có tên** (§2.2) | cột `role` |
| **Session** | Một lần đăng nhập trên một thiết bị. Có refresh token xoay vòng | `hub.auth_sessions` |
| **Operator** | Người vận hành toàn hub, kế thừa admin env cũ. Giống tài khoản root của AWS: dùng để seed và cứu hộ, ngày thường không dùng | `users.is_operator = true` |
| **Principal** | "Ai đang gọi": `{kind: 'user' \| 'key', id, tenantId, scopes[]}`. Guard nào cũng đổ về một Principal | `request.principal` |

### 2.2 Role = bó scope (cùng ngôn ngữ quyền với API key)

Đây là ý chốt của phòng: **người và máy chỉ dùng một ngôn ngữ quyền.** `@RequireScope('manage:endpoints')` không cần biết người gọi là user đăng nhập hay service cầm `hk_live_`.

| Scope | viewer | developer | owner | API key được cấp? |
|---|:-:|:-:|:-:|:-:|
| `read:project` (xem event, delivery, source, endpoint, số liệu; không lộ secret) | ✔ | ✔ | ✔ | ✘ (key dùng `read:events`) |
| `read:events` | ✔ | ✔ | ✔ | ✔ |
| `publish:events` | | ✔ | ✔ | ✔ |
| `manage:endpoints` | | ✔ | ✔ | ✔ |
| `manage:sources` | | ✔ | ✔ | ✔ |
| `replay:deliveries` | | ✔ | ✔ | ✘ |
| `manage:keys` | | ✔ | ✔ | **✘ không bao giờ** |
| `manage:members` | | | ✔ | **✘** |
| `manage:project` (đổi tên, xoá project) | | | ✔ | **✘** |

- Tạo API key xin `manage:keys` / `manage:members` / `manage:project` / `read:project` / `replay:deliveries` → **422 `scope_not_grantable`**. Máy không được tự đúc key hay tự thêm người, để chặn leo thang đặc quyền.
- Bảng này là **một hằng số duy nhất**: `libs/common/src/auth/roles.ts` → `ROLE_SCOPES`. Guard, web, docs đều đọc từ đây.

### 2.3 Quan hệ với spec khác (file nào thắng)

| Chỗ | Spec khác nói | Spec này đổi thành | Thắng |
|---|---|---|---|
| SPEC đa service §2 "Admin đăng nhập bằng JWT như hiện nay" | một admin JWT | user + membership; admin cũ → operator | **Spec này** |
| SPEC đa service §4.3A route console `/api/v1/*` + `?projectId=` mặc định `DEFAULT_TENANT_ID` | admin thấy mọi project | `?projectId=` **bắt buộc**, đi qua `ProjectAccessGuard` (§5.6). Thiếu → 400 `project_required`. Không còn giá trị mặc định | **Spec này** |
| SPEC đa service §4.3A `GET/POST /api/v1/projects` | admin liệt kê tất cả | chỉ project mình là thành viên; tạo xong mình là owner | **Spec này** |
| SPEC đa service S13 RLS "tuỳ chọn" | tuỳ chọn | **bắt buộc**, là AU6 | **Spec này** |
| ARCHITECTURE §7.4 "một admin user", §9 cắt "refresh token rotation" | | AU1 sửa hai chỗ này trong ARCHITECTURE cùng commit | **Spec này** (sửa ARCHITECTURE cho khớp) |
| SPEC-dev-experience DX2 Quickstart | đồng hồ tính từ lúc có connection string | đồng hồ bắt đầu **từ lúc bấm Đăng ký** (§5.8) | **Spec này** |
| ADR-035 Socket.IO room theo tenant trong JWT | room lấy từ JWT | JWT không còn chở tenant; client xin vào room, server kiểm membership (§5.7) | **Spec này** |

---

## 3. Hiện trạng code phải đụng

| File | Hiện tại | Story |
|---|---|---|
| `apps/hub-api/src/modules/auth/auth.service.ts` | login so env, ký `{sub:'admin', tenantId}` | AU1 |
| `apps/hub-api/src/modules/auth/jwt-auth.guard.ts` | đọc Bearer, gắn tenantId từ payload | AU1, AU3 |
| `apps/hub-api/src/modules/auth/current-tenant.decorator.ts` | đọc tenantId từ JWT | AU3 (đọc từ `request.principal`) |
| `apps/hub-api/src/modules/realtime/realtime.gateway.ts` | room `tenant:<id>` lấy từ JWT | AU3 |
| `apps/hub-api/src/main.ts` | `rawBody: true`, CORS | AU1 (cookie-parser, helmet, CORS có credentials) |
| `libs/database/src/seed.ts` | seed theo `DEFAULT_TENANT_ID` | AU1 (seed operator + membership owner của project `default`) |
| `libs/database/src/tenant-scoped.repository.ts` (tên thật kiểm lại) | query có `tenant_id` | AU6 (bọc `set_config`) |
| `.env.example`, `docs/DEPLOYMENT.md` | `ADMIN_USERNAME`, `ADMIN_PASSWORD_HASH`, `JWT_SECRET` | AU1 (§7) |
| `apps/web/src/lib/hub/token.ts` | JWT trong `localStorage` | **phiên UI**, §9 |

---

## 4. Token: chọn cái gì và vì sao

Admin cho chọn giữa session cookie và access/refresh trong Redis. Phòng chọn:

| Thứ | Ở đâu | Sống bao lâu | Vì sao |
|---|---|---|---|
| **Access token** | JWT HS256 trong cookie `__Host-hub_at` (HttpOnly, Secure, SameSite=Lax, Path=/) | **15 phút** | đúng "JWT như ứng dụng bình thường"; HttpOnly nên XSS không đọc được (khác `localStorage` hiện nay) |
| **Refresh token** | chuỗi ngẫu nhiên 32 byte trong cookie `__Host-hub_rt`; DB chỉ lưu **sha256** ở `auth_sessions` | idle 7 ngày, tuyệt đối 30 ngày | **xoay vòng mỗi lần dùng + phát hiện dùng lại** (§5.3) |
| **CSRF token** | cookie `hub_csrf` (không HttpOnly) + header `x-csrf-token` | theo session | double-submit, có ký (§5.4) |
| **Redis** | chỉ dùng cho **rate limit** | | |

**Vì sao refresh token nằm ở Postgres chứ không phải Redis** (ghi vào ADR-057):
1. **BB-2:** Redis "được phép sai". Nếu refresh token chỉ sống trong Redis thì Redis mất dữ liệu sẽ mất luôn **lịch sử xoay vòng**. Phát hiện dùng lại (dấu hiệu token bị đánh cắp) trở nên mù, và đó là *sai về bảo mật*, không chỉ là chậm.
2. **Thu hồi tức thì:** mỗi request console vốn đã tra Postgres để lấy membership (§5.6). Gộp kiểm `auth_sessions.revoked_at` vào cùng truy vấn đó là đăng xuất, đổi mật khẩu, hay bị kick đều có hiệu lực ngay, không cần denylist trong Redis.
3. **Quota Upstash:** không tốn thêm lệnh Redis cho mỗi request console.

Đánh đổi: thêm một lần đọc Postgres theo khoá chính cho mỗi request console. Console ít request nên chấp nhận được, và không đụng đường ingest.

**Bẫy triển khai:** web chạy ở Vercel, API chạy ở Render, tức **khác site**. Cookie bên thứ ba bị Safari ITP và Chrome chặn. Vì vậy web phải **proxy** `/api/*` và `/auth/*` qua Next.js `rewrites` sang Render, để cookie là cookie của chính domain web. Socket.IO thì không đi qua rewrites được, nên dùng **vé socket** (§5.7).

---

## 5. Thiết kế

### 5.1 Schema (migration mới, schema `hub`)

```prisma
enum MemberRole  { owner developer viewer          @@schema("hub") }
enum TokenPurpose { verify_email reset_password invite  @@schema("hub") }

model User {
  id              String    @id @default(uuid()) @db.Uuid
  email           String    @unique @db.VarChar(254)   // luôn lưu dạng trim + lowercase
  name            String    @db.VarChar(100)
  passwordHash    String?   @map("password_hash")       // null = chỉ đăng nhập GitHub
  emailVerifiedAt DateTime? @map("email_verified_at") @db.Timestamptz(6)
  githubId        String?   @unique @map("github_id") @db.VarChar(32)  // id số của GitHub, KHÔNG dùng login (đổi được)
  isOperator      Boolean   @default(false) @map("is_operator")
  passwordChangedAt DateTime? @map("password_changed_at") @db.Timestamptz(6)
  createdAt       DateTime  @default(now()) @map("created_at") @db.Timestamptz(6)
  @@map("users") @@schema("hub")
}

model ProjectMember {
  tenantId  String     @map("tenant_id") @db.Uuid      // project
  userId    String     @map("user_id") @db.Uuid
  role      MemberRole
  createdAt DateTime   @default(now()) @map("created_at") @db.Timestamptz(6)
  @@id([tenantId, userId])
  @@index([userId])
  @@map("project_members") @@schema("hub")
}

model AuthSession {
  id           String    @id @default(uuid()) @db.Uuid   // = claim `sid` trong access token
  userId       String    @map("user_id") @db.Uuid
  familyId     String    @map("family_id") @db.Uuid      // mọi token sinh ra từ một lần đăng nhập
  tokenHash    String    @unique @map("token_hash") @db.Char(64)
  replacedById String?   @map("replaced_by_id") @db.Uuid
  rotatedAt    DateTime? @map("rotated_at") @db.Timestamptz(6)
  revokedAt    DateTime? @map("revoked_at") @db.Timestamptz(6)
  revokeReason String?   @map("revoke_reason") @db.VarChar(32) // logout|logout_all|password_changed|reuse_detected|removed
  idleExpiresAt     DateTime @map("idle_expires_at") @db.Timestamptz(6)
  absoluteExpiresAt DateTime @map("absolute_expires_at") @db.Timestamptz(6)
  userAgent    String?   @map("user_agent") @db.VarChar(255)
  ip           String?   @db.VarChar(45)
  createdAt    DateTime  @default(now()) @map("created_at") @db.Timestamptz(6)
  @@index([userId]) @@index([familyId])
  @@map("auth_sessions") @@schema("hub")
}

model EmailToken {
  id        String       @id @default(uuid()) @db.Uuid
  purpose   TokenPurpose
  email     String       @db.VarChar(254)
  userId    String?      @map("user_id") @db.Uuid
  tenantId  String?      @map("tenant_id") @db.Uuid     // chỉ cho invite
  role      MemberRole?                                 // chỉ cho invite
  invitedBy String?      @map("invited_by") @db.Uuid
  tokenHash String       @unique @map("token_hash") @db.Char(64)
  expiresAt DateTime     @map("expires_at") @db.Timestamptz(6)
  usedAt    DateTime?    @map("used_at") @db.Timestamptz(6)
  createdAt DateTime     @default(now()) @map("created_at") @db.Timestamptz(6)
  @@index([email, purpose])
  @@map("email_tokens") @@schema("hub")
}

model AuthAudit {                       // sự kiện cấp user, không thuộc project nào
  id        String   @id @default(uuid()) @db.Uuid
  userId    String?  @map("user_id") @db.Uuid
  action    String   @db.VarChar(64)
  ip        String?  @db.VarChar(45)
  meta      Json?
  createdAt DateTime @default(now()) @map("created_at") @db.Timestamptz(6)
  @@index([userId, createdAt(sort: Desc)])
  @@map("auth_audit") @@schema("hub")
}
```

- Khoá ngoại: `project_members → users ON DELETE CASCADE`, `project_members → projects ON DELETE CASCADE`, `auth_sessions → users CASCADE`.
- **Bảng danh tính** (`users`, `project_members`, `auth_sessions`, `email_tokens`, `auth_audit`, `projects`, `api_keys`) **không** đi qua `TenantScopedRepository`. Lý do: chúng được tra *trước khi* biết tenant. Truy cập qua **một** lớp `IdentityRepository` (`libs/database/src/identity.repository.ts`) với các hàm có tên rõ ràng. Mỗi hàm mới phải có unit test.
- **Dữ liệu cũ:** seed tạo operator từ `OPERATOR_EMAIL` + `OPERATOR_PASSWORD_HASH`, `email_verified_at = now()`, rồi thêm membership `owner` của project `default`. Không mất dữ liệu nào.

### 5.2 Mật khẩu, email, chống dò

| Quy tắc | Giá trị |
|---|---|
| Băm | `bcryptjs` cost **12** (đã có dependency). Đo trên máy local, mục tiêu khoảng 250ms |
| Độ dài | tối thiểu 10 ký tự, **tối đa 72 byte UTF-8** (bcrypt cắt ở 72 byte; vượt → 422 `password_too_long`, không cắt ngầm) |
| Mật khẩu yếu | từ chối nếu nằm trong danh sách 1.000 mật khẩu phổ biến nhất (`libs/common/src/auth/common-passwords.txt`) hoặc chứa nguyên phần trước `@` của email → 422 `password_weak` |
| Email | `trim().toLowerCase()`, regex đơn giản, tối đa 254 ký tự |
| Sai email hay sai mật khẩu | **cùng** 401 `invalid_credentials`, cùng body, cùng thời gian: email không tồn tại thì vẫn chạy `bcrypt.compare` với một hash giả cố định |
| Đăng ký email đã tồn tại | **vẫn trả 201 giống hệt**, rồi gửi mail "có người vừa thử đăng ký bằng email của bạn" cho chủ email. Không lộ email nào đã có tài khoản |
| Quên mật khẩu | luôn 202 `{ok:true}`, dù email có tồn tại hay không |
| Log | **không bao giờ** log mật khẩu, token, cookie, header `authorization`. Email trong log che dạng `n***@gmail.com` |

### 5.3 Phiên: đăng nhập, xoay vòng, phát hiện dùng lại

**Đăng nhập thành công** (mật khẩu hoặc GitHub):
1. Tạo `auth_sessions` với `familyId` mới.
2. Ký access JWT `{sub:userId, sid:sessionId, iss:'webhook-hub', aud:'console', iat, exp:+15m}`. Khi verify thì **ghim** `algorithms:['HS256']`, kiểm `iss` và `aud`.
3. Set 3 cookie (§4). Body trả `{user:{id,email,name,emailVerified}, memberships:[{projectId,slug,name,role}]}`. **Không** trả token trong body.

**`POST /auth/refresh`** (dùng cookie `__Host-hub_rt`), trong **một transaction Postgres**:
1. `SELECT … FROM auth_sessions WHERE token_hash = sha256(rt) FOR UPDATE`.
2. Không tìm thấy → 401 `session_expired`.
3. Đã `revokedAt` → 401 `session_expired`.
4. Đã `rotatedAt` (token cũ bị dùng lại):
   - nếu dùng lại trong vòng **5 giây** sau khi xoay → 401 `refresh_race`, **không** thu hồi (hai tab cùng refresh);
   - quá 5 giây → **thu hồi cả family** (`revoke_reason='reuse_detected'`), ghi `auth_audit` `session.reuse_detected` → 401 `session_expired`.
5. Quá `idleExpiresAt` hoặc `absoluteExpiresAt` → 401.
6. Hợp lệ: đánh dấu dòng cũ `rotatedAt=now()`, `replacedById`; tạo dòng mới cùng `familyId`, `idleExpiresAt = now+7d`, `absoluteExpiresAt` **giữ nguyên** của family; set cookie mới.

| Sự kiện | Thu hồi |
|---|---|
| `POST /auth/logout` | session hiện tại |
| `POST /auth/logout-all` | mọi session của user |
| Đổi mật khẩu | mọi session **trừ** session hiện tại |
| Reset mật khẩu qua email | **mọi** session |
| Bị xoá khỏi project | không thu hồi session; request tiếp theo vào project đó → 404 (§5.6) |
| Operator khoá user (tuỳ chọn) | mọi session |

Dọn dẹp: `CleanupJob` sẵn có của hub-worker xoá `auth_sessions` hết hạn quá 30 ngày và `email_tokens` hết hạn quá 7 ngày. **Mở rộng job sẵn có**, không tạo job mới (DINH-CHINH §2 dòng 7).

### 5.4 CSRF, cookie, header

- Cookie dùng tiền tố `__Host-` nên bắt buộc Secure, Path=/, không có Domain. Trên `http://localhost`, Chrome và Firefox coi localhost là secure context nên vẫn nhận cookie Secure. Phiên test phải kiểm lại điều này trên trình duyệt thật (TA14).
- **CSRF:** mọi request `POST/PUT/PATCH/DELETE` tới `/api/v1/*` và `/auth/*` (trừ `login`, `register`, `forgot-password`, `reset-password`, `verify-email`, OAuth callback) phải có header `x-csrf-token` khớp cookie `hub_csrf`.
  - Giá trị = `base64url(random16) + "." + HMAC_SHA256(CSRF_SECRET, sid + random16)`. Server kiểm cả việc khớp cookie **lẫn** chữ ký gắn với `sid`, để chống cookie tossing.
  - Sai hoặc thiếu → 403 `csrf_failed`.
- **API service `/v1/p/*` dùng Bearer, không dùng cookie**, nên không cần CSRF và không đổi gì.
- `helmet()` trên hub-api. CORS cho `/api/v1/*` và `/auth/*`: chỉ `WEB_PUBLIC_URL`, `credentials:true`. `/v1/p/*` và `/hooks/*` giữ nguyên như hiện tại.
- Trang web nhận token qua URL (`/verify-email?token=`, `/reset-password?token=`, `/invite?token=`) phải đặt `Referrer-Policy: no-referrer`, POST token ngay, rồi xoá query bằng `history.replaceState`.

### 5.5 Rate limit (Redis là đường tắt, BB-2)

| Đích | Giới hạn | Khoá Redis |
|---|---|---|
| `POST /auth/login` theo IP | 20 lần / 15 phút | `rl:login:ip:<ip>` |
| `POST /auth/login` theo email (kể cả email **không** tồn tại) | 5 lần sai / 15 phút → khoá email đó 15 phút | `rl:login:em:<sha256(email)>` |
| `POST /auth/register` theo IP | 5 / giờ | `rl:reg:ip:<ip>` |
| `forgot-password`, `resend-verification` theo email | 1 / phút, 5 / ngày | `rl:mail:<purpose>:<sha256(email)>` |
| `POST /auth/refresh` theo IP | 60 / phút | `rl:refresh:ip:<ip>` |

- Vượt → 429 `too_many_attempts` + header `Retry-After`. Body giống nhau dù email có tồn tại hay không, nên khoá theo email không lộ tài khoản.
- **Redis chết → fallback bộ đếm trong bộ nhớ của từng instance** (Map có TTL). Giới hạn lỏng hơn vì chia theo instance, nhưng **không tắt hẳn**. Ghi log cảnh báo tối đa một lần mỗi phút.
- Dùng lại script Lua `INCR+EXPIRE` sẵn có (ADR-054 mục 6), một lệnh mỗi lần kiểm.
- IP lấy từ `X-Forwarded-For` **chỉ khi** `TRUST_PROXY=1` (Render, Vercel). Ngược lại dùng socket address.

### 5.6 Phân quyền: Principal, guard, operator

```
Request console (cookie)                  Request service (Bearer hk_)
   SessionGuard                              ApiKeyGuard (SPEC đa service §4.3)
   ├─ verify JWT (alg, iss, aud, exp)        └─ principal = {kind:'key', tenantId, scopes}
   ├─ 1 query: session còn sống?
   └─ principal = {kind:'user', id}
   ProjectAccessGuard (route có :projectId hoặc ?projectId=)
   ├─ 1 query: membership(user, project)
   ├─ không phải thành viên / project không tồn tại → 404 not_found (CÙNG body)
   └─ principal.tenantId, principal.scopes = ROLE_SCOPES[role]
                        ↓
              @RequireScope('x')  — một decorator cho cả hai loại principal
              thiếu → 403 missing_scope {required:'x'}
```

- **Gộp truy vấn:** `SessionGuard` và `ProjectAccessGuard` có thể dùng chung **một** query join `auth_sessions` × `project_members` × `projects`. Phiên dev chọn cách làm, đo, và ghi ADR nếu tách ra.
- `@CurrentTenant()` đọc `request.principal.tenantId`, **không bao giờ** đọc từ JWT hay body.
- **Thứ tự lỗi** khớp `ApiKeyGuard`: 401 (chưa đăng nhập hoặc phiên chết) → 404 (không thuộc project) → 403 (thiếu scope) → 404 (tài nguyên `:id` không thuộc project).
- **Quy tắc owner:** không được xoá hay hạ quyền **owner cuối cùng** của project → 409 `last_owner`. Owner tự rời project cũng theo quy tắc này. Chỉ owner gán được role owner.
- **Operator:**
  - thấy mọi project và được coi như owner;
  - **mỗi** request vào project mà operator không phải thành viên thật đều ghi `audit_logs` action `operator.access` (tenant = project đó);
  - operator không đăng nhập bằng GitHub được (chỉ mật khẩu), giảm bề mặt tấn công;
  - không có API nào biến user thường thành operator. Chỉ seed hoặc SQL tay.
- **User chưa xác minh email** được: đăng nhập, dùng project đầu tiên, tạo key `hk_test_`. **Không** được: mời thành viên, tạo project `environment=live`, tạo key `hk_live_` → 403 `email_not_verified`. Cách này giữ được Quickstart 60 giây mà vẫn chặn lạm dụng (giống Stripe test mode).

### 5.7 Socket.IO

- `GET /auth/socket-ticket?projectId=` (cookie + `ProjectAccessGuard`, scope `read:project`) → `{ticket}`. Ticket là JWT `{sub, sid, tid:projectId, aud:'socket', exp:+60s}`, ký bằng `SOCKET_TICKET_SECRET` (khác `JWT_SECRET`).
- Client kết nối thẳng tới Render với `auth:{ticket}`. Middleware verify (alg, aud, exp) **và** kiểm lại session còn sống. Hợp lệ thì join room `project:<tid>`.
- Đổi project trên web = ngắt kết nối, xin vé mới. Một socket chỉ ở **một** room project.
- Không cần Redis, không cần lưu vé một lần dùng: vé chỉ sống 60 giây và vẫn bị kiểm session.

### 5.8 Luồng đăng ký → event đầu tiên (màn demo)

```
POST /auth/register {email, password, name}
  → user (chưa xác minh) + project đầu tiên + membership owner     [một transaction]
  → gửi mail xác minh (không chờ mail gửi xong mới trả response)
  → set cookie → 201 {user, memberships:[{…role:'owner'}]}
Web chuyển sang màn Onboarding:
  [Tạo key đầu tiên] → POST /api/v1/projects/:id/keys (DX2 trả quickstart 3 ô copy)
  → dev chạy lệnh → event hiện realtime
```

- Slug project đầu tiên: từ `name` (bỏ dấu tiếng Việt, kebab), trùng thì thêm `-xxxx` ngẫu nhiên. Tên `"<name>'s project"`.
- Mail xác minh gửi **sau COMMIT** (giống BB-3: không làm việc ra ngoài trước khi dữ liệu chắc chắn). Gửi lỗi thì log và để user bấm "gửi lại", **không** rollback đăng ký.
- Đồng hồ của DX2 (TX2) tính **từ lúc bấm Đăng ký**. Cược cà phê giữ nguyên: Sally 60 giây, Winston 90 giây.

### 5.9 Email

- Interface `MailSender { send({to, subject, html, text}) }` ở `libs/common/src/mail/`. Hai driver:
  - `MAIL_DRIVER=log` (mặc định ở local): in link ra logger ở mức info. Test E2E đọc link từ log;
  - `MAIL_DRIVER=resend`: gọi API Resend bằng `RESEND_API_KEY` (Admin cung cấp). Admin dùng nhà khác (Brevo, SendGrid…) thì viết thêm một driver, giao diện không đổi.
- **Bẫy Resend:** chưa xác minh domain thì chỉ được gửi tới **email của chính chủ tài khoản Resend** (địa chỉ gửi `onboarding@resend.dev`). Muốn demo đăng ký bằng email của thành viên hội đồng thì phải xác minh một domain (DNS), hoặc demo bằng email của Admin. Ghi vào `docs/DEPLOYMENT.md`.
- Ba mẫu mail (tiếng Việt, có bản text thuần): xác minh email (link 24 giờ), đặt lại mật khẩu (1 giờ), lời mời vào project (7 ngày). Thêm mail "có người thử đăng ký bằng email của bạn" (§5.2).
- Token trong link: 32 byte ngẫu nhiên base64url, DB lưu sha256, **dùng một lần** bằng `UPDATE … SET used_at=now() WHERE id=? AND used_at IS NULL` và kiểm số dòng bị ảnh hưởng = 1.
- Link trỏ về web: `${WEB_PUBLIC_URL}/verify-email?token=…`. Web POST token lên API.
- Gửi mail lại cho cùng mục đích → token cũ chưa dùng của email đó bị vô hiệu (set `used_at`).

### 5.10 Đăng nhập GitHub (OAuth 2.0 authorization code)

- Admin tạo một **GitHub OAuth App** (khác với webhook secret của adapter GitHub). Callback: `${WEB_PUBLIC_URL}/auth/github/callback` (đi qua proxy của web để cookie là first-party).
- `GET /auth/github`: sinh `state` 32 byte và PKCE `code_verifier`, lưu vào cookie `__Host-hub_oauth` (HttpOnly, 10 phút, ký HMAC), rồi redirect tới GitHub với scope **`read:user user:email`**, không xin gì hơn.
- `GET /auth/github/callback?code&state`:
  1. `state` khác cookie → 400 `oauth_state_mismatch`, xoá cookie;
  2. đổi `code` lấy token (gửi kèm `code_verifier`), gọi `GET /user` và `GET /user/emails`;
  3. lấy email `primary && verified`. Không có → chuyển về `/login?error=github_email_unverified`;
  4. **Ghép tài khoản:**
     - `githubId` đã có → đăng nhập user đó;
     - chưa có, nhưng email trùng một user **đã xác minh email** → liên kết `githubId` vào user đó, ghi `auth_audit` `github.linked`, gửi mail báo "GitHub vừa được liên kết";
     - email trùng một user **chưa xác minh** → **không** tự liên kết (chặn chiếm tài khoản bằng cách đăng ký trước email của người khác). Chuyển về `/login?error=email_exists_unverified`;
     - không trùng → tạo user mới `emailVerifiedAt=now()`, `passwordHash=null`, kèm project đầu tiên như §5.8;
  5. operator → từ chối (§5.6);
  6. tạo session như §5.3, rồi redirect về `/onboarding` (user mới) hoặc `/dashboard`.
- **Không lưu** access token của GitHub. Dùng xong bỏ.
- User chỉ có GitHub muốn đặt mật khẩu → dùng luồng quên mật khẩu.
- `POST /auth/github/unlink`: chỉ cho phép khi user đã có mật khẩu, tránh tự khoá mình ra ngoài → 409 `last_login_method`.

### 5.11 Mời thành viên

- `POST /api/v1/projects/:projectId/invitations {email, role}` (scope `manage:members`, người mời phải đã xác minh email) → 201. Tạo `email_tokens` purpose `invite`, gửi mail.
  - Email đã là thành viên → 409 `already_member`.
  - Mời role `owner` thì người mời phải là owner (developer không có `manage:members` nên vốn đã bị chặn).
- `GET /api/v1/projects/:projectId/invitations` · `DELETE …/invitations/:id` (thu hồi lời mời).
- `POST /auth/invitations/accept {token}`:
  - người đang đăng nhập có email **trùng** email được mời → thêm membership, đánh dấu token đã dùng, và nếu email chưa xác minh thì đặt `emailVerifiedAt` (bấm link trong mail đã chứng minh sở hữu email);
  - đang đăng nhập bằng email khác → 403 `invite_email_mismatch` (không cho cướp lời mời);
  - chưa đăng nhập → web chuyển sang đăng ký với email điền sẵn, không sửa được, rồi accept ngay sau khi đăng ký xong.
- Thành viên: `GET …/members`, `PATCH …/members/:userId {role}`, `DELETE …/members/:userId`, kèm quy tắc `last_owner`. Mỗi thao tác ghi `audit_logs` (`member.invited`, `member.joined`, `member.role_changed`, `member.removed`).

### 5.12 RLS — bắt buộc (AU6)

**Mục tiêu:** câu nói trước hội đồng, *"kể cả khi code của em quên lọc tenant, Postgres vẫn trả 0 dòng"*, phải chứng minh được bằng một test (TA12) và một lệnh psql trong demo.

1. **Hai role DB:**
   - **owner** (`DIRECT_URL`): chạy migrate, sở hữu bảng;
   - **`hub_app`** (`DATABASE_URL`): runtime của hub-api và hub-worker. **Không** superuser, **không** `BYPASSRLS`.
   - Migration tạo role nếu chưa có (local), cấp `USAGE` trên schema và `SELECT/INSERT/UPDATE/DELETE` trên bảng, `USAGE` trên sequence.
   - Neon: tạo role `hub_app` trong console, ghi vào DEPLOYMENT.md.
   - **Bẫy:** user mặc định của image `postgres` là **superuser**, và superuser **luôn bỏ qua RLS**, kể cả khi bật `FORCE`. Nếu runtime vẫn chạy bằng user đó thì RLS chỉ là trang trí.
2. **Kiểm lúc khởi động:** hub-api và hub-worker chạy `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`. Một trong hai là true → **`process.exit(1)`** với thông báo rõ ràng. Trường hợp duy nhất được bỏ qua: `RLS_ALLOW_PRIVILEGED=1`, và chỉ chấp nhận khi `NODE_ENV=test`.
3. **Bảng bật RLS:** mọi bảng nghiệp vụ có `tenant_id` trong schema `hub`: `sources`, `source_secrets`, `raw_events`, `events`, `destinations`, `subscriptions`, `deliveries`, `delivery_attempts`, `outbox` (nếu có `tenant_id`), `audit_logs`, `processed_messages` (nếu có `tenant_id`). Mỗi bảng: `ENABLE` + `FORCE ROW LEVEL SECURITY`. Bảng danh tính (§5.1) **không** bật, vì được tra trước khi biết tenant và chỉ đi qua `IdentityRepository`. Schema `shop` không đụng.
4. **Policy** (một mẫu cho mọi bảng):
   ```sql
   CREATE POLICY tenant_isolation ON hub.<t>
     USING      (tenant_id = NULLIF(current_setting('app.project_id', true), '')::uuid
                 OR current_setting('app.rls_system', true) = 'on')
     WITH CHECK (tenant_id = NULLIF(current_setting('app.project_id', true), '')::uuid
                 OR current_setting('app.rls_system', true) = 'on');
   ```
   Không set gì → `NULL` → **0 dòng** (mặc định là đóng, không phải mở).
5. **Prisma:** `TenantScopedRepository` chạy mỗi thao tác trong `$transaction(async tx => { await tx.$executeRaw\`SELECT set_config('app.project_id', ${tenantId}, true)\`; … })`.
   - `set_config(..., true)` = `SET LOCAL`: chỉ sống trong transaction, an toàn với pgbouncer transaction mode của Neon. Dùng `set_config` vì nó nhận tham số; `SET LOCAL` thì không, dễ thành SQL injection.
   - Phương thức nào vốn đã có transaction thì set ở đầu transaction đó, không lồng thêm.
   - Có thể làm bằng Prisma Client Extension (`$extends({ query: { $allModels: … } })`) theo mẫu RLS của tài liệu Prisma. Phiên dev chọn, ghi ADR.
6. **Đường hệ thống** (chưa biết tenant, hoặc đi xuyên tenant):
   - tra source theo `sourceKey` lúc ingest (`findSourceBySourceKeyForIngest`);
   - outbox relay;
   - cleanup job;
   - consumer của worker đọc theo id khi message chưa mang tenant.

   Tất cả đi qua **một** hàm `PrismaService.systemTx(reason, fn)`. Hàm này set `app.rls_system='on'` (LOCAL) và log `reason` ở mức debug.
   - **Chỉ file `prisma.service.ts` được chứa chuỗi `app.rls_system`.** DoD có lệnh grep kiểm điều này, và có unit test quét mã nguồn để khẳng định.
   - Ngay khi đọc ra được tenant (vd consumer lấy `delivery.tenantId`), đường hệ thống phải chuyển sang `TenantScopedRepository` cho phần còn lại.
   - Đánh đổi (ghi ADR-057): code nào cũng *có thể* set `app.rls_system`, nhưng chỉ một chỗ được phép, và grep chứng minh được. Phương án "hai connection string, một role BYPASSRLS cho worker" bị bác vì nhân đôi số connection trên Neon free.
7. **Hiệu năng:** đo lại p95 ingest bằng k6 ở LOCAL trước và sau AU6, ghi vào §11. Lệch > 15% → dừng lại, báo, ghi ADR.

---

## 6. API (tổng hợp)

Tất cả lỗi theo định dạng DX1 (`{error, message, fix, docsUrl, requestId}`). Mã lỗi mới thêm vào catalog `libs/common/src/errors/catalog.ts` khi làm DX1. Nếu DX1 chưa xong thì dùng tạm `{error, message}`.

| Method | Path | Auth | Body → Response |
|---|---|---|---|
| POST | `/auth/register` | — | `{email, password, name}` → 201 `{user, memberships}` + cookie · 422 `password_weak` / `password_too_long` / `validation_failed` |
| POST | `/auth/login` | — | `{email, password}` → 200 `{user, memberships}` + cookie · 401 `invalid_credentials` · 429 |
| POST | `/auth/refresh` | cookie rt | → 204 + cookie mới · 401 `session_expired` / `refresh_race` |
| POST | `/auth/logout` | cookie + CSRF | → 204, xoá cookie |
| POST | `/auth/logout-all` | cookie + CSRF | → 204 |
| GET | `/auth/me` | cookie | → `{user, memberships}` |
| GET | `/auth/sessions` | cookie | → danh sách thiết bị `{id, userAgent, ip, createdAt, current}` |
| DELETE | `/auth/sessions/:id` | cookie + CSRF | thu hồi một thiết bị của chính mình → 204 (của người khác → 404) |
| POST | `/auth/verify-email` | — | `{token}` → 200 · 400 `token_invalid` (hết hạn, đã dùng, sai: **cùng** mã) |
| POST | `/auth/resend-verification` | cookie + CSRF | → 202 |
| POST | `/auth/forgot-password` | — | `{email}` → luôn 202 |
| POST | `/auth/reset-password` | — | `{token, password}` → 204, thu hồi mọi session · 400 `token_invalid` |
| POST | `/auth/change-password` | cookie + CSRF | `{currentPassword, password}` → 204 · 401 `invalid_credentials` |
| GET | `/auth/github` | — | 302 tới GitHub |
| GET | `/auth/github/callback` | cookie oauth | 302 về web |
| POST | `/auth/github/unlink` | cookie + CSRF | → 204 · 409 `last_login_method` |
| GET | `/auth/socket-ticket?projectId=` | cookie + member | → `{ticket}` |
| POST | `/auth/invitations/accept` | cookie + CSRF | `{token}` → 200 `{membership}` · 403 `invite_email_mismatch` · 400 `token_invalid` |
| GET/POST | `/api/v1/projects` | cookie (+CSRF khi POST) | liệt kê project của mình / tạo (mình = owner; `environment=live` cần email đã xác minh) |
| PATCH/DELETE | `/api/v1/projects/:projectId` | `manage:project` | |
| GET/PATCH/DELETE | `/api/v1/projects/:projectId/members[/:userId]` | `read:project` / `manage:members` | §5.11 |
| GET/POST/DELETE | `/api/v1/projects/:projectId/invitations[/:id]` | `manage:members` | §5.11 |
| `*` | các route `/api/v1/*` khác | cookie + `?projectId=` bắt buộc | scope theo bảng ở §6.1 |

### 6.1 Gắn scope cho route console hiện có

Phiên dev liệt kê mọi route trong `api.controller.ts` rồi gắn theo quy tắc: `GET` → `read:project`; tạo/sửa/xoá source → `manage:sources`; destination và subscription → `manage:endpoints`; replay, retry DLQ → `replay:deliveries`; key → `manage:keys`. Route nào không khớp quy tắc thì ghi vào bảng §10 kèm scope đã chọn. Unit test UA20 khẳng định **mọi** route `/api/v1/*` đều có `@RequireScope` (quét metadata).

### 6.2 Audit

- `auth_audit` (cấp user): `user.registered`, `user.email_verified`, `auth.login_succeeded`, `auth.login_failed` (kèm `sha256(email)`, **không** kèm mật khẩu), `auth.rate_limited`, `session.revoked`, `session.reuse_detected`, `password.changed`, `password.reset_requested`, `password.reset`, `github.linked`, `github.unlinked`.
- `audit_logs` (cấp project, dùng `withAudit` sẵn có): `project.created`, `member.invited`, `member.joined`, `member.role_changed`, `member.removed`, `invitation.revoked`, `operator.access`.

---

## 7. Biến môi trường

| Biến | Ghi chú |
|---|---|
| `JWT_SECRET` | giữ nguyên, ≥ 32 ký tự (đã kiểm lúc bootstrap) |
| `SOCKET_TICKET_SECRET`, `CSRF_SECRET`, `OAUTH_COOKIE_SECRET` | mỗi biến ≥ 32 ký tự, **khác nhau**, khác `JWT_SECRET`. Kiểm lúc bootstrap |
| `JWT_ACCESS_TTL_S=900` · `REFRESH_IDLE_DAYS=7` · `REFRESH_ABSOLUTE_DAYS=30` | |
| `OPERATOR_EMAIL`, `OPERATOR_PASSWORD_HASH` | **thay** `ADMIN_USERNAME`, `ADMIN_PASSWORD_HASH`. Hash vẫn phải escape `$$` trong `.env` (giữ logic normalize hiện có) |
| `WEB_PUBLIC_URL` | vd `http://localhost:3000`. Dùng cho CORS, link mail, OAuth callback |
| `MAIL_DRIVER=log\|resend` · `RESEND_API_KEY` · `MAIL_FROM` | Admin cung cấp key |
| `GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET` | OAuth App, **khác** secret webhook GitHub |
| `TRUST_PROXY=0\|1` | §5.5 |
| `DATABASE_URL` | **đổi sang role `hub_app`** (AU6). `DIRECT_URL` vẫn là owner |
| `RLS_ALLOW_PRIVILEGED` | chỉ test |

Cập nhật `.env.example`, `docs/DEPLOYMENT.md` (bảng env, các bước tạo role Neon, OAuth App, domain Resend), `docker-compose.yml` (truyền biến mới; init script tạo `hub_app` ở local).

---

## 8. Stories

| ID | Nội dung | Phụ thuộc | Ước lượng |
|---|---|---|---|
| **AU1** | Schema §5.1 + seed operator · register/login/logout/logout-all/refresh/me/sessions · cookie + CSRF + helmet + CORS · mật khẩu §5.2 · rate limit §5.5 · `auth_audit` · sửa ARCHITECTURE §7.4 và §9 | S1 của SPEC đa service (hoặc tự tạo `projects` như §0) | 6h |
| **AU2** | `MailSender` (log + resend) · verify-email, resend, forgot/reset, change-password · mail "có người thử đăng ký" · mở rộng `CleanupJob` | AU1 | 3.5h |
| **AU3** | `ROLE_SCOPES`, Principal, `SessionGuard`, `ProjectAccessGuard`, `@RequireScope` dùng chung với `ApiKeyGuard` · gắn scope mọi route §6.1 · `?projectId=` bắt buộc · operator + `operator.access` · `email_not_verified` · socket ticket + room `project:<id>` · `/api/v1/projects` theo membership | AU1 | 5h |
| **AU4** | Lời mời + quản lý thành viên §5.11 · `last_owner` · `scope_not_grantable` khi tạo API key | AU2, AU3 | 2.5h |
| **AU5** | GitHub OAuth §5.10 (state + PKCE, ghép tài khoản, unlink) | AU3 | 3h |
| **AU6** | RLS §5.12: role `hub_app`, migration policy, kiểm lúc khởi động, `set_config` trong repo, `systemTx`, grep DoD, đo k6 trước/sau | AU3 + **mọi bảng nghiệp vụ của SPEC đa service đã có** (sau S12) | 5h |

Tổng khoảng **25 giờ (3–3,5 ngày)**. Con số "1–1,5 ngày" ở ADR-056 là ước lượng sai; ADR-057 ghi lại con số đúng.

**Thứ tự gợi ý cho cả dự án:** SPEC-3 (phiên kia đang làm) → SPEC đa service S0, S1 → **AU1 → AU2 → AU3** (thay phần console admin của S2) → S2 phần key … S12, S14 → **AU4, AU5** → **AU6** (thay S13) → SPEC-dev-experience DX1–DX3.

> **Cập nhật 10/10 (SPEC-verification §11):** chèn VF1 → VF2 → VF7 ngay sau SPEC-3; từ AU1 mọi story theo luật dev agent §6 của `verification/SPEC-verification.md`; VF3, VF4 sau AU3; VF5, VF6 sau AU6; VF8 cuối cùng. E2E (TA) chạy trên stack `hubv`, đọc mail qua `MAIL_DRIVER=capture`, GitHub qua `fake-github` (SPEC-verification §4.2).

### 8.1 Definition of Done (thêm vào DoD chung)

- [ ] `git grep -n "ADMIN_USERNAME\|DEFAULT_TENANT_ID" apps/hub-api/src` trả rỗng (chỉ seed và test được phép dùng `DEFAULT_TENANT_ID`).
- [ ] `git grep -n "app.rls_system" -- apps libs` chỉ ra đúng `prisma.service.ts` (cùng các file test).
- [ ] `git grep -n "localStorage" apps/web/src/lib/hub` trả rỗng (việc của phiên UI; phiên dev chỉ kiểm).
- [ ] Mọi route `/api/v1/*` có `@RequireScope` (UA20 xanh).
- [ ] Không log nào chứa `password`, `__Host-hub_rt`, `hk_live_` thô (UA22).
- [ ] p95 ingest sau AU6 lệch ≤ 15% so với trước (§11).

---

## 9. Hợp đồng cho phiên UI (`ui-revamp`)

- **Xoá** `apps/web/src/lib/hub/token.ts` và mọi Bearer từ web. Mọi `fetch` gọi URL tương đối (`/api/...`, `/auth/...`) với `credentials:'include'`, và gửi `x-csrf-token` = cookie `hub_csrf` cho các method thay đổi dữ liệu.
- `next.config` thêm `rewrites`: `/api/:path*` và `/auth/:path*` → `${HUB_API_INTERNAL_URL}/…`. Không rewrite `/hooks/*` và `/v1/p/*` (provider và service gọi thẳng API).
- **401 → gọi `/auth/refresh` một lần, theo kiểu single-flight** (nhiều request cùng 401 thì chỉ một refresh, các request còn lại chờ kết quả), rồi thử lại request gốc. Refresh lỗi → về `/login`.
- Màn hình: `/register`, `/login` (có nút "Đăng nhập bằng GitHub"), `/verify-email`, `/forgot-password`, `/reset-password`, `/invite`, `/onboarding` (nút "Tạo key đầu tiên" → 3 ô copy DX2), banner "chưa xác minh email" kèm nút gửi lại, bộ chọn project, trang Thành viên (mời, đổi role, xoá), trang Thiết bị đăng nhập (`/auth/sessions`).
- Ẩn hoặc tắt nút theo `ROLE_SCOPES` (lấy từ `memberships[].role`). **Việc ẩn chỉ để đẹp; server vẫn là nơi chặn.**
- Socket: xin `/auth/socket-ticket?projectId=` rồi kết nối với `auth:{ticket}`; đổi project thì kết nối lại.
- Trang nhận token qua URL: `Referrer-Policy: no-referrer` + `history.replaceState` (§5.4).

---

## 10. Test

### 10.1 Unit (UA)

| # | Mục | Kỳ vọng | Story |
|---|---|---|---|
| UA1 | băm mật khẩu | hash bcrypt cost 12; `compare` đúng/sai | AU1 |
| UA2 | mật khẩu 73 byte (tiếng Việt có dấu) | 422 `password_too_long` | AU1 |
| UA3 | mật khẩu nằm trong danh sách phổ biến / chứa phần trước `@` của email | 422 `password_weak` | AU1 |
| UA4 | login email không tồn tại | 401 cùng body với sai mật khẩu; `bcrypt.compare` vẫn được gọi (spy) | AU1 |
| UA5 | register email đã tồn tại | 201 cùng hình dạng body; mail "có người thử" được gửi; không tạo user | AU2 |
| UA6 | access JWT `alg:none` / sai `aud` / sai `iss` / hết hạn | 401 | AU1 |
| UA7 | refresh hợp lệ | dòng cũ `rotatedAt`, dòng mới cùng `familyId`, `absoluteExpiresAt` giữ nguyên | AU1 |
| UA8 | refresh dùng lại sau 6 giây | cả family bị thu hồi, `auth_audit` `session.reuse_detected` | AU1 |
| UA9 | refresh dùng lại sau 2 giây | 401 `refresh_race`, family **không** bị thu hồi | AU1 |
| UA10 | session đã thu hồi + access JWT còn hạn | 401 (SessionGuard kiểm DB) | AU1 |
| UA11 | CSRF thiếu / sai chữ ký / ký cho sid khác | 403 `csrf_failed` | AU1 |
| UA12 | rate limit email: 5 lần sai | lần 6 → 429, áp dụng cả cho email không tồn tại | AU1 |
| UA13 | Redis ném lỗi | rate limit chuyển sang bộ nhớ, request vẫn chạy | AU1 |
| UA14 | email token dùng 2 lần song song | đúng một lần thành công | AU2 |
| UA15 | reset mật khẩu | mọi session bị thu hồi | AU2 |
| UA16 | `ProjectAccessGuard`: không phải thành viên vs project không tồn tại | cùng 404, cùng body | AU3 |
| UA17 | `ROLE_SCOPES` | viewer gọi route `manage:endpoints` → 403 `missing_scope` | AU3 |
| UA18 | `last_owner` | xoá / hạ quyền owner cuối → 409 | AU4 |
| UA19 | tạo API key xin `manage:keys` | 422 `scope_not_grantable` | AU4 |
| UA20 | quét metadata controller | mọi route `/api/v1/*` có `@RequireScope` | AU3 |
| UA21 | operator vào project không là thành viên | được, và ghi `operator.access` | AU3 |
| UA22 | logger | chuỗi chứa password, refresh token, `hk_live_` bị che | AU1 |
| UA23 | GitHub callback `state` sai | 400 `oauth_state_mismatch` | AU5 |
| UA24 | GitHub email trùng user **chưa** xác minh | không liên kết, redirect `email_exists_unverified` | AU5 |
| UA25 | GitHub email trùng user đã xác minh | liên kết `githubId`, ghi audit, gửi mail | AU5 |
| UA26 | invite: đang đăng nhập bằng email khác | 403 `invite_email_mismatch` | AU4 |
| UA27 | invite accept bởi user chưa xác minh, email trùng | membership tạo + `emailVerifiedAt` được set | AU4 |
| UA28 | user chưa xác minh tạo key `hk_live_` / mời người | 403 `email_not_verified` | AU3 |
| UA29 | socket ticket `aud` sai / hết hạn / session đã thu hồi | kết nối bị từ chối | AU3 |
| UA30 | quét mã nguồn | `app.rls_system` chỉ xuất hiện trong `prisma.service.ts` | AU6 |
| UA31 | kiểm khởi động với role superuser | `process.exit(1)` (mock) | AU6 |

### 10.2 E2E (TA) — chạy ở LOCAL, `MAIL_DRIVER=log`

```bash
API=http://localhost:4000; WEB=http://localhost:3000; J=/tmp/cj.txt
# Gọi qua WEB (proxy) để cookie là first-party như thật
csrf() { grep hub_csrf $J | awk '{print $7}'; }
```

- **TA1 — Đăng ký → event đầu tiên.** `POST $WEB/auth/register` → 201, có 3 cookie, `memberships[0].role=owner`. Log có link xác minh. Tạo key `hk_test_` → 201 kèm quickstart. Chạy quickstart → event hiện ra. **Bấm giờ từ lúc gọi register** → ghi vào §11 (cược cà phê).
- **TA2 — Xác minh email.** POST token từ log → 200; POST lại → 400 `token_invalid`; sau đó tạo key `hk_live_` → 201 (trước khi xác minh → 403 `email_not_verified`).
- **TA3 — Chống dò.** Login email không tồn tại vs sai mật khẩu: so `diff` hai body → giống hệt; thời gian lệch < 50ms (lấy trung bình 10 lần). Register email đã có → 201 cùng hình dạng.
- **TA4 — Brute force.** 6 lần sai cho một email → lần 6 là 429 + `Retry-After`. Làm lại với email không tồn tại → cũng 429.
- **TA5 — Refresh + dùng lại.** Lưu cookie rt cũ, refresh → 204. Chờ 6 giây, gửi rt cũ → 401. Gửi rt **mới** → cũng 401, vì cả family đã bị thu hồi. `auth_audit` có `session.reuse_detected`.
- **TA6 — Thu hồi tức thì.** Đăng nhập ở 2 "thiết bị" (2 cookie jar). Thiết bị A gọi `logout-all` → request kế tiếp của B (access còn hạn) → 401.
- **TA7 — CSRF.** `POST /api/v1/projects` có cookie nhưng thiếu header → 403 `csrf_failed`.
- **TA8 — Cô lập 2 người, 2 project.** User A (project `cafe`), user B (project `bookstore`). B gọi `GET /api/v1/events?projectId=<cafe>` → 404, body **giống hệt** khi gọi projectId ngẫu nhiên. B mở socket với vé của `bookstore` → không nhận event nào của `cafe` khi A gửi event.
- **TA9 — Role.** A mời B làm `viewer` vào `cafe` (link trong log), B accept. B xem events → 200; B tạo endpoint → 403 `missing_scope`; B mời người khác → 403. A nâng B lên `developer` → B tạo endpoint → 201. A tự rời project khi là owner duy nhất → 409 `last_owner`.
- **TA10 — Quên mật khẩu.** forgot (email có và email không có → cùng 202) → reset bằng link → mọi cookie jar cũ → 401.
- **TA11 — GitHub.** (thủ công, cần OAuth App) đăng nhập bằng GitHub với email trùng user đã xác minh → liên kết, có mail báo. Sửa `state` trên URL callback → 400.
- **TA12 — RLS chứng minh.** Kết nối psql bằng `hub_app`:
  ```sql
  SELECT count(*) FROM hub.events;                                   -- 0  (chưa set gì: đóng)
  BEGIN; SELECT set_config('app.project_id','<cafe>',true);
  SELECT count(DISTINCT tenant_id) FROM hub.events;                  -- 1
  INSERT INTO hub.events (… tenant_id='<bookstore>' …);              -- ERROR: new row violates row-level security policy
  ROLLBACK;
  ```
  Kèm một test Jest gọi thẳng `prisma.event.findMany()` (cố tình bỏ qua repo) → `[]`.
- **TA13 — Khởi động sai role.** Đặt `DATABASE_URL` thành user superuser → hub-api thoát với thông báo rõ ràng.
- **TA14 — Trình duyệt thật.** Chrome và Firefox ở `http://localhost:3000`: đăng ký, F5 vẫn đăng nhập (refresh chạy), DevTools → `document.cookie` **không** thấy `__Host-hub_at` / `__Host-hub_rt`.
- **TA15 — Operator.** Đăng nhập operator, mở project của A → được; `audit_logs` của project A có `operator.access`.

**Mã TA → story** (cho `verify:map` / `done.groups`, thêm 10/10; không đổi nội dung kịch bản):

| Mã | TA1 | TA2 | TA3 | TA4 | TA5 | TA6 | TA7 | TA8 | TA9 | TA10 | TA11 | TA12 | TA13 | TA14 | TA15 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Story | AU1 | AU2 | AU1 | AU1 | AU1 | AU1 | AU1 | AU3 | AU4 | AU2 | AU5 | AU6 | AU6 | AU3 | AU3 |

### 10.3 Màn demo cho hội đồng (thêm vào đầu demo hiện có)

1. Mở web, **Đăng ký** bằng email thật (Resend, domain đã xác minh). Bấm giờ.
2. Onboarding → Tạo key → chạy quickstart → event hiện realtime. Dừng giờ.
3. Mở mail, bấm xác minh, banner biến mất.
4. Mời người thứ hai (trình duyệt ẩn danh) làm viewer → người đó thử xoá endpoint → bị chặn.
5. Người thứ hai sửa URL sang project khác → 404.
6. psql bằng `hub_app`: `SELECT count(*) FROM hub.events` → 0. *"Kể cả code của em quên lọc, Postgres vẫn chặn."*
7. (Nếu còn giờ) Đăng nhập GitHub.

---

## 11. Kết quả (phiên TEST ghi)

| Mục | Kết quả | Ghi chú |
|---|---|---|
| TA1 thời gian từ Đăng ký → event đầu tiên | … giây | Sally 60 / Winston 90 |
| TA3 lệch thời gian login (email có vs không) | … ms | |
| p95 ingest trước AU6 / sau AU6 | … / … ms | ≤ 15% |
| UA1–UA31 | …/31 | |
| TA1–TA15 | …/15 | |
| Route lệch quy tắc §6.1 | | |

## 12. Checklist phiên DEV

- [x] AU1 · [x] AU2 · [x] AU3 · [ ] AU4 · [ ] AU5 · [ ] AU6
- [ ] ADR cho mọi chỗ spec không nói (số tiếp theo còn trống)
- [ ] `.env.example`, `docs/DEPLOYMENT.md`, `docker-compose.yml`, ARCHITECTURE §7.4 và §9 đã cập nhật
- [ ] §8.1 DoD xanh hết
