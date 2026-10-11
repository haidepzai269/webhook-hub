# REVIEW — DX phương án A + C-1 (2026-10-11)

Người review: reviewer độc lập (không viết code này). Phạm vi: `72ee8a7` (C-1), `fc40e29` (DX3), `d6b1a00` (DX3b), `74bf617` (DX1-lite), `6c5b78a` (DX2 rút gọn), `5a43fc9` (docs).
Commit VF của phiên khác (`df4e65e`, `e4566db`, …) không thuộc phạm vi.

## Kết luận: **GO**: được push lên production

Không có mục Blocker, cũng không có mục High. Các mục Medium/Low bên dưới làm sau được, trừ một điều kiện khi triển khai (L-1): hub-api phải deploy trước hoặc cùng lúc với CLI.

## Bằng chứng đã chạy

| Lệnh | Kết quả |
|---|---|
| `npx jest -w 2` (L0) | 98 suite pass / 23 skip (describeDb) · 736 test pass / 0 fail |
| `npm run verify:gates` | 14 luật · 0 vi phạm · 7 ngoại lệ có lý do (BB-1, BB-5, sig-compare, topology… đều xanh) |
| `polling-db.spec.ts` chạy L1 trên Postgres hubv (`hub_app`, RLS) | 7/7 pass, có `[DX:UX11] latestPollCursor` |
| `npx tsc -p libs/hub-sdk --noEmit` | sạch |
| Dò guard localhost của `hub listen` bằng tay | `http://localhost@evil.com` → bị từ chối (host = evil.com); `http://[::ffff:127.0.0.1]` → bị từ chối; `localhost.evil.com`, `127.0.0.1.nip.io`, `localhost%2eevil.com` đều ra hostname khác `localhost` nên bị từ chối; `[0:0:0:0:0:0:0:1]`, `127.1`, `0x7f000001`, `LOCALHOST` được chuẩn hoá thành địa chỉ loopback nên được cho qua (đúng) |

## Kết quả theo trọng tâm

1. **WebhookSender → `toWebhookBody`: byte-identical trên đường production.** Thứ tự khoá giữ nguyên: id, type, source, sourceId, subject, normalized, data, occurredAt, receivedAt, renderedContent. Khác biệt duy nhất là `subject: event.subject` đổi thành `event.subject ?? undefined`. Hai cách này chỉ cho ra body khác nhau khi `subject === null`. Nhưng `WebhookSender.send` chỉ có một chỗ gọi (`delivery.consumer.ts:290`), và event ở đó dựng từ `toNormalizedEvent`, vốn đã đổi `subject: e.subject ?? undefined` (`delivery.consumer.ts:77`). `occurredAt`/`receivedAt` vốn là chuỗi ISO, nên `iso()` trả nguyên chuỗi. Chữ ký vẫn tính trên đúng `bodyString`, cũng là bytes được POST đi (`swHeaders(..., bodyString, ...)` → `postLimited(url, bodyString)`). UX9 kiểm `Buffer.equals` giữa push và listen trong cả hai trường hợp subject null và subject có giá trị. **Không có regression cho Shop.**
2. **Error filter:**
   - Không lộ dữ liệu. 5xx chỉ trả `internal_error`/`service_unavailable`, không có `detail`; nội dung gốc chỉ ghi vào log (UX5).
   - Tham số trong body lọc theo whitelist `params` của catalog. Body-parser lỗi (JSON hỏng) không chép message, vì message đó chứa một đoạn body.
   - `detail` chỉ là câu do code hub tự viết. Đã grep mọi `message:` có nội suy trong `api|console|flow|service-api`: không câu nào chứa key, secret, header chữ ký hay body. Không chỗ nào chuyển tiếp `err.message`.
   - Filter chỉ thu hẹp những gì Nest trả mặc định trước đây, không mở thêm.
   - `not_found` không có `detail`, và `fix` là hằng (UX2).
   - `/hooks/*` đi `super.catch`, giữ nguyên định dạng cũ. Thứ tự BB-3 không bị đụng tới. `GenericAdapter.buildAck` chỉ thêm `fix`, status giữ nguyên.
   - Không status nào bị đổi trên các đường mà web/SDK/shop/hub-sim/L2 đang dựa vào. Mọi mã mà `auth-e2e.ts` kiểm (`csrf_failed`, `missing_scope`+`required`, `last_owner`) đều có trong catalog. `/auth/*` không đi qua filter. Shop chỉ log `e.message`/`e.code`. SDK đọc `error`, `fix`, `requestId`.
   - 502/504 nay gộp thành 500, nhưng hiện không route dev-facing nào ném 502/504. 503 chỉ có ở `/auth` OAuth.
