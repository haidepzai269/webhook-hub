# REVIEW DX-A vòng 2 — 2026-10-11

Người review: reviewer độc lập (vòng 2). Phạm vi: `9243043` (Q1=a, ADR-139), phần M-1/L-5 nằm lẫn trong `c888ef6` (ADR-143),
`80a98bd` (rỗng), `9293868` (M-2/L-3 docs), `546e9c3` (TX trong spec §9). Không review phần KN1 của `c888ef6`.

## Kết luận: **GO-with-fixes** — 0 Blocker · 0 High · 1 Medium · 4 Low

Push được. Ack từ chối không đổi status nên không có đường nào trả 2xx trước COMMIT, và không có lời từ chối nào thành 2xx.
`after=latest` đúng (không bỏ sót event, RLS hoạt động bằng `hub_app`). Riêng R2-M1 nên sửa sớm: 10 lô cấp cursor chạy trong
**một** transaction tương tác, chứ không phải mỗi lô một transaction như comment và ADR-143 ghi.

## Bằng chứng đã chạy

| Hạng mục | Kết quả |
|---|---|
| Jest: `ingest-reject-ack`, `ingest-generic`, `redis-budget`, `error-filter`, `polling-params`, `hub-sdk/listen`, `verify/test/hub-sim-adapters`, `common/error-catalog` | 8 suite · **64/64 pass** (chạy trên working tree; WIP của agent khác không động vào các file này) |
| `polling-db.spec.ts` trên Postgres hubv **bằng role `hub_app`** (`DATABASE_URL` lấy từ `verify/lib/compose.hostUrls()`, fixture bằng owner) | **8/8 pass**, gồm `[DX:UX11] M-1` |
| Probe M-1 (script ở scratchpad, không commit): 12 000 event `poll_seq IS NULL` trên hubv, repo bằng `hub_app` (`current_user=hub_app, rolsuper=false, rolbypassrls=false`) | Lần 1: 1 421–1 569 ms → `null`, còn 2 000. Lần 2: 344–351 ms → cursor, còn 0. **Một kết nối khác đếm song song chỉ thấy 12000 rồi 2000, không có số ở giữa**, tức cả 10 lô commit một lần (xem R2-M1) |
| `npm run verify:gates` | 14 luật · **0 vi phạm** · 7 ngoại lệ có lý do |
| `tsc --noEmit` (`apps/hub-api/src` + `libs/hub-sdk/src`) trên cây xuất bằng `git archive` | **HEAD (`3955b9f`): xanh.** `9293868`: **đỏ, 3 lỗi** (`use_endpoints_route`, `endpoint_owned_by_service` thiếu trong catalog; `publicSubscription` chưa export). `3955b9f` của KN đã vá. Lưu ý: kiểu `@prisma/client` sinh từ `schema.prisma` của working tree |

## 9243043 — ack từ chối qua `adapter.buildAck` (ADR-139)

- **Status:** `rejectAck` lấy `status` của lõi (401/422) và chỉ lấy `.body` từ adapter. Controller `/hooks` trả `res.status(result.status)` (`ingest.controller.ts:33`). Adapter trả status nào cũng không đổi được kết quả, nên **không lời từ chối nào thành 2xx được**.
- **BB-3:** đường chấp nhận (`persistAccepted` → `ackFor`) không đổi. `rejectAck` là hàm thuần, chạy **sau** `storeRejected`, không I/O. `redis-budget` xanh, và test khẳng định `setIdempotencyKey` không được gọi.
- **Body theo provider:** GitHub/Stripe giữ `{error}`. SePay chuyển sang `{success:false,message}`, PayOS sang `{code:'01',desc,data:null}`, Generic sang `{ok:false,error,fix}`. PayOS và SePay coi một lần gửi là thành công dựa trên HTTP 2xx (SePay còn đòi thêm `success:true`). 401/422 đã là thất bại bất kể body, nên **cách gửi lại của provider thật không đổi**. Phát hiện trùng vẫn trả 200 với body như cũ.
- **Không lộ thông tin:** `message` là hằng của lõi. Test có kiểm secret và marker trong body cho cả 5 provider. `fix` của Generic chỉ phụ thuộc status.
- **buildAck ném lỗi:** rơi về body cũ, status giữ nguyên (có test). Nếu buildAck trả `undefined` thì `.body` ném lỗi, cũng bị `catch` bắt.

## M-1 / L-5 (trong c888ef6) — đúng đắn

- **Không bỏ sót event:** khi lô cuối đầy và vẫn còn `poll_seq IS NULL`, hàm trả `null` (503), không trả max tạm. Khi cấp xong mới đọc `max(poll_seq)`. Event commit sau đó sẽ nhận `nextval` lớn hơn trong advisory lock của tenant. Đã đúng, và test DB xác nhận "latest ≥ mọi cursor".
- **RLS:** proxy `scopeToTenant` bọc cả `latestPollCursor` trong một tx có `set_config('app.project_id')`. `assignPollSeq` gọi bên trong chạy trên cùng tx. Đã chạy được bằng `hub_app`.
- **Không có bão retry phía server:** mỗi lần gọi tiến được ≤10 000 dòng, `Retry-After: 1`. CLI theo Retry-After, trần 30 s, rồi lùi dần 1/2/5 s.

## Phát hiện

