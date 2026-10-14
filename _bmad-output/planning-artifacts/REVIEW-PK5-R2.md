# REVIEW-PK5 lượt 2: sửa theo REVIEW-PK5

Reviewer độc lập (Grumbal ⚠️ bảo mật · Sally 🎨 console · Murat 🧪 test), 2026-10-14.
Phạm vi: `feat/pk` @ `C:\wt\pk`, commit `d39d8f8` (sửa TB-1, TB-2, T-1..T-9 của REVIEW-PK5).

## Kết luận: **KHÔNG ĐẠT** (0 Nặng · 1 Trung bình · 5 Thấp)

TB-2, T-1, T-2, T-3, T-7 và T-9 đã được sửa đúng.
TB-1 mới đóng được phần lớn: chặng "Xác thực", Lắng nghe, lý do định tuyến và badge đều đúng ở các màn đã liệt kê.
Còn **xem nhanh (event-sheet)** vẫn ghi "Chữ ký hợp lệ" hai lần, kèm chấm ① xanh, cho sự kiện chưa xác thực. Đây chính là kịch bản TB-1.
Phần sửa còn lại nhỏ: hai file `.tsx` và một luật gác tĩnh.

## Đã chạy

| Việc | Kết quả |
|---|---|
| jest `--maxWorkers=2`: `libs/common/test/flow` (build-event-flow, health), `flow-unverified`, `generic-unverified`, `ingest-unverified`, `delivery-unverified`, `unverified-access`, web `lib/hub/unverified` + `listen-logic`, `i18n/dictionary`, `error-catalog`, `redis-budget` | 12/12 suite, 138/138 test đạt |
| `tsc --noEmit`: hub-api, hub-worker, web, hub-sdk | sạch |
| `verify:gates` | 22 luật, 0 vi phạm |
| `catalog:build --check` | khớp (26 mục) |
| Đột biến TB-2: `delivery.consumer.ts` `verified: true` cố định | **ĐỎ**: 2/2 test `delivery-unverified` (webhook + Telegram/Discord) ✓ |

Đột biến đã được trả lại (`git checkout`). `git status` chỉ còn `libs/hub-sdk/bin/hub.js`, là WIP có từ trước. Không commit.

## 1. TB-1: nhãn console

| Chỗ hiện event | Kết quả |
|---|---|
| Hành trình (chi tiết `/events/[id]`): chặng `verified` | `warning` "Chưa xác thực — đích tự kiểm chữ ký", lý do `unverified_source`. Badge lấy từ `journeyUnverified(data)` ✓ |
| Danh sách hành trình (`events/page.tsx`) | badge + chấm mini màu hổ phách (FlowService truyền `verified` vào raw của list) ✓ |
| Bảng sự kiện (`event-columns`), lượt giao + DLQ (`delivery-columns`, `include: event` đủ cột) | badge ✓ |
| Chặng `routed` | `unverified_not_accepted` khi `!eventVerified && !acceptUnverified`, đúng luật router; `acceptUnverified` đã có trong `select` ✓ |
| Lắng nghe | `diagnose` ACCEPTED của `unverified` → `reason: 'unverified'`; `listenReasonKey` không rơi về `ok`; dòng kết nối dùng `connected-unverified` (không ✓) ✓ |
| Execution status | `warning` ở chặng `verified` không đổi `succeeded`/`in_progress` (deriveExecutionStatus chỉ xét failed/pending) ✓ |
| **Xem nhanh: `event-sheet.tsx:80-84` + `trace-timeline.tsx:84-90`** | **✗ xem TB-1b** |
| Nhật ký sự kiện ở trang Luồng (`components/flow/event-log.tsx`) | không có badge, chỉ có chấm mini hổ phách (decorative). Xem T-a |
| Socket.IO `trace-feed` / `realtime-card` / alerts | chỉ có outcome/đếm, không hiện "hợp lệ" ✓ |

## Trung bình

### TB-1b. Xem nhanh vẫn ghi "Chữ ký hợp lệ" cho sự kiện chưa xác thực (khoá 2)
- Nguồn `unverified` ghi `raw_events.signature_valid = true` (`ingest.service.ts:255`, cố ý để không bật cảnh báo signature_failing).
- `event-sheet.tsx:80` hiện badge `page.events.sheet.signature-valid` ("Chữ ký hợp lệ") theo `rawEvent.signatureValid`.
- `trace-timeline.tsx:84-89` (bước ① trong cùng sheet) hiện `tone="ok"` (`bg-emerald-500`, xanh) và lại ghi "Chữ ký hợp lệ".
- Hậu quả: tiêu đề có badge "Chưa xác thực" hổ phách, nhưng ngay bên dưới hai chỗ nói "Chữ ký hợp lệ", một chỗ tô xanh. Đây đúng là kịch bản TB-1 lượt 1 ("nhân viên mở … thấy Chữ ký hợp lệ ✓"). Nút xem nhanh nằm ngay trên danh sách hành trình.
- Gác tĩnh `[PK:T16](phần o)` chỉ kiểm *có* `<UnverifiedBadge>`, không kiểm *không còn* nhãn "hợp lệ". Vì vậy lỗ này lọt qua.
- **Đề xuất**:
  - Ở cả hai chỗ: khi `isUnverified(ev) || isUnverified(ev.rawEvent)`, thay badge "Chữ ký hợp lệ" bằng nhãn hổ phách "Chưa xác thực" (dùng lại `page.events.unverified`), và đổi bước ① sang `tone` cảnh báo.
  - Thêm luật gác: mọi file `.tsx` dùng `page.events.sheet.signature-valid` phải nhắc tới `isUnverified`/`journeyUnverified`. Gỡ nhánh nào thì đỏ.