3. **Web:** `errorMessageOf` ưu tiên `detail` (câu Việt), sau đó tra câu Việt theo mã, cuối cùng mới dùng `message`. Trang auth gọi `fetch('/auth/...')` trực tiếp nên không bị ảnh hưởng. `describeDeleteConflict` vẫn nhận `subscriptionCount`/`deliveryCount`, vì chúng là params của `conflict`, có test.
4. **`after=latest`:**
   - Đi qua `prisma.forTenant(req.tenantId)`, dùng `TenantScopedRepository.latestPollCursor` có `WHERE tenant_id`. Thoả BB-5 và RLS (L1 chạy bằng `hub_app`).
   - Xét các trường hợp đua: (a) assigner khác đang giữ advisory lock. Rows của nó vẫn là NULL trong mắt mình, nên `pending=true`, mình chờ lock rồi mới đọc max, max đó đã gồm rows của nó. (b) Event commit sau lần assign của mình nhưng trước `SELECT max`, và đã được listener khác gán seq. Event đó commit trước khi response trả về nên bỏ qua là đúng nghĩa "latest". (c) Event commit sau đó luôn nhận `nextval` lớn hơn, vì advisory lock theo tenant xếp các lần gán thành chuỗi tuần tự.
   - **Không bỏ sót event commit muộn.**
5. **`hub listen`/`hub trigger`:**
   - Guard localhost chắc chắn, vì so khớp hostname đã được WHATWG URL chuẩn hoá. `redirect: 'manual'` chặn trường hợp app local redirect sang host ngoài.
   - Key không bao giờ bị in ra: connection string không được echo; `maskKey`; lỗi bất ngờ ở bin chỉ in `e.name`; có UX15.
   - Chỉ đọc (`/me` và `GET /events`), không làm thay đổi state của hub. Backoff 1/2/5 s, reset sau lần poll thành công.
   - `trigger` đi qua `client.publish` → `POST /events` → `validatePublishBody`/`validateCanonical` → ingest bình thường. Idempotency key `trigger-<base36 ms><40 bit ngẫu nhiên>` tất định cho mỗi lần gọi: hai lần gọi chỉ trùng khi cùng mili-giây và trùng 40 bit, xác suất không đáng kể.
   - Mẫu không chứa mã đơn (BB-1).
6. **C-1:**
   - Cả bốn đường `challenge` (create/verify/rotate/adopt) đều ghi audit khi FAILED. Đã grep đủ cả 4 call site. Đường rotate/adopt giữ nguyên secret và trạng thái.
   - Metadata chỉ gồm `verificationError` + `attempt` (+`secretRotated:false`), không có URL hay secret.
   - Hai instance đua nhau có thể ghi trùng một dòng. Điều này đã được chấp nhận ở ADR-131 và vô hại.
   - SDK `ensure` khi có `signingSecret` luôn đi đường `rotate`, nên vòng retry của Shop dedupe được.
7. **ADR:** 131 (C-1), 132 (VF3), 133 (DX3), 134 (DX3b), 135 (VF4), 136 (DX1). Không trùng số, nội dung khớp code. Test có ý nghĩa: UX9 so bytes thật qua HTTP thật; UX11 chạy cả Postgres thật; trigger test dùng `validatePublishBody` thật của hub-api; UX3/UX5 kiểm chuỗi nhạy cảm không xuất hiện trong response.

## Phát hiện