| ID | Mức | File:dòng | Vấn đề | Kịch bản hỏng | Cách sửa |
|---|---|---|---|---|---|
| R2-M1 | **Medium** | `libs/database/src/tenant-scoped.repository.ts:370-388` (kèm proxy `:52-70`, `assignPollSeq` `:391-412`); ADR-143; comment dòng 367 | Comment và ADR-143 nói "mỗi lô vẫn là transaction ngắn". Thực tế proxy bọc **cả** `latestPollCursor` trong **một** `$transaction` tương tác, `this.prisma` bên trong là `tx` (không có `$transaction`), nên `assignPollSeq` rơi vào nhánh "đang ở trong tx". `pg_advisory_xact_lock` vì vậy bị giữ suốt 10 lô, và 10 000 UPDATE commit cùng một lần. Đã đo được: chỉ thấy 12000 rồi 2000, không có số ở giữa. Tx dùng timeout mặc định của Prisma là **5 s**. | Trên Neon free (0.25 CU, Singapore), với backlog ~10k của project chỉ dùng push: nếu 10 lô vượt 5 s thì gặp P2028 và **rollback toàn bộ**, client nhận 500 (không phải 503), CLI thử lại 1/2/5 s và lần nào cũng hỏng y như vậy. Đây là **livelock**: `listen --from latest` của project đó không bao giờ khởi động được. Trong lúc đó, mọi `pollEvents` có tồn của cùng tenant bị chặn ở advisory lock tới ~5 s và cũng có thể hết timeout. Local đo được 1,5 s/10k nên chưa xảy ra. Không sai dữ liệu, chỉ là không tiến được. | Cho mỗi lô commit riêng: gọi `assignPollSeq(batch)` qua **repo đã bọc proxy** ở mỗi vòng (mỗi lời gọi thành một tx), ví dụ chuyển vòng lặp ra controller hoặc tách `latestPollCursor` thành `assignPollSeq` × N (qua proxy) cộng `readMaxPollSeq()`. Hoặc ít nhất giảm trần (vd 3×1000) và truyền `timeout` rõ ràng. Sửa comment, ADR-143 và dòng "không giữ advisory lock/transaction vô hạn" ở ARCHITECTURE §18 cho khớp. Thêm test DB khẳng định có tiến độ trung gian (đếm song song). |
| R2-L1 | Low | `libs/hub-sdk/src/client.ts:245`; `libs/hub-sdk/src/cli.ts` `retryDelayMs` | `Number(header ?? body.retryAfter)`: header `Retry-After: 0` hoặc rỗng (`Number('')=0`) cho `retryAfter=0`, thành `sleep(0)`. Header dạng HTTP-date cho `NaN` nên bỏ luôn `retryAfter` của body. Hub luôn gửi ≥1, nhưng proxy (Render/Cloudflare) thì không chắc. | Proxy trả 429/503 với `Retry-After: 0`, CLI poll liên tục không nghỉ, bắn dồn dập vào hub và tốn quota. | Kẹp `Math.max(1000, …)` trong `retryDelayMs`. Khi header không ra số thì thử tiếp body. |
| R2-L2 | Low | `libs/hub-sdk/src/cli.ts` (vòng `--from latest`) | Thử lại mãi khi gặp 0/5xx, không có trần số lần và không có thông báo bỏ cuộc. | Kết hợp với R2-M1 hoặc hub sập lâu: CLI treo và in "hub busy" mãi. Chấp nhận được cho CLI dev (có Ctrl+C). | Tuỳ chọn: sau N lần in thêm gợi ý (`--from <cursor>` hoặc kiểm hub). |
| R2-L3 | Low | `apps/hub-api/src/modules/ingest/ingest.service.ts:246,255,267,278` | Chỉ 401/422 đi qua `rejectAck`. 413/400/404/429 vẫn trả `{error}` thô. `genericAckFix(413)` có viết nhưng **không bao giờ được gọi**. | Dev cấu hình nguồn Generic gửi body >1MB thì không nhận được `fix`. Khuôn ack không nhất quán, nhưng không ảnh hưởng gì tới provider. | Nếu muốn, cho 413 (sau khi biết adapter) đi qua `rejectAck`. Không thì xoá nhánh 413 trong `genericAckFix`. |
| R2-L4 | Low (lịch sử git) | `c888ef6`, `80a98bd`, `9293868` | `c888ef6` lẫn KN1 với M-1/L-5. `80a98bd` rỗng nhưng message mô tả code. `c888ef6`…`9293868` **không compile** (3 lỗi TS), `3955b9f` mới vá. | `git bisect` và revert từng phần bị nhiễu: revert `80a98bd` không gỡ được M-1, revert `c888ef6` thì kéo theo cả hai. CI khi push chỉ chạy HEAD nên vẫn xanh. | Không viết lại lịch sử đã chia sẻ. Ghi rõ trong RESUME-dx (đã ghi) và ADR-143 rằng code nằm ở `c888ef6`. |

## Docs (9293868, 546e9c3)

- M-2: QUICKSTART và ARCHITECTURE §18 đã nói đúng rằng `listen` chỉ giống production ở phần phong bì: không áp `eventTypes`/`sourceIds`, không có `renderedContent`, handler phải tự kiểm `source`. Đạt.
- L-3: `HUB_DOCS_URL` đã có trong `.env.example` và HUONG-DAN-DEPLOY. Đạt.
- Dòng "không giữ advisory lock/transaction vô hạn" đúng (có trần), nhưng nên sửa theo R2-M1: hiện đang là một tx tối đa 10 lô.
- 546e9c3: kết quả TX1/TX3/TX4 trong spec §9 nhất quán với RESUME. TX4 khẳng định `listen` không tạo delivery. Chỉ là tài liệu, không có rủi ro.

## Ghi chú về môi trường

Không rebuild image, không restart container, không dùng worktree, không chạy lệnh git phá huỷ. Probe tạo rồi xoá tenant ngẫu nhiên
trên hubv (đã dọn bằng `deleteMany`). Không sửa source, không commit.
