# REVIEW EG lượt 5 — `ede7c4b` (feat/edge)

> Reviewer: Murat (kiến trúc sư test) · 2026-10-12 · worktree `C:\wt\edge`, HEAD = `ede7c4b`
> Phạm vi: "loại cặp tốt công bằng theo tenant khi chạm trần toàn cục (bucket O(1)); kẹp GOOD_MAX_ENTRIES ≤ 500k; forgetGoodKey" — lượt sửa cho mục Nên sửa của review lần 4.

## Kết luận: **ĐẠT** (kèm 1 Trung bình, 2 Nên sửa, 3 Thấp — không mục nào chặn merge)

Mục Nên sửa của lần 4 đã đóng: kịch bản 157 project × 64 key không còn đẩy được key nạn nhân. Đã kiểm bằng probe chạy trên code thật (thay `fairVictim` bằng thuật toán cũ thì nạn nhân bị chặn, test mới đỏ; với code mới thì nạn nhân còn). Bất biến đếm đúng sau mọi đường (fuzz 40 × 4000 thao tác, không lệch lần nào). Không đụng tới Redis/DB hay fail-open. Còn lại hai việc. (1) Con số "500k ≈ 55MB" trong DEPLOYMENT/ADR sai khi mỗi key chỉ có 1 IP, mà đó lại là trường hợp phổ biến. (2) Thứ tự trong bucket không theo hoạt động, nên ở chế độ mọi tenant chỉ còn 1 key, key **đang hoạt động** của nạn nhân bị loại trước key nằm im của kẻ xấu.

## 1. Đúng chưa — thuật toán và bất biến

**Độ phức tạp.** `retally` chỉ đổi số key ±1. `maxTenantKeys` tăng ngay, còn khi giảm thì vòng `while` lùi tối đa 1 bậc, vì bucket `to = from-1` vừa nhận tenant. Giữ được bất biến "bucket `maxTenantKeys` khác rỗng". `fairVictim` trả kết quả ngay ở bucket cao nhất. Chỉ có một ngoại lệ: tenant đang gọi nằm một mình trong bucket 1 và key duy nhất của nó là `keep`. Khi đó phải bỏ qua đúng 1 phần tử, vẫn O(1). Vòng `while` loại toàn cục chạy ≤ 1–2 lần mỗi `markGood`: mỗi lần chỉ thêm 1 key và 1 mục, và mọi key trong `good` có ≥ 1 IP. → **O(1) khấu hao: đúng.**

**Bất biến.** Viết probe kiểm sau **mỗi** thao tác:
- Σ`ips.size` = `goodEntries`.
- Mỗi key của `good` nằm trong `tenantKeys[e.tenantId]`, và ngược lại.
- Không có Set tenant nào rỗng.
- Tenant nằm đúng bucket `= tk.size`; không có bucket rỗng; số tenant trong các bucket = `tenantKeys.size`.
- `maxTenantKeys` = bucket lớn nhất.
- `good.size ≤ maxGoodKeys`, `goodEntries ≤ goodMaxEntries`.

Thao tác ngẫu nhiên gồm `markGood` (có cả gọi lại cùng key với tenant **khác**), `forgetGoodKey`, `checkIp` (đi qua `isGood` hết hạn → `removeGoodKey`), `recordBadSignature`. Đồng hồ giả để `sweepExpiredGood` chạy. Trần nhỏ được chọn ngẫu nhiên. **Kết quả: 40 × 4000 thao tác, 0 vi phạm.**

**Tấn công nhiều project.**
- Theo trần key: nạn nhân 1 key chỉ bị đụng khi mọi tenant đều ≤ 1 key và tổng > `maxGoodKeys`, tức kẻ xấu cần ≈ 10k project. Khớp ADR.
- Theo trần mục: xem **NÊN-1**, cỡ `goodMaxEntries/goodIpsPerKey` ≈ 6.250 project, mỗi project 16 IP. IPv6 /64 thì rẻ.
- Chế độ bucket 1: xem **TB-1**.