| ID | Mức | File:dòng | Vấn đề | Kịch bản hỏng | Đề xuất sửa |
|---|---|---|---|---|---|
| M-1 | Medium | `libs/database/src/tenant-scoped.repository.ts:333-341` (`latestPollCursor`) | Vòng `while (assignPollSeq() >= 1000)` không có trần, chạy đồng bộ trong một request HTTP. `poll_seq` chỉ được gán khi có người poll. Project chỉ dùng push (vd Shop) sẽ tích luỹ toàn bộ event mới với `poll_seq IS NULL`. | Lần đầu chạy `hub listen` trên project đã có N×1000 event chưa gán: request `after=latest` chạy N transaction liên tiếp, mỗi cái giữ advisory lock, tạo tải ghi lên Neon. Với volume lớn có thể vượt timeout proxy (Render ~100 s), và CLI báo lỗi. Kết quả không sai, chỉ chậm và tốn tài nguyên. | Đặt trần số vòng (vd 50) rồi trả 503 `service_unavailable` kèm fix "thử lại", hoặc chỉ gán MỘT lần rồi trả `max(seq)` nếu không còn NULL. Ngoài ra có thể ghi chú trong ADR-133. Volume demo của đồ án nhỏ nên làm sau được. |
| M-2 | Medium | `libs/common/src/webhook-body.ts`, `libs/hub-sdk/src/cli.ts:84` · `docs/ARCHITECTURE.md` §18 | "Parity" chỉ đúng ở mức phong bì. `listen` không biết subscription nên: (a) không bao giờ có `renderedContent` (push có, nếu subscription có template); (b) forward mọi event key đọc được, không lọc theo `eventTypes`/`sourceIds` của subscription (R-1). | Dev thử handler ở local, nhận được event từ source mà endpoint production đã ghim loại ra, hoặc thiếu `renderedContent`. Code chạy được ở local nhưng hành vi khác production. | Ghi rõ trong QUICKSTART/ARCHITECTURE §18 rằng parity là của phong bì, không phải của bộ lọc subscription. Gợi ý `--types` và cân nhắc thêm `--source <id>` sau. |
| L-1 | Low (điều kiện deploy) | `libs/hub-sdk/src/cli.ts:141,208` | CLI mặc định `--from latest`. Hub-api chưa có DX3 sẽ trả 422 `validation_failed` cho `after=latest`. Cursor rác đổi từ 422 sang 400, là breaking nhỏ cho client ngoài repo. | Deploy CLI/QUICKSTART trước hub-api thì `listen` thoát ngay ("Reading latest cursor failed"). | Deploy hub-api cùng đợt (cùng repo), smoke `GET /v1/p/<p>/events?after=latest` ngay sau deploy. Ghi chú này đã có ở SPEC §8.10, chỉ cần làm theo. |
| L-2 | Low | `apps/hub-api/src/modules/errors/request-id.ts:13-15` | `isDevFacingPath` so sánh phân biệt hoa thường, nhưng router Express mặc định không phân biệt. | `GET /V1/P/x/events` vẫn tới controller, nhưng lỗi đi `super.catch`, tức định dạng Nest cũ, không có `requestId`. Không lộ gì mới so với trước DX1. | So khớp `toLowerCase()`, hoặc bật `caseSensitive` routing. |
| L-3 | Low | `libs/common/src/errors/catalog.ts` `docsUrlFor` · `docs/DEPLOYMENT.md` | `HUB_DOCS_URL` chưa có trong env của deploy. `docsUrl` ở production là `docs/ERRORS.md#<mã>`, đường dẫn tương đối nên không bấm được. | Dev nhận lỗi trên bản deploy, link tài liệu không mở được. | Thêm `HUB_DOCS_URL=https://github.com/<repo>/blob/master/docs/ERRORS.md` vào env Render và DEPLOYMENT.md. |
| L-4 | Low | `libs/hub-sdk/src/cli.ts:241-259` | Vòng forward của một trang (≤100 event × timeout 10 s) không kiểm `signal`. | Ctrl+C lần 1 có thể phải chờ rất lâu khi app local treo. Ctrl+C lần 2 thoát ngay nhưng mất dòng "Last cursor". | `if (signal?.aborted) break;` trong vòng `for`, cursor vẫn là event cuối đã forward. |
| L-5 | Low | `libs/hub-sdk/src/cli.ts:231-239` | Lỗi poll 429 (và 4xx tạm thời khác) làm `listen` thoát luôn, thay vì backoff. | Long-poll bị rate limit thì phiên listen chết, dev phải chạy lại với `--from`. | Xử lý 429 như 5xx (backoff, ưu tiên `retryAfter`). |
| L-6 | Low | `libs/hub-sdk/src/cli.ts:142,215` | `--secret whsec_…` nằm trên argv nên hiện trong danh sách tiến trình. Dòng "Ready" in `target.toString()`, có thể kèm userinfo nếu dev đặt vào URL forward. | Lộ secret phiên (chỉ dùng ở local) cho user khác trên cùng máy. | Usage khuyên dùng `HUB_LISTEN_SECRET`; in `target.origin + pathname`. |
| L-7 | Low | `apps/web/src/lib/hub/ui-logic.ts:113-125` | `VI_BY_CODE` thiếu `bad_request`, `validation_failed`, `conflict`, `unsupported_media_type`… | Lỗi không có `detail` (JSON hỏng, 413, `ValidationPipe` không message) hiện câu tiếng Anh ở console. Không chặn chấm vì tiêu chí không chấm UI. | Bổ sung câu Việt cho các mã suy từ status. |
| L-8 | Low | `libs/hub-sdk/bin/hub.js:12-13` | Bin ưu tiên `dist/cli.js` nếu tồn tại, kể cả khi `src` mới hơn. | Dev pull code mới mà không build lại, `npx hub` chạy bản cũ (vd thiếu `trigger`). | So mtime của `src/cli.ts` và `dist/cli.js`; nếu `src` mới hơn thì cảnh báo hoặc dùng ts-node. |
| L-9 | Low | `CAN-ADMIN-QUYET-DX.md` Q1 | `fix` của `GenericAdapter.buildAck` chưa tới tay dev cho 401/422, vì lõi ingest trả thẳng mà không qua adapter. | Spec DX1 §2.1 mới đạt một phần. | Chờ Admin chọn (a)/(b). Không ảnh hưởng production. |

## Không phát hiện

Các mục sau đã kiểm, không có vấn đề:

- Rò rỉ key/secret/header chữ ký/body/IP nội bộ trong body lỗi, kể cả trường `detail`.
- Đổi status mà client đang phụ thuộc.
- Đổi định dạng ack ở `/hooks/*` (ngoài trường `fix` của Generic).
- Vi phạm BB-1 đến BB-5.
- Thêm lệnh Redis vào đường nóng (`latestPollCursor` và C-1 dùng 0 lệnh Redis).
- Trùng số ADR.
