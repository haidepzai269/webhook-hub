# REVIEW-PK5 lượt 3: sửa theo REVIEW-PK5-R2

Reviewer độc lập (Sally 🎨 console · Grumbal ⚠️), 2026-10-14.
Phạm vi: `feat/pk` @ `C:\wt\pk`, commit `35c3ac1` (TB-1b, T-a..T-e của REVIEW-PK5-R2).

## Kết luận: **ĐẠT** (0 Nặng · 0 Trung bình · 1 Thấp)

TB-1b đã đóng: xem nhanh và bước ① không còn ghi "Chữ ký hợp lệ" hay tô xanh cho sự kiện chưa xác thực. T-a..T-e đều đúng và có test, đột biến làm test đỏ.
Còn 1 lỗi Thấp: luật gác (phần q) chưa bắt được hai biến thể. Không chặn merge.

## Đã chạy

| Việc | Kết quả |
|---|---|
| jest `--maxWorkers=2`: `apps/web/src/lib/hub` (gồm `unverified`, `listen-logic`), `apps/web/src/components/flow`, `i18n/dictionary`, `libs/providers/test/generic-unverified`, `apps/hub-api/test/ingest-unverified` | 18/18 suite, 195/195 test đạt |
| `tsc --noEmit`: web, hub-api | sạch |
| `verify:gates` | 22 luật, 0 vi phạm |

Mọi đột biến đều đã được trả lại (`git checkout`). `git status` chỉ còn `libs/hub-sdk/bin/hub.js`, là WIP có từ trước. Không commit.

## 1. Không còn "hợp lệ" hay tông xanh cho sự kiện chưa xác thực

Đã grep rộng trong `apps/web/src`, tìm các chuỗi `signatureValid`, `signature-valid`, `hợp lệ`, `valid`, `✓`, `emerald`, và `tone "ok"`:

- **Khoá `page.events.sheet.signature-valid`**: chỉ còn được dùng qua `SIGNATURE_VIEW.valid`. Giá trị này chỉ được chọn khi `signatureView` kết luận cả event lẫn raw đều không mang `verified:false` ✓
- **`event-sheet.tsx` và `trace-timeline.tsx`**: cả hai dùng chung `SignatureBadge`. Sự kiện chưa xác thực hiện nhãn hổ phách "Chưa xác thực", bước ① có `tone="warn"` (`bg-amber-500`) ✓
  - Server có trả đủ dữ liệu cho việc này: `findEventDetail` dùng `rawEvent: true`, nên trả cả `raw_events.verified` lẫn `events.verified` ✓
- **Các chỗ xanh còn lại không nói gì về chữ ký**: `trace-feed` (outcome ACCEPTED), playground (HTTP 2xx), `status-badge` (SUCCEEDED), bước ②/③ của timeline (COMMIT / chuẩn hoá), `listen.handshaken` ✓
- **`listen.connected` ✓**: đã có nhánh `connected-unverified` màu hổ phách. `listen.reason.ok` không dùng được cho nguồn unverified (R2 đã xác nhận) ✓
- **Chặng `verified` phía server** (`build-event-flow.ts`): khi `raw.verified === false` thì trả `warning` với title "Chưa xác thực — đích tự kiểm chữ ký". Không tạo nhánh "… hợp lệ" ✓

## 2. Luật gác (phần q): thử đột biến

| Đột biến | Kết quả |
|---|---|
| M-A: `event-log.tsx` thêm `(i as any).signatureValid ? <emerald>{t("…signature-valid")}` | ĐỎ ✓ |
| M-B: như M-A nhưng dùng destructuring `({ signatureValid }) => …` (có khoá i18n) | ĐỎ ✓ (bắt nhờ khoá i18n) |
| M-E: `SIGNATURE_VIEW.unverified.tone = "ok"` | ĐỎ ✓ (phần p) |
| M-F: `signatureView` bỏ nhánh `isUnverified(ev.rawEvent)` | ĐỎ ✓ (phần p) |
| **M-C**: destructuring `({ rawEvent: { signatureValid } }) => signatureValid ? <emerald>✓ {t("flow.stage.verified")}` | **XANH ✗** |
| **M-D**: `trace-timeline.tsx` đổi thành `tone={(raw.signatureValid && "ok") \|\| "bad"}` | **XANH ✗** |

## Thấp

### T-f. Luật gác (phần q) có hai lỗ
1. Regex `\.signatureValid\b` không bắt được destructuring. Nếu bản sửa sau không dùng khoá `signature-valid` (ví dụ dùng ✓ + `flow.stage.verified`), đoạn mã lọt qua (M-C).
2. Điều kiện "file có gọi `isUnverified(`" chỉ xét ở mức cả file. Một file đã gọi `isUnverified` ở chỗ khác (event-sheet, trace-timeline) có thể quay lại suy tông từ riêng `signatureValid`, miễn là không viết dạng `signatureValid ?` (M-D).

Mã hiện tại sạch, nên đây chỉ là độ chặt của gác.

**Đề xuất** (tuỳ, không chặn):
- Đổi regex thành `\bsignatureValid\b`, loại trừ `types.ts`, `unverified.ts` và các file messages.
- Ở hai file event-sheet và trace-timeline, cấm mọi lần đọc `signatureValid` (bất kể dạng toán tử), thay cho việc chỉ cấm dạng `signatureValid\s*\?`.

## 3. T-a..T-e

| Mục | Kiểm | Đột biến |
|---|---|---|
| T-a: badge ở nhật ký trang Luồng | `<UnverifiedBadge of={i} />` có ở `event-log.tsx`. File đã nằm trong danh sách gác `(phần o)` ✓ | (gác tĩnh) |
| T-b: tooltip DUPLICATE của nguồn unverified | `verifiedOk` chấp nhận `warning` khi `i.verified === false`. Nếu `verified` vắng thì vẫn hiện "chưa chạy" ✓ | bỏ nhánh warning → ĐỎ ✓ |
| T-c: ước lượng cộng content-type | `estimateUnverifiedEnvelopeBytes` cộng `JSON.stringify(contentType).length`, và adapter truyền `req.contentType` ✓. Test so với `toWebhookBody` thật, có ca 413 với content-type khoảng 64KB ✓ | bỏ `+ contentType` → ĐỎ ✓ |
| T-d: câu cảnh báo khi cờ tắt | Câu vi/en đã nhắc "kể cả request bắt tay — bật cờ rồi đăng ký lại URL" ✓ | (test chuỗi) |
| T-e: `event_trimmed` | Đã có trong `ReplaySkipReason` và `SKIP_LABEL`, nhãn vi/en đủ. `tsc` ép `Record<ReplaySkipReason, …>` phải đủ khoá ✓ | (test + tsc) |
