# REVIEW-PK4-R2 — `c4d28fd` (CI [DX:UX4]) + `a8abda4` (sửa REVIEW-PK4)

Reviewer độc lập (Grumbal ⚠️ + Murat 🧪), 2026-10-14, worktree `C:\wt\pk`, nhánh `feat/pk`.
Chỉ đọc, chạy jest chọn lọc và đột biến tạm (đã `git checkout --` trả lại). `libs/hub-sdk/bin/hub.js` đã ở trạng thái `M` từ trước, tôi không đụng.

## Kết luận: **ĐẠT**: 0 Nặng, 0 Trung bình, 4 Thấp (không chặn merge)

TB-1, TB-2 và T-1 đến T-5 đã được sửa đúng, có test giữ, và đột biến ngược lại đều bị test giết. Quyết định của phòng (`head-ok`,
`respond:'json'`, intercom) làm đúng như ADR-205 bổ sung.

## Kiểm chứng đã chạy

| Lệnh | Kết quả |
|---|---|
| jest `--maxWorkers=2`: `apps/hub-api/test/ingest*`, `source-response-redact`, `redis-budget`, `libs/providers/test`, `verify/test/gates` | 31 suite PASS (1 skipped = describeDb), 411 test |
| jest `libs/common/test/error-catalog` + `apps/hub-api/test/error-filter` | 2 suite PASS, 12 test |
| jest `apps/web/src/lib/hub` + `apps/web/src/lib/i18n` | 8 suite PASS, 77 test |
| `tsc --noEmit` hub-api / hub-worker / web | sạch |
| `verify:gates` | 22 luật, 0 vi phạm, 14 ngoại lệ có lý do |
| `catalog:build --check` | khớp (24 mục) |

Đột biến (đã trả lại):

| Đột biến | Kết quả |
|---|---|
| PATCH `return updated` (bỏ `consoleSource`) | **chết**: `source-response-redact` đỏ |
| Bỏ `if (this.extractSignature(...) !== null) return null` (header-echo) | **chết**: 1 test đỏ |
| Bỏ nhánh `if (method === 'HEAD')` trả 200 sớm | **chết**: 3 test đỏ |
| Dòng bắt tay dùng `rejectedLimiter` (20) thay `handshakeLimiter` (5) | **chết**: 1 test đỏ |
| `!timingSafeCompare(presented[0], expected)` thành `presented[0] !== expected` | **gate `sig-compare` đỏ** (1 vi phạm) |

## Đối chiếu từng mục

1. **TB-1, đã đóng.** Tôi grep mọi đường trả source:
   - Console list/create/PATCH đều đi qua `consoleSource` (`source-input.ts`). Service API list/create đi qua `publicSource`, hàm này gọi
     `publicVerificationConfig`. Không có route GET chi tiết source và không có PATCH source ở service API.
   - Audit `source.create`/`source.update` chỉ ghi `{provider,name,sourceKey}` và `data` (name/isActive/keepLonger). Không có config.
   - Inspect chỉ trả `handshake` meta (`kind`, `subscribeUrl`) và diagnosis. Không có config.
   - Archive, storage, traffic và source-connection có đọc `findSourceById`, nhưng không trả object source ra ngoài.
   - Test mới phủ cả 5 đường và kiểm cả việc ciphertext/bản rõ có xuất hiện trong JSON hay không.
2. **TB-2, đã đóng ở mức hợp lý.**
   - `handshakeConflict` chạy ở cả hai nhánh `validateGenericConfig` (thường và signed-template). Hai `return ok: true` còn lại là
     helper nội bộ, không phải lối ra.
   - Header-echo ở runtime bỏ qua mọi request mang chữ ký theo `extractSignature`. Hàm này phủ đúng chữ ký ở header khác nhau:
     standard-webhooks (`webhook-*`/`svix-*`), static-token (header/query/basic qua `presentedToken`), signed-template
     (`signature.headers`) và `c.header`. Nếu provider ký luôn cả request bắt tay header-echo thì bắt tay hỏng (đi verify), nhưng
     không nuốt sự kiện. Đó là chiều an toàn.
   - Slack `when:{field:'type', equals:'url_verification'}`: sự kiện thật có `type: event_callback`, nên không khớp. SNS
     `x-amz-sns-message-type = SubscriptionConfirmation`: Notification có giá trị khác, nên không khớp.
   - `respond:'json'` chỉ đổi khuôn trả lời, không đổi điều kiện khớp.
   - Lỗ còn lại xem T-a.
3. **`head-ok`, đúng.**
   - `acceptsMethod('HEAD')` chỉ đúng khi `kind === 'head-ok'`. Adapter native không cài `acceptsMethod` nên chỉ nhận POST, và HEAD
     vẫn ra 405.
   - HEAD trả 200 ở `ingest.service.ts:506`. Chỗ này đứng SAU checkIp, PK0, QT3, checkPair và TRƯỚC khi giải mã secret, bắt tay,
     verify, persist.
   - Không ghi DB, không phạt, 0 Redis. Không vào lưu lượng (`recordTraffic` cần `outcome`, mà HEAD không có), metric là `HEAD_OK`.
   - HEAD có body: vẫn bị trần 413 (1MB), body bị bỏ qua.
   - Express 5 dẫn HEAD vào handler `@Get` với `req.method='HEAD'`, Node không gửi body. Test HTTP thật cho 200 với `text()` rỗng.
   - Source dùng `head-ok` thì GET vẫn 405, còn POST ký đúng vẫn ACCEPTED (có test).
