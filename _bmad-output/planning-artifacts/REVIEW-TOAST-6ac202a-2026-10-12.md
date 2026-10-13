# REVIEW — commit `6ac202a` "fix(web/alerts): toast viền theo mức, trượt xuống ở giữa"

Reviewer: Sally (UX) + Murat (test) · 2026-10-12 · chỉ đọc, không sửa mã.

Đã chạy:
- `npx tsc -p apps/web/tsconfig.json --noEmit` → **exit 0**
- `npx jest apps/web` → **23/24 suite, 237/238 test**; đỏ duy nhất: `notify-logic.spec.ts` [CB:T15] (xem Phần B — **không do 6ac202a**)
- Đối chiếu nguồn sonner 2.0.8 (`node_modules/sonner/dist/index.mjs`) cho `toasterId`, className của `<ol>`, CSS giảm chuyển động.

---

## A. Toast cảnh báo (6ac202a) — **ĐẠT có điều kiện** (1 MEDIUM cần xem trên trình duyệt trước khi chốt)

### Đúng yêu cầu
| Yêu cầu | Kết quả | Bằng chứng |
|---|---|---|
| Viền bao quanh theo mức (critical đỏ / warning hổ phách / info xanh), không mặc định đỏ | ĐẠT | `alert-toast.tsx:36-37` `border-[1.5px]` + `borderColor: SEVERITY_COLOR[severity]` → `--danger`/`--warning`/`--info` |
| Nhãn mức cùng tông | ĐẠT | `alert-toast.tsx:43-48`, `SEVERITY_TONE` `alert-ui.tsx:29-34` |
| Dark mode token | ĐẠT | `alerts.css` thêm `--info-subtle/--info-fg` ở cả `:root` và `.dark`; `--danger-*`, `--warning-*` đã có hai theme. Theme toaster lấy từ preferences store (wrapper `components/ui/sonner.tsx`) |
| Giữa phía trên, dưới header | ĐẠT | `(admin)/layout.tsx:67-75` `position="top-center"`, `offset.top=60` (header `h-12`=48 + 12) |
| Trượt từ trên xuống | ĐẠT | sonner: toast `data-y-position=top` → `--y: translateY(-100%)` → `translateY(0)` khi mounted; ra: trượt lên + mờ |
| Màn hẹp gutter 16px | ĐẠT | `mobileOffset {left:16,right:16}`; sonner ≤600px: toast `width: calc(100% - 2*16px)`, `left:0;right:0` |
| Toast thường vẫn góc phải | ĐẠT | Toaster mặc định giữ `top-right` (`layout.tsx:57-63`) |
| Không hiện đôi | ĐẠT | sonner 2.0.8 `index.mjs:987-989`: Toaster có `id` chỉ lấy `toast.toasterId === id`; Toaster không id lấy `!toast.toasterId`. `showAlertToast` truyền `toasterId: "alerts"` (`alert-toast.tsx:85`) |
| Mount ở mọi layout cần | ĐẠT | Cả hai Toaster ở `(admin)/layout.tsx` (bọc login + dashboard). `showAlertToast` chỉ gọi từ `AlertNotifier` (mount ở `(admin)/dashboard/layout.tsx:76`). `(shop)` không dùng cảnh báo — không cần |
| Giảm chuyển động đúng selector | ĐẠT | `className` của Toaster gắn lên `<ol data-sonner-toaster>` (`index.mjs:1159`) → `.alert-toaster [data-sonner-toast]` (0,2,0)!important thắng `[data-sonner-toast]{transition:none!important}` (0,1,0) của sonner; chỉ trả `opacity` → vị trí nhảy, chỉ mờ |
| Không đổi logic/aria | ĐẠT | diff chỉ đụng class/style/toaster; `role="status"`, `aria-label` nút đóng giữ nguyên; `notify-logic.ts` không đổi |

### Lỗi / rủi ro
- **[MEDIUM] `alert-toast.tsx:36` — `w-[356px]` → `w-full` làm toast co theo nội dung và lệch trái trên desktop.**
  `toast.custom` → `data-styled=false` (`index.mjs:712`) nên sonner KHÔNG đặt `width: var(--width)` cho `<li>`; `<li>` là `position:absolute`, và sonner chỉ có luật `left:0`/`right:0` cho x-position left/right — **không có cho `center`**. `<li>` vì thế rộng shrink-to-fit (≤ 356px của `<ol>`), `w-full` của div = 100% của `<li>` đó. Cảnh báo có tiêu đề/mô tả ngắn sẽ ra toast hẹp, dính mép trái của khung 356px ⇒ không còn "ở giữa", và 3 toast xếp dọc có độ rộng khác nhau. (Màn ≤600px không bị: sonner tự đặt width.)
  Sửa đề xuất: `w-[var(--width)] max-w-full` (hoặc giữ `w-[356px] max-w-full`), hoặc trong `alerts.css`: `.alert-toaster [data-sonner-toast]{width:var(--width)}` bọc `@media (min-width:601px)`. Kiểm bằng mắt với một toast ngắn (vd tiêu đề 2 từ, không mô tả).
