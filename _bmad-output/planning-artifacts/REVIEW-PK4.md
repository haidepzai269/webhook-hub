# REVIEW-PK4 — `feae0fa` (sửa review PK9-R2) + `97090f0` (PK4: bắt tay, GET, ack)

Reviewer độc lập (Grumbal ⚠️ bảo mật · Winston 🏗️ kiến trúc · Murat 🧪), 2026-10-14, worktree `C:\wt\pk`, nhánh `feat/pk`.
Chỉ đọc + jest chọn lọc + đột biến tạm (đã `git checkout --` trả lại; `libs/hub-sdk/bin/hub.js` đã `M` từ trước, không đụng).

## Kết luận: **ĐẠT** — 0 Nặng, 2 Trung bình (sửa trước PK6; TB-1 nên sửa ngay, ~10 dòng), 6 Thấp

Lõi ingest đúng bảng E9, BB-3 giữ (2xx ngoài bắt tay chỉ sau `persistAccepted`), hmac-echo không thành máy ký hộ, lõi kẹp mã
từ chối/thành công, 0 lệnh Redis ở đường bắt tay. Hai lỗ TB nằm ở rìa: một response API lọt `verifyTokenEnc`, và cấu hình bắt
tay có thể nuốt sự kiện thật (2xx không COMMIT) khi dev khai nhầm header.

## Kiểm chứng đã chạy

| Lệnh | Kết quả |
|---|---|
| jest `--maxWorkers=2`: `apps/hub-api/test/{ingest*,redis-budget,service-sources,console-source-inspect,console-catalog,penalty*,body-limit}`, `libs/providers/test`, `verify/test/gates` | 36 suite PASS (1 skipped = describeDb), 462 test |
| jest `apps/web/src/lib/hub` + `apps/web/src/lib/i18n` | 8 suite PASS, 76 test |
| `tsc --noEmit` hub-api / hub-worker / web | sạch |
| `verify:gates` | 22 luật, 0 vi phạm |
| `catalog:build --check` | khớp (23 mục) |
| `alert-evaluator-db.spec.ts` | KHÔNG chạy (cần docker) — chỉ đọc, xem mục 6 |

Đột biến (đã trả lại):

| Đột biến | Kết quả |
|---|---|
| `trace.tenantId` + `outcome='REJECTED'` đặt TRƯỚC chốt method (405 vào lưu lượng) | **sống** (T-5) |
| `publicVerificationConfig` thành `return vc` (lộ `verifyTokenEnc` ở mọi response) | **sống**, không test nào tham chiếu `verifyTokenSet`/`publicVerificationConfig` (TB-1) |
| `!timingSafeCompare(presented[0], expected)` thành `presented[0] !== expected` | tests xanh (đúng, vì hành vi giống) + **gate `sig-compare` không bắt** (T-3) |

Các đột biến dev đã ghi ở §16 (after-verify trước verify, nhận 2xx khi từ chối, `rejectStatus: 200`, bỏ chốt GET) tôi không chạy lại. Tôi đã đọc test tương ứng, và chúng phân biệt được.

---

## Trung bình

### TB-1 — `PATCH /api/v1/sources/:id` trả `verifyTokenEnc` (bỏ qua `publicVerificationConfig`), không có test nào giữ luật E13
- `apps/hub-api/src/modules/api/api.controller.ts:233-234`: `const { secrets, ...rest } = updated; return { ...rest, secretVersions }`.
  `updated` = `repo.updateSource` → `findSourceById` (`libs/database/src/tenant-scoped.repository.ts:175-178`) trả đủ cột, gồm
  `verificationConfig.handshake.verifyTokenEnc`.