**Nạn nhân ít key có bị loại oan không.** Khi trần key bị đẩy tới, không bị (test `small`: B giữ 2 key thì b1 bị loại, không phải a1). Khi trần mục bị đẩy tới thì có (NÊN-1).

## 2. Kẹp 500k

| Env `EDGE_PENALTY_GOOD_MAX_ENTRIES` | Kết quả |
|---|---|
| `0`, `-5` | 2000 (min) |
| `2000000`, `1e9`, `499999.6` | 500000 |
| `abc`, `Infinity` | 100000 (mặc định) |
| `" "` (khoảng trắng) | **2000** — `Number(' ') = 0` (THẤP-3, đã có từ trước) |

Constructor còn có `Math.max(goodIpsPerKey, …)`: `goodIpsPerKey ≤ 1024 < 2000`, nên an toàn. Phần biên: đúng. Nhưng không có test nào khẳng định kẹp 500k (NÊN-2), và trần cũng chưa đủ bảo vệ RAM (TB-2).

## 3. forgetGoodKey

- **Không có ai gọi** (`grep` toàn `apps/ libs/`: chỉ có định nghĩa). App không có đường xoá cứng source/project. Xoá source = lưu trữ (ADR-161). `sourceKey @unique` và không đổi được, nên hôm nay key không thể đổi tenant. Comment `markGood` mô tả đúng điều này.
- Hàm chỉ uỷ cho `removeGoodKey`: đếm đúng, idempotent, đã được fuzz phủ. Không rò bộ nhớ, không lệch đếm.
- Nếu sau này dùng thì lưu ý: hộp phạt là bộ nhớ **riêng từng instance**. Gọi `forgetGoodKey` trong request xử lý ở instance A không xoá được cache của instance B. Đường chuyển source giữa project lúc đó cần broadcast, hoặc dựa vào TTL. (THẤP-1)

## 4. Không phá

- `markGood` vẫn chỉ được gọi qua `penaltySafe` (`ingest.service.ts:449`), nên fail-open giữ nguyên. Code mới không có đường ném lỗi nào ngoài lỗi lập trình.
- Chỉ có Map/Set trong bộ nhớ: 0 Redis, 0 DB. `redis-budget.spec.ts` PASS.
- ADR-177 bổ sung theo kiểu append. BB-1..BB-5 không bị đụng.

## 5. Test

- Test mới `penalty-box.spec.ts:315` (157 × 64 + victim): **đỏ nếu bỏ fix**. Đã chứng minh: thay `fairVictim` bằng "key cũ nhất toàn cục" thì `checkIp(gh,'victim').blocked = true`. Phần `small` cũng đỏ với thuật toán cũ, vì khi đó a1 bị loại.
- Thiếu test cho: kẹp 500k; `forgetGoodKey`; loại công bằng theo đường **trần mục**; bất biến bucket sau khi hết hạn. Xem NÊN-2.
- Tên test cũ `penalty-box.spec.ts:276` ("…loại key hoạt động cũ nhất") giờ mô tả sai chính sách (THẤP-2).

## Danh sách lỗi

### Trung bình