- **[LOW] Hai vùng `aria-live`/hai phím tắt Alt+T.** Mỗi Toaster render một `<section aria-live="polite" aria-label="Notifications alt+T">` và đăng ký hotkey riêng → hai landmark trùng nhãn; Alt+T focus cả hai (cái sau thắng). Đề xuất `containerAriaLabel` riêng cho Toaster alerts (vd "Cảnh báo") — không chặn merge.
- **[LOW] Giảm chuyển động khi đóng:** `transform` nhảy tức thì nên toast "giật" lên một chiều cao rồi mới mờ; toast còn lại trong chồng `expand` cũng nhảy chỗ. Đúng tinh thần "không trượt", chấp nhận được; nếu muốn mượt hơn có thể giữ `--y: translateY(0)` cho `[data-removed=true]` trong media reduce.
- **[INFO]** `info` không bao giờ ra toast (`routeArrival` → `none`), nên viền xanh dương hiện chỉ là phòng xa — không sai.

---

## B. [CB:T15] `notify-logic.spec.ts` đỏ — **không phải lỗi của 6ac202a; là test "bom hẹn giờ"**

### Có từ trước 6ac202a không?
- `git diff 6ac202a~1 HEAD -- apps/web/src/lib/alerts/` rỗng: logic và spec **không đổi** trong 6ac202a. (diff thô bằng `git show` ra khác do CRLF, không phải nội dung.)
- Test đỏ trên HEAD với **cùng mã** đã từng xanh ⇒ yếu tố đổi là **thời gian chạy**.

### Nguyên nhân gốc (đã chứng minh)
- `notify-logic.ts:118-131` `takeArrivals(mem, rows, now = Date.now())`: lần đầu đặt `mem.baselineAt = now`; các lần sau một dòng chỉ là "vừa đến" khi `socketOpened.has(id) || Date.parse(openedAt) >= baselineAt` (**dòng 128**, review L3).
- Spec `notify-logic.spec.ts:120-121` gọi lần đầu **không truyền `now`** → `baselineAt = Date.now()` thật; fixture `alert()` cố định `openedAt: "2026-10-12T10:00:00.000Z"` (`spec:43`).
- ⇒ Test xanh khi chạy **trước 2026-10-12 10:00Z (17:00 giờ VN)**, đỏ mọi lúc sau đó. Chỉ `c-new` sống sót vì nó được miễn nhờ `noteSocketNotice` — khớp đúng triệu chứng `["c-new"]`.
- Probe (transpile `notify-logic.ts`, cùng dữ liệu, chỉ đổi `now` của lần mốc): `09:59Z`/`10:00Z` → `c-new,c-other,w-new,i-new` (đủ); `10:00:01Z` và giờ hiện tại → `c-new`. `TZ=UTC` cho cùng kết quả ⇒ **không phải timezone/locale/Windows/thứ tự**, là phụ thuộc đồng hồ thật.
- Các test L3 khác đã truyền `now` tường minh (`spec:137`) nên không bị.
- Sửa test đề xuất: `notify-logic.spec.ts:121` truyền mốc tường minh `takeArrivals(mem, [alert("c-old","critical")], Date.parse("2026-10-12T09:59:00Z"))` (hoặc `jest.useFakeTimers().setSystemTime(...)` trong `describe`). Thêm luật: mọi test của hàm có `now = Date.now()` phải tiêm `now`.

### Có liên hệ với quan sát trên stack demo không?
Không phải "chỉ phát cho phần tử đầu/critical": `takeArrivals` lọc từng phần tử độc lập, `routeArrival` đúng cho mọi mức (probe cho `w-new → toast 6000`). **Nhưng** test đỏ chỉ đúng vào điểm yếu thật của cùng điều kiện ở dòng 128:

1. **[HIGH — giả thuyết cần đo] Toast warning của project khác bị nuốt khi đồng hồ worker chậm hơn đồng hồ trình duyệt.**
   - `opened_at` = `now` của lượt evaluator, **đồng hồ hub-worker** (`alert.evaluator.ts:242`, ghi ở `:454` → `tenant-scoped.repository.ts:1064`). `baselineAt` = **đồng hồ trình duyệt** (`alert-notifier.tsx:64`). So hai đồng hồ khác máy.
   - Cảnh báo của project KHÁC không bao giờ có `alert.changed` (gateway chỉ emit vào `project:<tenant>:ops` của project đang mở — `realtime.gateway.ts:176-179`), nên nó **chỉ** qua được bằng `openedAt >= baselineAt`. Worker trong Docker Desktop/WSL2 hay trễ giờ sau khi máy ngủ → cảnh báo mở *sau* khi tải trang vẫn có `opened_at` *trước* mốc → bị coi là "cũ", **không toast**. Thêm một ca biên không cần lệch giờ: `opened_at` là giờ *bắt đầu lượt*, lượt bắt đầu trước khi trang tải xong nhưng commit sau → cũng bị bỏ.
   - Critical của project đang mở thì có `alert.changed` → miễn kiểm thời gian → hiện ngay (banner). Nếu critical "toast ngay" ở demo là của project KHÁC thì giả thuyết lệch giờ yếu đi — cần biết critical đó thuộc project nào.
   - Đo (Admin tự chạy, reviewer không dùng docker): so `date -u` trong container hub-worker với giờ máy host; hoặc trong DevTools so `openedAt` của cảnh báo warning với thời điểm tải trang.
   - Sửa đề xuất (không sửa): bỏ so sánh chéo đồng hồ — lấy mốc từ **server**, vd `baselineAt = max(openedAt)` (hoặc header `Date`/trường `asOf` của response lần đầu) thay `Date.now()`, rồi so `openedAt > baselineAt` theo cùng đồng hồ; hoặc dùng id/seq tăng dần thay thời gian. Thêm test: worker lệch −2 phút, cảnh báo project khác mở sau mốc → phải toast.

2. **[MEDIUM — chắc chắn] Trang Cảnh báo không tự cập nhật cho cảnh báo project khác.** `useAlertsPage` (`alert-queries.ts:52-60`) **không có `refetchInterval`**, và `QueryProvider` đặt `refetchOnWindowFocus: false` (`query-provider.tsx:16`) ⇒ trang chỉ làm mới khi có `alert.changed` (chỉ project đang mở) hoặc ack ⇒ project khác: phải tải lại. Sửa: thêm `refetchInterval: ALERT_POLL_MS` như summary/openFeed.

3. **[INFO] Chuông:** summary + openFeed có poll 30s (`alert-queries.ts:34,46`), `refetchIntervalInBackground:false` ⇒ cảnh báo project khác lên chuông trễ tới 30s (và dừng khi tab ẩn). Nếu Admin thấy chuông "không bao giờ" cập nhật dù tab hiển thị >30s thì là chuyện khác cần đo (Network tab: `/api/v1/alerts/summary` có gọi mỗi 30s không).

---

## Tóm tắt
- 6ac202a: **ĐẠT có điều kiện** — đúng mọi yêu cầu (viền theo mức, top-center dưới header, trượt xuống, reduced-motion đúng selector, gutter 16px, không hiện đôi, toast thường vẫn góc phải, tsc xanh). 1 MEDIUM: `w-full` (`alert-toast.tsx:36`) làm toast ngắn co hẹp + lệch trái trên desktop — kiểm mắt / đổi `w-[var(--width)]`. 2 LOW (hai vùng aria-live trùng nhãn; nhảy vị trí khi đóng ở reduced-motion).
- CB:T15 đỏ: **không do 6ac202a**, logic/spec không đổi; test bom hẹn giờ — spec:121 không tiêm `now`, fixture `openedAt` 10:00Z ⇒ đỏ sau 17:00 VN 12/10. Không phải timezone/locale/Windows. Sửa: tiêm `now`.
- Liên hệ demo: không phải bug "chỉ phần tử đầu"; nhưng `notify-logic.ts:128` so `opened_at` (đồng hồ worker) với `Date.now()` (trình duyệt) — cảnh báo project khác chỉ qua được điều kiện này ⇒ worker trễ giờ là nuốt toast warning (HIGH, cần đo lệch giờ). Trang Cảnh báo không poll (`alert-queries.ts:52-60` + `refetchOnWindowFocus:false`) ⇒ phải tải lại (MEDIUM, chắc chắn).