- Kịch bản: dev đổi tên / bật-tắt source Meta trên console. Response mang ciphertext AES-GCM của verify token. Điều này trái
  ghi chú §16 ("Response nguồn … thay `verifyTokenEnc` bằng `verifyTokenSet: true`") và trái ADR-205 ("response nguồn thay bằng
  `verifyTokenSet`"). Bản rõ chưa lộ. Nhưng đây đúng là loại "không trả ciphertext ra trình duyệt" mà code đang giữ cho `secrets`.
- Đột biến vô hiệu hoá `publicVerificationConfig` → toàn bộ suite vẫn xanh. Không có test nào giữ luật này.
- Đề xuất: (1) PATCH đi qua `publicVerificationConfig`. Tốt hơn là gom một hàm `consoleSource(row)` dùng chung cho list/create/patch
  (`api.controller.ts:147,197,233`). (2) Thêm test: tạo source query-echo có verifyToken, rồi gọi list/create/patch (console) và
  list/create (service API, `service-resources.controller.ts:111`). Mỗi response phải không chứa chuỗi `verifyTokenEnc`, phải có
  `verifyTokenSet: true`.

### TB-2 — Cấu hình bắt tay có thể nuốt sự kiện thật: 2xx, không COMMIT, provider không gửi lại (BB-3 qua đường cấu hình)
- `libs/providers/src/generic.adapter.ts` `handshake()` nhánh `header-echo`: **mọi** POST có header `h.header` đều được trả 200 và
  không đi tiếp. Nhánh `body-echo`/`manual-url` cũng vậy với `when` khớp. `generic-config.ts parseHandshake` chỉ kiểm khuôn tên
  (`HEADER_RE`/`FIELD_RE`). Nó không kiểm xem header/trường bắt tay có trùng thứ **mọi sự kiện đều mang** hay không.
- Kịch bản thật (Asana có hai header gần tên nhau): dev khai `header-echo` với `x-hook-signature` thay vì `x-hook-secret`. Khi đó mọi
  sự kiện Asana (đều có `X-Hook-Signature`) nhận 200 + dòng REJECTED "handshake". Console còn hiện "Đã bắt tay ✓" (`listen-logic.ts`
  `connectionState` → `handshaken`). Sự kiện mất vĩnh viễn: provider thấy 2xx nên không gửi lại, và lỗi im lặng. Tương tự với
  `header-echo: content-type`, hoặc `when: {header: 'user-agent', equals: …}`.
- Hub không tự sai ở đây, nhưng đây đúng là kiểu "ACK sớm = mất sự kiện" mà BB-3 cấm, chỉ là đi qua cấu hình. Luận điểm "lõi kẹp,
  không tin adapter" của chính PK4 nên áp cả ở đây.
- Đề xuất: (1) `validateGenericConfig` trả 422 khi `header-echo.header` hoặc `when.header` thuộc {header chữ ký (`header`,
  `signature.headers`, `signature.header`), `timestampHeader`, `idHeader`, `idempotency.header`, `content-type`, `content-length`,
  `user-agent`, `host`, `accept*`}, và khi `when.field` = `idempotency.field`. (2) Ingest: `header-echo` chỉ coi là bắt tay khi
  request KHÔNG mang header chữ ký của scheme. Việc này adapter làm được, lõi không cần biết. (3) Thêm test cho mỗi ca. Có thể xét
  thêm: console cảnh báo khi một source có > N dòng handshake/5 phút ("bắt tay lặp lại — có thể đang nuốt sự kiện").

---

## Thấp

### T-1 — Bắt tay trước verify cho provider ĐÃ ký request bắt tay (Slack, Twitch): giả được "Đã bắt tay ✓" và cấy SubscribeURL
- E9 đặt 2h trước verify. Tài liệu Slack (`docs.slack.dev/reference/events/url_verification`, đọc 2026-10-14) dặn rõ "verify the
  request's authenticity … before responding". Request bắt tay của Twitch cũng được ký.
- Kẻ biết `sourceKey` sẽ: (a) làm console hiện "Đã bắt tay ✓" cho source chưa nối; (b) với `manual-url`, đẩy URL của chính hắn lên
  đầu (`pendingSubscribeUrl` lấy dòng mới nhất). `isSnsSubscribeUrl` chặt và đúng: `sns.evil.com.amazonaws.com.attacker`,
  `sns.us-east-1.amazonaws.com.evil.com`, userinfo và port đều trượt. Nhưng một URL `ConfirmSubscription` **thật** cho topic SNS
  của kẻ tấn công vẫn qua kiểm tra. Dev bấm vào là đăng ký topic của hắn vào endpoint, và từ đó hắn gửi được thông điệp **AWS ký
  thật**.
- Đề xuất: (1) thêm `handshake.afterVerify: true` cho body-echo, bật trong entry slack/twitch. Hai bên này ký request bắt tay, nên
  bắt tay sau verify không mất gì. (2) Console tách `TopicArn` từ SubscribeURL và hiện rõ ("bạn có sở hữu topic này?"). (3) **Chặn
  trước PK5 aws-sns:** verify SNS phải ghim `TopicArn` theo cấu hình source.

### T-2 — Dòng `handshake` không bị phạt: một IP ghi được 20 dòng/phút/source/instance mãi mãi
- `ingest.service.ts answerHandshake` → `storeRejected` (trần 20/phút, ≤4KB), không `recordBadSignature`. Đường ký sai thì bị
  `checkPair` chặn sau vài lần, còn đường này không, nên ~115 MB/ngày/source tính vào dung lượng project (QT3 có thể 507 khoá
  ingest thật). ADR-205 đã ghi đánh đổi và CAPTURE_MAX sẽ tới ở PK6.
- Đề xuất rẻ: dòng handshake chỉ cần meta (E8: "Đã bắt tay ✓" + `subscribeUrl`). Lưu `body = {}`, `bodyRaw` rỗng, và dùng limiter
  riêng (vd 3/phút/source). Như vậy giảm ~100 lần.

### T-3 — Gate `sig-compare` không phủ so sánh token
- `verify/lib/gates.ts:275` chỉ bắt dòng có `signature|hmac|digest`. Đột biến `presented[0] !== expected` (so verify token
  query-echo, `generic.adapter.ts` nhánh `verifyTokenParam`) qua cả gate lẫn test. Trong khi CLAUDE.md quy định "so chữ ký/**khoá**
  chỉ bằng timingSafeEqual". Nhân tiện: hằng `AFTER_VERIFY_KIND` chỉ tồn tại để né gate, vì dòng `h.kind === 'hmac-echo'` chứa chữ
  `hmac`. Gate đang báo dương tính giả, nên làm mịn gate thay vì để code đi vòng.
- Đề xuất: mở regex sang `token|secret|expected|presented`, bỏ qua so sánh với literal chuỗi hằng.

### T-4 — Twitch: `toleranceSec: 300` và `docsVersion` ghi "Tài liệu không nêu cửa sổ" — tài liệu có nêu
- `dev.twitch.tv/docs/eventsub/` (mục replay/duplicate, đọc 2026-10-14): "Make sure the value in the message_timestamp field isn't
  older than 10 minutes". Cùng trang xác nhận "If Twitch resends the message, the message ID will be the same" (khoá chống trùng
  đúng).