## Thấp

- **T-a. Trang Luồng, nhật ký sự kiện (`event-log.tsx:345`)** không có `<UnverifiedBadge>`. Dòng ghi chú (`describeEvent`) vẫn là "momo.ipn — đã giao 1/1", và nhãn chỉ còn ở chấm mini decorative. Nên thêm badge, hoặc hậu tố "· chưa xác thực" vào ghi chú, rồi đưa file vào danh sách gác.
- **T-b. Tooltip chấm `persisted` (`event-notes.ts:234`)**: `verifiedOk` đòi `status === 'ok'`. Vì vậy dòng DUPLICATE của nguồn `unverified` có tooltip "chưa chạy" thay vì "trùng". Nên coi `warning` + `reason.code === 'unverified_source'` là đã qua.
- **T-c. T-3, ước lượng phong bì chưa tính `data.contentType`.** Header `content-type` do bên gửi kiểm soát. Phần cố định 1KB chỉ dư khoảng 500B sau id/type/timestamps, nên với content-type dài ≥ ~0,5KB và body sát trần, ước lượng có thể thấp hơn thật, làm sót ACK→DEAD. Nên cộng `JSON.stringify(contentType).length`, và thêm content-type dài vào test `[PK:T38](f)`. Ngoài lỗ này, ước lượng ≥ thật trên các ca thử (ký tự phải thoát, query 8KB, header) ✓. 413 dùng đúng mã catalog `unverified_body_too_large` (status 413), fix nhắc URL/header ✓, ERRORS.md đã cập nhật ✓.
- **T-d. Câu cảnh báo T-9 (`page.sources.unverified-blocked`)** chưa nói hệ quả của T-1. Nên thêm: "kể cả request bắt tay — bật cờ rồi đăng ký lại URL ở nhà cung cấp". Không có câu này, dev bật cờ xong mà provider đã đánh dấu URL hỏng thì vẫn không thấy gì.
- **T-e. Web `ReplaySkipReason` thiếu `event_trimmed`.** Đây là nợ có sẵn từ QT7, không phải do PK5. Server có lý do này, còn `SKIP_LABEL` ở DLQ thì rơi về mã thô. Lý do mới `unverified_not_accepted` đã đủ (type, nhãn vi/en, ERRORS.md, comment controller) ✓.

## 2. TB-2: đường giao thật ✓

`delivery-unverified.spec.ts` dựng `DeliveryConsumer` thật cùng các sender thật (Webhook/Telegram/Discord), chặn axios, giải mã config thật, dùng `findDeliveryForSend` giả trả `row.event.verified`. Webhook kiểm `"verified":false/true` (kể cả khi cột vắng), Telegram/Discord kiểm tiền tố `[Chưa xác thực]`. Đột biến tự thử lại thì đỏ.
Còn một rủi ro: nếu `findDeliveryForSend` đổi sang `select` mà bỏ `verified`, test vẫn xanh vì repo là mock. Tầng DB do `describeDb`/CI phủ, chấp nhận.

## 3. T-1: cờ tắt thì không trả lời bắt tay

**Chấp nhận được.**
- Khi cờ tắt, request **sự kiện** đã bị 401 từ trước. T-1 chỉ thêm việc request **bắt tay** cũng bị 401. Hành vi nhất quán với §7.1 ("tắt cờ = ngừng nhận, không ghi"), có test 0 ghi / không phạt / không lộ challenge.
- Nguy cơ provider tự tắt webhook:
  - Shopify gỡ webhook sau chuỗi giao thất bại kéo dài (~48h). KiotViet/Haravan thì retry rồi dừng. Cả ba ca này đều do **sự kiện** bị từ chối, vốn đã xảy ra trước T-1, nên T-1 không làm tệ thêm.
  - Với provider có bắt tay lúc đăng ký (Slack url_verification, Zoom CRC, Haravan `hub.challenge`): đăng ký thất bại ngay và dev thấy liền. Riêng Zoom kiểm lại định kỳ 72h, lỗi có thể khiến Zoom vô hiệu endpoint, nhưng lúc đó cờ đã tắt, tức chủ project chủ động ngừng nhận.
- Đánh đổi "bật cờ sau khi dán URL thì phải đăng ký lại" đã ghi ADR-206(b). Cần đưa câu này lên console (T-d).
- Không cần đổi mã 401 thành 503. 503 khiến provider retry vô hạn với một cấu hình cố ý tắt.

## 4. T-2 ✓
`markGood` chỉ chạy khi `verdict.verified`, có test bằng spy qua IngestService thật.

## 5. T-7 ✓
`replaySkipReasonOf` là hàm thuần, thứ tự kiểm khớp `findDeadDeliveryRefs`. `unverifiedBlocked` được tách khỏi `replayable`, nên subscription/đích bị tắt vẫn báo `destination_unavailable` trước. Web type, nhãn vi/en và ERRORS.md (đoạn replay hàng loạt) đều đủ.

## 6. Khác
- T-4, T-6 được ghi trong ADR-206 bổ sung (e)(g). Nội dung runbook rollback rõ ràng ✓.
- T-5 sửa docstring đúng sự thật, nợ đã ghi vào SPEC §16 ✓. T-8 ghi vào SPEC §16 ✓.
- Ngân sách Redis: `redis-budget` xanh. T-2 bỏ bớt `markGood` (thao tác trong bộ nhớ, 0 lệnh Redis), nên không ảnh hưởng ✓.