**TB-1 — Trong cùng bucket, thứ tự là lúc *vào bucket*, không phải lúc *hoạt động*. Ở chế độ bucket 1, key đang chạy của nạn nhân bị loại trước key nằm im của kẻ xấu.**
- Vị trí: `penalty-box.ts:294–296` (key đã có thì không `retally`, nên tenant không bị đưa về cuối bucket); `penalty-box.ts:324` (`for (const t of tenants)` lấy tenant vào bucket sớm nhất).
- Kịch bản (probe 3, đã chạy): `maxGoodKeys=100`. Victim V có 1 key, vào bucket 1 sớm nhất. 99 tenant kẻ xấu mỗi tenant 1 key. V vừa gửi request đúng (`markGood(victim)`). Thêm 1 tenant kẻ xấu → **`victim` bị loại, `a0` (im từ đầu) còn**. Ở cấu hình mặc định cần ≈ 10k project (hoặc ≈ 6.250 theo NÊN-1). Lúc đó, nếu IP chung (GitHub) đang bị luật (a) ban, request kế tiếp của V bị 429 trước verify, không bao giờ được `markGood` lại, nên V mất webhook cho tới khi ban hết hạn. Global LRU cũ còn che được nạn nhân *đang hoạt động*. Thuật toán mới bỏ mất tính chất đó đúng ở chế độ nguy hiểm nhất.
- Mức: Trung bình, vì chi phí tấn công cao (≈ 10k project) nhưng là hồi quy so với tính chất cũ. Có thể hạ xuống Nên sửa nếu Admin chấp nhận.
- Gợi ý (O(1)): khi chạm key đã có (`!isNew`), đưa tenant về cuối bucket hiện tại: `const b = keyCountBuckets.get(tk.size); b.delete(t); b.add(t);`. Bucket khi đó là LRU theo hoạt động của tenant. Thêm test: N tenant 1 key, victim chạm cuối, tenant N+1 vào → victim còn, tenant im nhất bị loại.

**TB-2 — "500k ≈ 55MB" sai ở trường hợp phổ biến (1 IP/key). Trần RAM thật do `maxGoodKeys` quyết định, mà trần này vẫn kẹp tới 1.000.000.**
- Vị trí: `penalty-box.ts:93` (`maxGoodKeys` kẹp 100–1.000.000); `docs/DEPLOYMENT.md:444–446` ("~110 byte/mục: 500k ≈ 55MB"); ADR-177 bổ sung lần 4.
- Đo trên code thật (`node --expose-gc`, heapUsed):
  - 100k key × 1 IP: **≈ 573 byte/key**.
  - 6.250 key × 16 IP: ≈ 131 byte/mục.
  - Nếu operator đặt `GOOD_MAX_KEYS=1000000`, `GOOD_MAX_ENTRIES=500000`: tối đa 500k key × ~573 B ≈ **~290MB** trên Render 512MB cho cả hub-all, không phải 55MB. Thường gặp nhất là provider gửi từ 1–2 IP mỗi key.
- Mặc định (10k key, ≈ 5–6MB) vẫn an toàn. Lỗi nằm ở trần cấu hình và tài liệu mà commit này đưa ra làm bảo đảm.
- Gợi ý: hạ kẹp trên `maxGoodKeys` (vd ≤ 100k ≈ 57MB). Sửa DEPLOYMENT thành "~575 byte/key + ~130 byte/mục; RAM tối đa ≈ maxGoodKeys×575 + goodMaxEntries×130". Thêm test kẹp.

### Nên sửa

**NÊN-1 — Áp lực ở trần *mục* (IP), nhưng "công bằng" lại đo bằng *số key*.**
- Vị trí: `penalty-box.ts:307–311`.
- Kịch bản (probe 4, đã chạy): `goodMaxEntries=2000`. Victim V có 3 key × 1 IP (3 mục). 130 tenant kẻ xấu mỗi tenant 1 key × 16 IPv6 /64 (16 mục). Kết quả: **V còn 1/3 key**. V chiếm 3 mục nhưng bị coi là "giàu nhất". Ở mặc định, cỡ 100k/16 ≈ 6.250 project là đẩy được nạn nhân 1 key, rẻ hơn con số "≈ 10k" trong ADR.
- Gợi ý (chọn một): (a) khi vượt `goodMaxEntries`, ưu tiên cắt IP cũ nhất của key có nhiều IP nhất, hoặc chạy bucket theo số **mục** mỗi tenant (đổi ±1 mỗi IP, bước loại key là ≤ goodIpsPerKey); (b) tối thiểu sửa ADR: chi phí ≈ `min(GOOD_MAX_KEYS, GOOD_MAX_ENTRIES/GOOD_IPS_PER_KEY)` project, và nói rõ max-min fairness cắt tenant lớn (64 key) xuống k key chỉ cần ≈ `GOOD_MAX_KEYS/k` project (vd 312 project cắt còn 32 key).