- Hub chỉ nhận 300s, nên bản gửi lại muộn (hub lạnh hoặc ngủ trên Render) sẽ bị 401 dù Twitch coi là hợp lệ. Đề xuất: đổi thành
  `600`, sửa `docsVersion` và fixture `[PK:T9]` cho Twitch.

### T-5 — Luật "405 không vào lưu lượng" không có test
- Đột biến đặt `trace.tenantId/outcome` trước chốt method mà vẫn xanh (`ingest-handshake*`, `ingest-traffic`). Đề xuất: `[PK:T11]`
  thêm assert `traffic.record` không được gọi với GET/HEAD bị 405.

### T-6 — `feae0fa` (sửa PK9-R2): ổn, một ghi chú nhỏ
- `identify.ts`: JSON parse trên toàn body ≤1 MB, các nhánh XML/form/JWT/JSON lines vẫn cắt 64 KB. JSON lines bị cắt thì bỏ dòng dở
  dang, và `problems` báo đúng loại. Test 100 KB github/typeform xanh.
- Gate `web-no-provider-barrel` bắt cả `import type … from '@hub/providers'`. Đây là dương tính giả vì type-only không vào bundle.
  Chấp nhận, nhưng nên ghi trong `rule`.

---

## Đối chiếu từng mục yêu cầu