4. **T-2 limiter.**
   - Limiter 5/phút/source nằm trong bộ nhớ của từng instance, nên N instance cho tối đa 5N dòng. Trần cũ S1-4 cũng vậy, chấp nhận
     được.
   - Dòng bắt tay chỉ lưu meta: `body {}`, `bodyRaw` rỗng, SubscribeURL ≤ 1024 ký tự. Headers vẫn lưu nguyên (đã che), xem T-c.
   - Vượt trần thì request vẫn được trả lời bắt tay, chỉ không ghi DB. Trần 20/phút của đường ký sai không bị bắt tay tiêu.
5. **T-3 gate, đúng.**
   - Bắt được đột biến token và có test riêng cho cả trường hợp dương lẫn âm.
   - Hai ngoại lệ (`kv.sig` ở `generic-config.ts:671` và `signed-template.ts:67`) có lý do: đó là so TÊN khoá cấu hình, không phải
     giá trị chữ ký.
   - Hằng `AFTER_VERIFY_KIND` để né gate đã bị bỏ. Chỗ gate còn bỏ sót: xem T-b.
6. **414.** Body đổi thành `{error:'uri_too_long', message}`. Tôi grep apps/libs/examples/docs/verify: không client, e2e hay hub-sdk
   nào dựa vào câu cũ. Test duy nhất (`ingest-handshake.spec.ts:317`) chỉ kiểm status. Đã có trong `ERRORS.md` và catalog. Nằm trong
   `dist/` cũ thì không tính.
7. **Intercom** (WebFetch 2026-10-14, trang *Setting up webhooks* và *Webhook models*):
   - HEAD: tài liệu nói endpoint "must be able to receive a HEAD request, which we use to validate the URL". Tài liệu không nêu mã
     trả về; 200 hợp lý.
   - Chữ ký: `X-Hub-Signature: sha1=<hex>`, HMAC-SHA1 trên body JSON, khoá là `client_secret`. Entry khớp: `algo sha1`, `encoding hex`,
     `prefix sha1=`.
   - Chống trùng: `id` là "Intercom defined id representing the notification". Tài liệu không nói id giữ nguyên khi gửi lại; entry
     đã ghi rõ rủi ro này.
   - Retry: một lần sau 1 phút, nên chống trùng ít khi bị thử. Nhận xét thêm: Intercom coi 410 là tắt subscription. Hub không trả 410
     nên không sao.
8. **Khác.**
   - T-1: afterVerify slack/twitch có test cho cả ký đúng và không ký. Không ký thì đi `rejectStatus` và bị phạt, không echo, không ghi
     dòng.
   - T-4: twitch 600s.
   - T-5: 405 không gọi `traffic.record`/`traceIngested`.
   - Console `handshakeConflicts` khớp với server.

---

## Thấp

### T-a: `when` giá trị trùng giá trị sự kiện thật vẫn nuốt sự kiện được
- Validator chặn tên header/trường chung. Nó không chặn trường hợp khai `when:{field:'type', equals:'event_callback'}` (Slack) hoặc
  `equals:'notification'` trên header loại thông điệp của Twitch. Khi đó mọi sự kiện cùng loại đều nhận 200 mà không COMMIT.
- Lỗi do giá trị cấu hình nên không chặn tổng quát được.
- Đề xuất rẻ: console cảnh báo khi một source có ≥ N dòng `handshake` trong 5 phút ("bắt tay lặp lại, có thể đang nuốt sự kiện").
  Đây là phần TB-2(3) chưa làm. Làm ở PK6 cũng được.

### T-b: gate `sig-compare` bỏ qua định danh có đuôi `Header`
- `CONFIG_NAME_SUFFIX_RE` loại `…Header`. Nhưng trong ingest, `signatureHeader` lại là GIÁ TRỊ chữ ký (`adapter.extractSignature`).
  Vì vậy `signatureHeader === x` lọt gate.
- Hiện không có dòng nào như vậy. Đề xuất: chỉ miễn đuôi config khi định danh là thuộc tính (`c.xxxHeader`, `h.xxxField`), hoặc
  đổi tên biến thành `presentedSignature`.
- Gate cũng không xét `Buffer.equals` (CLAUDE.md cấm), và phạm vi không phủ console. Ví dụ
  `source-connection.service.ts` `x.value === entered` so secret giải mã với secret người dùng nhập. Kẻ ngoài không đo được thời gian
  ở đây, nên rủi ro rất thấp, chỉ ghi lại.

### T-c: dòng bắt tay "meta-only" vẫn lưu headers nguyên
- Body bị bỏ, nhưng `storedHeaders` không có trần, có thể tới ~16KB theo giới hạn header của Node.
- Ước tính: 5 dòng/phút × 16KB ≈ 115 MB/ngày/source/instance trong trường hợp xấu nhất kẻ biết sourceKey cố bơm. Con số này vẫn
  thấp hơn trước, vì trước đây mỗi dòng là 20 × (4KB + headers). Giảm khoảng 4 lần chứ không phải 100 lần như dự tính.
  CAPTURE_MAX ở PK6 nên áp cho cả headers.
- Ghi chú "≤ 1KB" trong code và ADR chỉ đúng cho meta, không đúng cho cả dòng.

### T-d: `head-ok` không bao giờ hiện "Đã bắt tay ✓"
- HEAD không ghi dòng, nên tab Lắng nghe của Intercom đứng ở "chưa nhận gì" cho tới sự kiện đầu tiên. Đây là đánh đổi có chủ ý
  (0 ghi DB).
- Nên có một câu gợi ý trên console cho source `head-ok` ("Intercom kiểm URL bằng HEAD; hub trả 200 nhưng không lưu").