**NÊN-2 — Thiếu test cho các hành vi mới.**
- Kẹp 500k: `resolvePenaltyConfig({EDGE_PENALTY_GOOD_MAX_ENTRIES:'2000000'}).goodMaxEntries === 500000`. Hiện đổi lại 2.000.000 thì không test nào đỏ.
- `forgetGoodKey`: đếm về 0, bucket sạch, gọi 2 lần không lỗi.
- Loại công bằng theo đường trần mục.
- Bất biến bucket sau `sweepExpiredGood`/`isGood` hết hạn. Có thể bê nguyên hàm `check()` trong probe thành test fuzz L0 nhỏ (< 100ms).

### Thấp

- **THẤP-1** — `forgetGoodKey` (`penalty-box.ts:315`) là API chết, chưa có test. Comment "vd source đổi project / bị xoá" ngầm hứa một đường không tồn tại, và nếu có thì phải xử lý đa instance. Đề nghị: ghi rõ "chưa ai gọi, chỉ có hiệu lực trên instance hiện tại", hoặc bỏ cho tới khi có đường gọi (YAGNI).
- **THẤP-2** — Tên test `penalty-box.spec.ts:276` "…loại key hoạt động cũ nhất" và comment đầu file `penalty-box.ts:23` ("vượt thì loại key hoạt động cũ nhất") giờ mô tả sai chính sách. Sửa thành "loại key cũ nhất của tenant giữ nhiều key nhất".
- **THẤP-3** — `clampEnvInt` (`penalty-box.ts:78`): env là chuỗi khoảng trắng thì `Number(' ')=0`, kẹp về **min** chứ không về mặc định. Lỗi có từ trước, ảnh hưởng mọi biến `EDGE_PENALTY_*` (vd `GOOD_MAX_ENTRIES=" "` → 2000). Dùng `v.trim()===''`.

Ghi chú (không phải lỗi): Set/Map của JS dùng làm LRU thì để lại "lỗ" ở đầu sau nhiều lần xoá. V8 compact khi rehash, nên iterate đầu vẫn O(1) khấu hao. Kiểu này giống `good`/`counting` đã có.

## Lệnh đã chạy và kết quả

| Lệnh | Kết quả |
|---|---|
| `git show ede7c4b` / `--stat` | 6 file, +82/−12 |
| `npx tsc -p apps/hub-api/tsconfig.json --noEmit` | exit 0 |
| `npx jest apps/hub-api/test/penalty-box.spec.ts apps/hub-api/test/redis-budget.spec.ts` | 2 suite, **26/26 PASS** |
| `node --expose-gc -r ts-node/register/transpile-only -r tsconfig-paths/register <scratchpad>/r5/probe.ts` (probe chỉ đọc, import code thật) | FUZZ OK 40×4000; RED CHECK thuật toán cũ → victim bị chặn (test mới đỏ); BUCKET ORDER victim bị loại, a0 còn (TB-1); ENTRY CAP victim còn 1/3 (NÊN-1); bảng kẹp ở §2; MEM 573 B/key, 131 B/mục (TB-2) |
| `npm run verify:map` | `341 mã · 270 có test · 0 mồ côi · 24 có lý do · 0 ma · 0 trùng` — XANH. Lệnh tự ghi lại `docs/TEST-MAP.md` (header đổi thành "chưa chạy" vì worktree mới chưa có kết quả verify) → đã khôi phục nội dung về `HEAD` bằng `git show HEAD:docs/TEST-MAP.md > …`; `git diff --stat` rỗng (chỉ còn khác EOL). `libs/hub-sdk/bin/hub.js` hiện "M" chỉ do EOL từ bước cài, không phải do reviewer. |

Không sửa mã nguồn, không commit, không dùng Docker, không gửi request tới hạ tầng thật.