1. **Thứ tự ingest**: thứ tự thật ở `ingest.service.ts:396-536` là checkIp → 413 → 414 → adapter → source → PK0 → **method 405
   (trước `trace.tenantId`)** → QT3 → checkPair → giải mã → `storedHeaders` → **2h** → **chốt GET** (`:528`) → verify → **3h** →
   EG3 → markGood → 4–7. Khớp E9 và §16. 3h chỉ chạy khi `isSignatureValid`, ký bằng `secrets.find(s => verifyWith(c, req, [s]))`,
   tức chỉ secret đã verify. 2xx không COMMIT: chỉ có `answerHandshake` (bắt tay, chấp nhận), cộng lỗ cấu hình TB-2. `ackFor` chỉ
   chạy sau `persistAccepted`. Echo: `^[\x21-\x7E]{1,256}$`, `text/plain; charset=utf-8` + nosniff, không CR/LF nên không chèn được
   header. Trần `storeRejected` 20/phút **có** áp cho bắt tay, nhưng không phạt (T-2).
2. **hmac-echo**: `HMAC_ECHO_TOKEN_RE` không có `:`/`{`/`.`; chỉ chạy `after-verify`, và `before-verify` trả null với hmac-echo.
   Thuật toán cố định (SHA-256 hex, khoá utf8). `tokenParent` đúng một cấp. Chế độ thu chưa tồn tại; khi làm PK6 phải nhớ E3
   "cấm ở chế độ thu".
3. **verifyToken**: mã hoá ở `parseSourceInput`. Client gửi `verifyTokenEnc` thì 422 (các đường ghi config chỉ có hai controller,
   đều qua `parseSourceInput`). Token không nằm trong `secrets` nên không thành khoá HMAC. So bằng `timingSafeCompare`. `openSealed`
   là closure trong ctx, lõi không đọc config. Query (chứa `hub.verify_token`) **không** được lưu vào raw_events. Còn lỗ ở API: TB-1.
4. **ack**: `rejectAck` kẹp 401 → {401,403,503}, 422 giữ nguyên, thành công {200,202,204}. 503 vẫn `recordBadSignature`. 204 gọi
   `.end()`. Adapter native trả `result.status` (đã soát `api/github/payos/sepay/stripe`) nên hành vi không đổi. ApiAdapter 202 vẫn
   qua kẹp.
5. **GET/HEAD**: `@Get` là method riêng. Express 5 dẫn HEAD vào route GET với `req.method='HEAD'`, và test HTTP thật xác nhận 405.
   405 xảy ra trước `tenantId`, không ghi DB, không phạt (riêng sourceKey không tồn tại thì vẫn 404 + `recordUnknownSource`, đúng
   EG2). 414 kiểm trước khi nạp source. `penalty-gate.ts:56` áp mọi method trừ OPTIONS.
6. **countSignatureBySource** (`tenant-scoped.repository.ts:1352-1362`): `COALESCE(r.headers->'__hub_meta'->>'reason','') NOT IN ($,$)`.
   Cột `headers` là `Json` (jsonb). Dòng ACCEPTED không có meta nên ra `''` và vẫn được tính. Header thật tên `__hub_meta` là chuỗi
   nên `->>'reason'` ra NULL, không giả được. `storeRejected` spread meta sau headers nên ghi đè. Test DB phân biệt được cả hai lý
   do (handshake `signature_valid=true` làm tăng `requests`; not_configured `false` làm tăng `invalid`). SQL đúng, chờ CI.
7. **Redis**: `[PK:T10] (phần b)` ở `redis-budget.spec.ts` cho thấy 0 lệnh với query-echo, body-echo, hmac-echo. Đường thường không
   đổi, suite xanh.
8. **Console**: `handshakeIssues` khớp `parseHandshake` (FIELD/HEADER/PARAM/WHEN_EQUALS/VERIFY_TOKEN, mac≠token,
   verifyTokenParam≠param). `isSnsSubscribeUrl` chặt (`[a-z0-9-]+` không có dấu chấm, neo hai đầu, chặn userinfo/port). Rủi ro còn
   lại là URL thật của topic lạ (T-1).
9. **Danh mục** (WebFetch 2026-10-14): Slack đúng (plaintext challenge được chấp nhận, ký `v0:{ts}:{body}`, 5 phút). Twitch đúng
   thuật toán (`id+timestamp+body`, `sha256=`), đúng bắt tay (200, challenge thô, Content-Length), id giữ nguyên khi gửi lại. Sai
   cửa sổ thời gian, xem T-4.
10. **Hồi quy**: xem bảng đầu file.

## Ý kiến về các lệch §16 (PK4)

- **verifyToken mã hoá trong config thay vì "secret thứ hai"** (thân §6.1): đúng, E13 thắng. Nếu dùng SourceSecret thì ingest sẽ
  thử token Meta làm khoá HMAC.
- **Khoá lạ trong `handshake`/`ack` → 422** (khác thân config): đồng ý. Cấu hình bắt tay sai nghĩa là provider không lưu được URL;
  nên báo 422 thay vì im lặng.
- **`tokenParent` một cấp**: đồng ý, đủ cho Zoom và không mở JSONPath.
- **`adoptSecret` luôn 422 tới PK6**: đồng ý.
- **Bắt tay luôn 200** (`successStatus` không áp): đồng ý. Echo cần body, và Meta/Twitch/Dropbox đòi 200. Asana chấp nhận 200.
- **HEAD 200 cho Intercom/Trello**: đề xuất mở **có kiểm soát**, ghi ADR sửa E27:
  - Thêm kiểu bắt tay thứ sáu `{kind: 'head-ok'}`. Không dùng cờ rời, để giữ "một handshake/source". Cả Intercom lẫn Trello đều chỉ
    cần mỗi HEAD.
  - HEAD vẫn đi qua penalty-gate → checkIp → nạp source → PK0 → QT3 → checkPair, rồi trả 200 rỗng. Không ghi DB (hoặc ghi một dòng
    meta-only như đề xuất ở T-2), không phạt, 0 Redis.
  - Source không khai `head-ok` vẫn 405 như hiện nay. Mỗi source chỉ có một bề mặt, và HEAD không phản chiếu gì.
  - Trello vẫn còn vướng chữ ký (HMAC-SHA1 base64 trên body + callbackURL, phải biết URL công khai, xem E18), nên chỉ mở cho Trello
    khi phần đó xong.
- **Echo JSON (monday, Okta)**: monday thì chấp nhận `body-echo` thêm `respond: 'json'`, trả `{"<echo.field>": v}` với
  `application/json`. Giữ nguyên `ECHO_RE` và khoá JSON cố định bằng tên trường đã khai. Như vậy không phản chiếu cấu trúc tuỳ ý,
  rủi ro ngang text/plain. Okta (GET + header challenge, trả `{"verification": v}`) phải mở GET ngoài query-echo, tức là thêm bề mặt
  GET, nên **hoãn**: cần ADR riêng và chỉ làm khi có người dùng thật.
- **Graph** (`validationToken` qua POST query): thực chất là `query-echo` trên POST. Có thể cho `query-echo.method: 'POST'` sau, với
  cùng `ECHO_RE`. Không gấp.
