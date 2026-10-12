# SPEC QT — Hạn mức dung lượng theo project (cảnh báo trước, khoá sau)

> Phòng party viết ngày 2026-10-12. Mã test: `QT:T1–T34` (T28–T34 thêm ở mục Đính chính). Thêm namespace `QT` vào `verify/spec-sources.json` theo khuôn KN.
> **ADR dùng ADR-182..187 + ADR-189.** ADR-174 thuộc docs-sync DS4, ADR-165..173 thuộc alerts (CB), ADR-175..179 và ADR-181 thuộc edge (EG), ADR-180 thuộc `feat/email-cuckoo`, **ADR-188 dành cho fix toast theo đồng hồ server** (master). Grep lại trước khi ghi.

> ⚠️ **ĐÃ GIAO DEV 2026-10-12** (worktree `C:\wt\qt`, nhánh `feat/qt`). Admin đã chốt toàn bộ (Q1–Q11) và đính chính E1–E6 bên dưới. Agent dev đọc **mục Đính chính trước**, rồi đọc phần thân; mâu thuẫn thì mục Đính chính thắng. LLM cho bộ gợi ý là việc sau.

## ĐÍNH CHÍNH SAU EG (2026-10-12, Admin chốt) — mục này thắng phần thân

> Lý do có mục này: spec QT viết trước khi EG (chống quá tải) lên master. EG đã đổi thứ tự ingest (EG3, D3) và đã có bảng lưu lượng gộp trong bộ nhớ (EG4, migration `20261012090000_source_traffic`, `apps/hub-api/src/modules/ingest/traffic-recorder.ts`). QT dựa lên đó thay vì làm lại.
> Phần thân bị thay thế: §2 (cách đo), §3 (bảng nấc), §4 (thứ tự, điều kiện 507), §6 (nhịp đo toàn cục), §7 (job đo), §8–§9 (ai thấy cảnh báo), §11 (ADR-183, thêm ADR-189), §12 (thêm T28–T34), §13.

### E1. "Giữ lâu" được nhận tới trần cứng 110% (Admin chọn phương án Mary)

**Vấn đề:** ở 100% mọi source bị 507 như nhau. Source mà user đã gắn "Giữ lâu" (thường là thanh toán) bị cắt cùng lúc với source rác. Hub không được đoán source nào quan trọng (BB-1), nhưng **user đã tự nói** qua cờ `sources.keep_longer`.

**Nấc mới (thay bảng §3):**

| Nấc | Vào khi | Hạ khi | Source thường | Source "Giữ lâu" |
|---|---|---|---|---|
| `OK` | < 70% | — | nhận | nhận |
| `WARN_70` / `WARN_85` / `CRITICAL_95` | như §3 | thấp hơn ngưỡng 5 điểm | nhận | nhận |
| `LOCKED` | ≥ 100% | **< 90%** (vùng đệm như cũ) | **507** | **nhận** |
| `HARD_LOCKED` | ≥ **110%** | < 100% (về `LOCKED`, rồi theo vùng đệm của `LOCKED`) | 507 | **507** |

- `110` là hằng số `HARD_LIMIT_PCT` trong `levelFor`, **không** phải env (bớt một núm vặn). Hạn mức user thấy vẫn là 100%. 10% là phần dôi để thanh toán không chết cùng rác, không phải hạn mức thứ hai.
- Quyết định chặn là hàm thuần `isWriteBlocked(level, keepLonger, lockEnabled)`: `lockEnabled && (level === 'HARD_LOCKED' || (level === 'LOCKED' && !keepLonger))`. Dùng chung cho `/hooks` và publish. Không `if (provider === …)`.
- **Hub không đoán nghiệp vụ (BB-1):** chỉ đọc cờ user tự gắn. Hub không tự gắn "Giữ lâu" cho source PayOS/Stripe.
- Cờ "Giữ lâu" là lối thoát có giá: source gắn cờ không được gợi ý dọn và không bị dọn tự động (§5.3), nên càng gắn nhiều thì càng nhanh chạm 110%. Công tắc ở console phải nói câu này.
- Email/webhook `hub.project.storage` phát cả ở `HARD_LOCKED` (đổi nấc là phát, như §3). Banner `LOCKED`: "Project đã ngừng nhận event mới, **trừ các source Giữ lâu** (còn nhận tới 110%)". Banner `HARD_LOCKED`: "Project đã ngừng nhận mọi event mới".
- `levelFor(used, quota, prevLevel)` giữ nguyên chữ ký, thêm nấc `HARD_LOCKED`. Cột `project_usage.level` là varchar nên không cần đổi enum.

### E2. Đo nhẹ: cộng dồn qua bộ gộp EG4 thay cho job quét 10 phút

**Bỏ** job quét `pg_column_size` mỗi 10 phút ở §7 và bỏ `STORAGE_MEASURE_INTERVAL_MS`. Quét toàn bộ mỗi 10 phút trên Neon free là đọc lại cả DB 144 lần/ngày để biết một con số mà ingest đã cầm sẵn trong tay.

**Đường nóng: +0 lượt DB, +0 lệnh Redis.**
- `traced()` đã gọi `traffic.record(tenantId, sourceId, outcome, ip)` (EG4). Thêm tham số `bytes`: số byte **thực sự ghi** xuống DB, tức `rawBody.length` (= `octet_length(body_raw)`) khi `ACCEPTED`; độ dài mẫu đã lưu (≤ 4KB) khi `REJECTED` có ghi mẫu; còn lại là 0 (`DUPLICATE`, `RATE_LIMITED`, `BLOCKED`, 507). Ô trong `Map` cộng thêm `bytes`, không có I/O.
- **Publish `/v1/p` cũng cộng:** `publishFromService` đã đi qua `traced()` với `trace.sourceId` = source `api` của key, nên tự cộng như `/hooks`.
- Flush 60s (`TRAFFIC_FLUSH_MS`) như cũ: `ON CONFLICT … DO UPDATE SET count = count + excluded.count, bytes = bytes + excluded.bytes`. Không thêm câu nào, chỉ thêm một cột.
- **Migration QT1:** `ALTER TABLE hub.source_traffic_minutely ADD COLUMN bytes bigint NOT NULL DEFAULT 0` + `ALTER TYPE hub."TrafficOutcome" ADD VALUE 'STORAGE_FULL'` (request bị 507 hiện trong khối "Lưu lượng", bytes = 0).

**Công thức (thay §2 về cách tính, định nghĩa "dung lượng" giữ nguyên):**

```
used_bytes = calibrated_bytes                                        -- mốc quét thật gần nhất
           + bloat_factor × Σ bytes(source_traffic_minutely, minute > date_trunc('minute', calibrated_at))
           − freed_since_calibration                                 -- tổng byte các lệnh dọn đã trả về sau mốc
```

- **Cột mới của `project_usage`:** `calibrated_bytes`, `calibrated_at`, `freed_since_calibration`, `bloat_factor` (numeric). `used_bytes` vẫn là cột lưu sẵn để đọc nhanh.
- `bloat_factor` = (tổng dung lượng theo định nghĩa §2) / (tổng `octet_length(body_raw)`) đo ở lần hiệu chỉnh, kẹp trong `[1, 4]`, mặc định 2 khi chưa đủ dữ liệu. Lý do: ingest chỉ biết `body_raw`; còn `events.payload`, `deliveries`, `delivery_attempts` sinh ra sau ở worker. Không nhân hệ số thì số cộng dồn luôn thấp hơn thật và khoá trễ.
- **Phút chứa mốc hiệu chỉnh** coi như thuộc về lần quét (không cộng lại). Sai số ≤ 1 phút traffic, chấp nhận.
- Số liệu **vẫn là ước tính**. Console, email và webhook giữ chữ "ước tính", kèm "hiệu chỉnh lần cuối lúc …".

**Ba job trong `hub-worker` (ADR-020, không tiến trình mới), mỗi job có khoá Redis như cleanup:**

| Job | Nhịp | Làm gì |
|---|---|---|
| **Cập nhật nấc** | `STORAGE_LEVEL_INTERVAL_MS`, mặc định **60s** (cùng nhịp flush) | **Một truy vấn gộp** xuyên project: `SUM(bytes)` theo `tenant_id` của `source_traffic_minutely` sau mốc của từng project (join `project_usage`). Chỉ project có số đổi mới bị ghi lại `used_bytes` + `level`, rồi chạy luồng cảnh báo khi đổi nấc. Đọc xuyên project qua **escape hatch có tên** (`systemTx('storage: level tick', …)`, tiền lệ `cleanup.job.ts`), có test riêng. Chốt toàn cục §6 (`pg_database_size`) chạy trong job này, tối đa 10 phút một lần (đếm trong bộ nhớ). |
| **Hiệu chỉnh** | `STORAGE_RECALIBRATE_INTERVAL_MS`, mặc định **24h** | Quét thật như §7 cũ (từng project một, mỗi project một truy vấn gộp theo source, không giữ transaction dài). Đặt lại mốc: `calibrated_bytes`, `calibrated_at = now()`, `freed_since_calibration = 0`, `bloat_factor`. Tính `by_source`, `by_bucket`, chạy `RuleAdvisor` (§5.6). Project nào có `calibrated_at` cũ hơn `TRAFFIC_RETENTION_DAYS − 1` ngày thì hiệu chỉnh bắt buộc ở lượt kế, vì bảng traffic sắp bị dọn mất phần sau mốc. |
| **Dọn** (tay, tự động, retention 7 ngày) | theo lệnh / cleanup | Mỗi lô `DELETE`/`UPDATE … RETURNING` tính luôn số byte giải phóng theo **cùng công thức** §2 trên các dòng bị đụng, cộng vào `freed_since_calibration` của tenant trong cùng transaction, rồi **tính lại nấc ngay** (mở khoá không phải chờ 60s). Phần CASCADE (`deliveries`, `delivery_attempts`) không lấy được qua `RETURNING` thì ước bằng `bloat_factor`; lần hiệu chỉnh kế sửa sai. |

- **Dự báo "còn ~X giờ"** = (quota − used) / (`bloat_factor` × Σ bytes 24h gần nhất của bảng traffic / 24). Không cần thêm bảng lịch sử.
- `by_bucket`, gợi ý dọn và số MB của từng gợi ý có thể **cũ tới 24h**. Console ghi "tính lúc …". API `apply` vẫn tính lại gợi ý tại thời điểm gọi như §5.6.
- Độ trễ của nấc: ≤ 60s flush + ≤ 60s job ≈ **2 phút** (trước đây ≤ 10 phút). Flush lỗi thì EG4 giữ đệm tối đa 10 phút, nên số chỉ đến trễ, không mất (trừ khi vượt trần đệm, khi đó `hub_traffic_flush_dropped_total` tăng và lần hiệu chỉnh kế sửa).
- **C++ / StatsKernel:** ngoài phạm vi (Admin tạm gác).

### E3. Owner thấy cảnh báo dung lượng của project mình (thay §8, §9 phần cảnh báo)

- **Trường `audience` trên định nghĩa luật** (`rules.ts`): `'operator' | 'owners+operator'`, mặc định `'operator'`. Chỉ `project.storage_warn`, `project.storage_critical`, `project.storage_locked` (bao cả `HARD_LOCKED`) là `owners+operator`. **Các luật CB cũ giữ operator-only.** Không thêm cột vào `hub.alerts`; lọc theo `rule IN ownerVisibleRules()` lấy từ `rules.ts`.
- **API alerts lọc theo quyền:**
  - Operator: như cũ, thấy mọi luật của mọi project.
  - Owner (không phải operator): `GET /alerts`, `/alerts/summary` trả **chỉ** alert có luật audience owners của **các project mình là owner**. Đọc qua escape hatch có tên mới (vd. `ownerAlertsAcrossTenants(userId)`, join membership `role = owner`), có test riêng. Trước đây trả 403, giờ trả danh sách đã lọc.
  - Developer/viewer: 403 như cũ.
  - Hành động trên alert (ack, mute) và `/me/alert-preferences` giữ operator-only. Owner chỉ tắt được email 70% và 85% (§8), công tắc đặt ở trang Dung lượng.
- **Realtime:** evaluator đưa `audience` vào payload `hub:realtime:alerts`. Gateway luôn emit `alert.changed` vào room `project:<id>:ops` như cũ; luật audience owners thì **emit thêm** vào room `project:<id>:owners`. Room này chỉ owner được join; gateway kiểm vai trò lúc join và R-3 quét lại như room ops (mất vai trò owner thì rời room, không ngắt socket).
- **Web:** chuông, banner, toast và trang "Cảnh báo" hiện cho owner, chỉ chứa cảnh báo dung lượng của project mình. Mục "Cảnh báo" ở `/dashboard/settings` vẫn chỉ operator thấy.
- **Đồng hồ:** toast/badge dựa trên mốc `asOf` do server trả (fix song song trên master, ADR-188). QT **không** tự viết logic đồng hồ phía client. Nếu fix chưa merge khi làm QT6 thì rebase lên nó trước.
- Email đi qua outbox `hub.alert_emails` như §8 (evaluator tạo dòng cho từng owner trong cùng transaction đổi nấc, trần 6/giờ/người tính chung).

### E4. Thứ tự ingest theo code thật (thay §4 "Thứ tự")

Theo `apps/hub-api/src/main.ts` và `docs/ARCHITECTURE.md` §3.1 hiện tại (sau commit `cac3c8e`):

```
[nginx EG1 nếu EDGE_NGINX=1]
→ helmet, cookie, requestId/khuôn lỗi, CORS
→ guard /hooks (installHooksPathGuard: sai hoa thường → 404 như nginx)
→ gate hộp phạt (installPenaltyGate: 0 DB, 0 Redis, CHƯA đọc body → 429 + Connection: close)
→ body parser (/hooks 1MB, rawBody)
→ ingest: adapter theo provider → hộp phạt kiểm lại (IP)
→ 2.  nạp source: findSourceBySourceKeyForIngest + JOIN project_usage lấy level (cùng một câu, +0 lượt DB)
      không có / tắt / đã lưu trữ → 404
→ 2q. [KHOÁ QT] isWriteBlocked(level, keepLonger, STORAGE_LOCK_ENABLED) → 507 project_storage_full → DỪNG
→ 2a. hộp phạt theo cặp (IP, sourceKey)
→ 3.  verify chữ ký
→ 3c. rate limit theo source (EG3, 1 EVAL)
→ 4–8 như ARCHITECTURE §3.1 (GET idem, BEGIN … COMMIT, SET NX sau COMMIT, ACK)
```

- Brief ban đầu ghi gate đứng trước guard; code thật đặt **guard trước gate** (commit `cac3c8e`). Spec theo code.
- **Publish `/v1/p`:** `ApiKeyGuard` → `findSourceById` (join `project_usage.level` vào chính câu này) → **[KHOÁ QT]** → rate limit → `persistAccepted`.
- **Đánh đổi đã chấp nhận:**
  - Project bị khoá vẫn bị Node đọc body (tới 1MB) trước khi trả 507, vì gate không chạm DB nên không biết trạng thái khoá. Không đưa trạng thái khoá vào gate.
  - 507 trả **trước** verify, nên ai biết `sourceKey` cũng biết project đang đầy. Chấp nhận: `sourceKey` vốn là bí mật chia với provider. Đổi lại: request vào project khoá không tốn HMAC, không tốn `EVAL`.
- Lỗi khi đọc `level` (join trả null, dữ liệu hỏng) → fail-open, coi như `OK`, ghi log (giữ §4).
- QT3 phải sửa dòng `[SPEC QT, chưa code …]` trong `ARCHITECTURE.md` §3.1 thành bước 2q thật, **trong cùng PR**.

### E5. Cờ an toàn khi tự deploy (coordinator yêu cầu)

Deploy tự động lên production có thể chạy ban đêm. Không được để nó **tự khoá project thật** hay **tự xoá dữ liệu thật** khi Admin chưa kiểm số đo cộng dồn (E2) trên dữ liệu thật.

| Biến | Mặc định trong code / production | hubv + local compose | Khi = 0 |
|---|---|---|---|
| `STORAGE_LOCK_ENABLED` | **0** | 1 | Vẫn đo, vẫn đổi nấc, vẫn email/webhook/banner. **Không trả 507.** Tăng metric `hub_ingest_storage_would_reject_total` để biết nếu bật thì đã chặn bao nhiêu |
| `STORAGE_AUTO_CLEAN_ENABLED` | **0** | 1 | Policy mặc định vẫn **seed** theo Q10 và hiện trên console, nhưng job dọn tự động **không chạy**. Dọn tay vẫn chạy |

- Console và email phải nói thật khi cờ tắt. Ở `LOCKED` với `STORAGE_LOCK_ENABLED=0`: "Đã vượt hạn mức. Khoá chưa bật trên hệ thống này, event vẫn được nhận." Khối "Dọn tự động": "Đã cài, chưa chạy (người vận hành chưa bật)".
- Đọc cờ một lần lúc khởi động. Đổi cờ = đổi env + restart. Tắt lại là rollback tức thì.
- **Checklist bật** (QT8 ghi vào `docs/DEPLOYMENT.md`):
  1. Deploy với cả hai cờ = 0.
  2. Chờ ≥ 24h để có ít nhất một lượt hiệu chỉnh. So `used_bytes` cộng dồn ngay trước hiệu chỉnh với số quét thật. Chênh > 20% thì chưa bật, xem lại `bloat_factor`.
  3. Xem danh sách project ≥ 95%. Owner đã nhận email chưa?
  4. Bật `STORAGE_LOCK_ENABLED=1`. Theo dõi `hub_ingest_storage_rejected_total`.
  5. Xem policy dọn tự động của từng project thật, rồi bật `STORAGE_AUTO_CLEAN_ENABLED=1`.
  6. Ghi ngày bật từng cờ vào `DEPLOYMENT.md`.

### E6. ADR

- Đã grep `docs/adr/README.md` (2026-10-12): cao nhất là ADR-181. QT dùng **ADR-182..187** như §11 và **ADR-189**. **ADR-188 dành cho fix toast theo đồng hồ server**, không dùng.
- **ADR-183 đổi nội dung:** đo bằng cách cộng dồn `bytes` qua bộ gộp EG4 (+0 DB, +0 Redis trên đường nóng), hiệu chỉnh bằng quét thật mỗi 24h, lệnh dọn trừ số byte giải phóng. Đánh đổi: số liệu ước tính; trôi tới 24h giữa hai lần hiệu chỉnh và phụ thuộc `bloat_factor`.
- **ADR-189 (mới):** (a) "Giữ lâu" nhận tới 110% (`HARD_LOCKED`); (b) cờ `STORAGE_LOCK_ENABLED` và `STORAGE_AUTO_CLEAN_ENABLED` mặc định 0 ở production; (c) owner thấy cảnh báo dung lượng qua `audience`. Đánh đổi: (a) thêm một nấc và hub dôi 10% ổ cho source user tự gắn cờ; (b) production chưa thật sự khoá cho tới khi Admin bật tay; (c) luật cảnh báo có hai loại người nhận.

### Test bổ sung (nối tiếp §12)

| Mã | Kiểm |
|---|---|
| QT:T28 | `levelFor`: ≥110% → `HARD_LOCKED`; `HARD_LOCKED` hạ về `LOCKED` khi < 100%; `LOCKED` hạ khi < 90%. `isWriteBlocked`: đủ bảng (nấc × `keepLonger` × `lockEnabled`) |
| QT:T29 | `LOCKED`: source "Giữ lâu" nhận 200, source thường 507. `HARD_LOCKED`: cả hai 507. Áp dụng như nhau cho `/hooks` và publish. Không tốn lệnh Redis khi 507 |
| QT:T30 | `STORAGE_LOCK_ENABLED=0`: `LOCKED`/`HARD_LOCKED` vẫn 200, nấc + email + webhook vẫn chạy, `hub_ingest_storage_would_reject_total` tăng. `STORAGE_AUTO_CLEAN_ENABLED=0`: policy đã seed nhưng job không dọn; bật lên thì dọn |
| QT:T31 | Cộng dồn: `ACCEPTED` cộng `rawBody.length`, `DUPLICATE`/`RATE_LIMITED`/507 cộng 0, publish cũng cộng; flush cộng `bytes` đúng khi hai instance cùng ghi. `redis-budget.spec.ts` và số truy vấn đường ingest **không đổi** (T6, T7) |
| QT:T32 | `used_bytes` = mốc + `bloat_factor` × Σ bytes sau mốc − đã giải phóng. Hiệu chỉnh đặt lại mốc và `freed_since_calibration = 0`. Mốc quá cũ so với retention traffic thì bị hiệu chỉnh bắt buộc |
| QT:T33 | Lệnh dọn (tay, tự động, retention) trả số byte giải phóng, cộng vào `freed_since_calibration` cùng transaction, nấc hạ **ngay** (mở khoá khi < 90%) không chờ job 60s |
| QT:T34 | Audience: owner thấy alert `project.storage_*` của project mình qua API + room `project:<id>:owners`, **không** thấy luật CB khác và không thấy project khác. Developer/viewer 403. Operator thấy mọi thứ như cũ. Mất vai trò owner thì rời room (R-3) |

## 0. Admin đã quyết

| # | Quyết định |
|---|---|
| Q1 | **Khu = project.** Hub là cả hệ thống. `tenant_id` = id project. Không thêm tầng "workspace". |
| Q2 | **Phòng thủ:** cảnh báo nhiều lần **trước khi** đầy. Không dọn, không được tăng hạn mức thì project bị khoá. |
| Q3 | Con số do phòng chọn: **50MB/project**, đặt qua env, kèm chốt chặn toàn cục (§6). |
| Q4 | **Cảnh báo:** đồng ý toàn bộ đề xuất. Ba kênh: email + console + webhook tự bắn. Nấc 70/85/95/100. Nhắc mỗi ngày ở 95% và 100% (§3). |
| Q5 | **Dọn dẹp có cả hai kiểu: dọn và xoá hẳn.** User chọn. "Không chọn thì sập, thế thôi." |
| Q6 | User được dọn: nội dung event, lịch sử gửi, mẫu request bị từ chối. **`audit_logs` không bao giờ cho xoá.** |
| Q7 | Dọn **theo tuổi + mức độ quan trọng**. Mức độ quan trọng do **hub tự gợi ý** (§5.3). |
| Q8 | **Có dọn tự động.** User tự cài đặt dọn tự động những gì (§5.4). |
| Q10 | **Mặc định dọn tự động:** bật cho **Rác** (xoá hẳn) + **Dọn mức Thấp sau 3 ngày**. Thuật ngữ: dùng chữ **"Dọn"** thay cho "Tỉa" ở mọi chỗ (§5.1). |
| Q11 | **Trần số source mỗi project = 20** (§10). |
| Q9 | **Có webhook gợi ý dọn** (`hub.project.cleanup_suggested`, §5.6). Trước mắt gợi ý **theo luật**; sau này Admin tích hợp **LLM** làm bộ gợi ý. |

## 1. Vấn đề

- **Tràn dữ liệu** (A đọc được dữ liệu của B) đã chặn ba lớp: `TenantScopedRepository`, RLS `FORCE` với role `hub_app NOBYPASSRLS` (migration `20261011110000_rls_hub_app`), và test `libs/database/test/rls-db.spec.ts`. **Spec này không đụng phần đó.**
- **Tràn tài nguyên** (noisy neighbor) thì chưa chặn:
  - Neon free có 0,5GB ổ, dùng chung cho mọi project.
  - Mỗi source được 100 req/phút, body `/hooks` tối đa 1MB (ADR-162), retention 7 ngày. Một source có thể giữ ~1 triệu event.
  - Không có trần số source cho mỗi project.
  - Ổ đầy thì INSERT của **mọi** project lỗi.
- Hiện **không có** chức năng xoá dữ liệu theo project (grep `purge`, `deleteMany` trong `apps/hub-api/src` không ra gì). Cũng **không có** gói trả phí.

## 2. Định nghĩa

- **Dung lượng project (ước tính)** = tổng byte của các cột lớn thuộc tenant:
  - `raw_events.body_raw` qua `octet_length`
  - `events.payload` qua `pg_column_size`
  - `deliveries` và `delivery_attempts` (các cột body/lỗi) qua `pg_column_size`
  - `audit_logs` qua `pg_column_size`
  
  Không tính index, không tính TOAST overhead. Console **luôn ghi "ước tính"**.
- **Hạn mức** = `projects.storage_quota_mb` nếu khác null (operator ghi đè). Nếu null thì dùng `PROJECT_STORAGE_QUOTA_MB` (mặc định **50**).
- **Mức sử dụng** = dung lượng / hạn mức.

## 3. Các nấc và kênh cảnh báo (Admin đã chốt, Q4)

| Nấc | Ngưỡng | Hành động |
|---|---|---|
| `OK` | < 70% | — |
| `WARN_70` | ≥ 70% | Email lần 1 + banner vàng + webhook |
| `WARN_85` | ≥ 85% | Email lần 2 + toast mỗi lần mở console + webhook |
| `CRITICAL_95` | ≥ 95% | Email **mỗi ngày một lần** + banner đỏ không tắt được + webhook. Câu hiển thị: "Còn ~X giờ trước khi khoá", ước theo tốc độ tăng 24h gần nhất |
| `LOCKED` | ≥ 100% | Khoá nhận (§4) + email "đã khoá" + webhook + email mỗi ngày tới khi mở |

- **Nội dung mọi cảnh báo** phải có: mức sử dụng (ước tính), dự báo "còn bao lâu thì đầy", **gợi ý dọn của hub** (§5.3, kèm số MB sẽ giải phóng), và link tới trang Dung lượng. Ở `WARN_70` có thêm link "Bật dọn tự động".
- **Người nhận:** mọi `owner` của project + operator. Phòng hiểu "rất ổn" là đồng ý đề xuất ở §8. Nếu Admin muốn developer/viewer cũng nhận email thì sửa một dòng ở đây.
- **Webhook tự bắn:** hub phát event `hub.project.storage` với `data: { level, usedBytes, quotaBytes, forecastHours, suggestion }`.
  - Đi qua **đường outbox bình thường**, tới các destination đã đăng ký kiểu này. Không có đường gửi riêng, không có `if` trong lõi.
  - Thêm kiểu `hub.project.storage` vào `docs/EVENT-CATALOG.md` + test U50.
  - Mỗi lần đổi nấc phát đúng một event. Khi `LOCKED`, event này **vẫn được ghi** (là event của hub, không phải ingest), nên khoá chiều ghi ở §4 không chặn nó.
- **Vùng đệm:** `LOCKED` chỉ mở khi mức sử dụng **< 90%**. Các nấc cảnh báo hạ khi thấp hơn ngưỡng 5 điểm phần trăm. Không có vùng đệm thì cleanup và traffic sẽ làm trạng thái bật tắt liên tục.
- **Chống spam email:** mỗi nấc gửi một lần mỗi lần *đi lên*. Riêng `CRITICAL_95` và `LOCKED` nhắc mỗi ngày. Nấc đã gửi ghi vào `project_usage.notified_level`, `notified_at`. Gmail driver (ADR-124) có trần gửi mỗi ngày, nên không gửi theo từng event.

## 4. "Khoá" nghĩa là gì: chỉ khoá chiều ghi mới

| Đường | Khi `LOCKED` |
|---|---|
| `POST /hooks/:provider/:sourceKey` | **507** `project_storage_full`, khuôn `{error, message, fix, docsUrl, requestId}`. Không 2xx, nên BB-3 giữ và provider sẽ tự gửi lại |
| `POST /v1/p/:project/publish` (+ `hub trigger`) | 507 như trên |
| Giao event **đã lưu** (worker, retry) | **Vẫn chạy.** Event đã COMMIT là lời hứa |
| Polling, `hub listen`, console đọc | Vẫn chạy |
| Dọn dẹp (§5) | Vẫn chạy. Đây là lối thoát |
| Tạo source / destination mới | Vẫn cho phép. Không lưu event thì không tốn ổ |

- **Không thêm lượt DB, không thêm lệnh Redis trên đường nóng.**
  - Trạng thái khoá đọc bằng cách mở rộng chính câu `findSourceBySourceKeyForIngest` (`ingest.service.ts:264`): join `hub.project_usage` lấy `level`.
  - Publish thì gắn vào câu tra API key đang có.
  - `redis-budget.spec.ts` phải xanh nguyên trạng.
- **Thứ tự:** kiểm khoá **sau** khi nạp source, **trước** rate limit và verify. Project đã khoá thì không tốn lượt `EVAL`.
  - Nếu EG3 được duyệt thì thứ tự mới phải ghi vào DS1 (docs-sync) cùng lúc.
- Lỗi khi đọc trạng thái thì **fail-open** (coi như `OK`) và log. Hạn mức là chống lạm dụng, không phải bất biến đúng–sai.

## 5. Dọn dẹp (Admin đã chốt Q5–Q10)

### 5.1 Hai kiểu dọn, user chọn

> **Thuật ngữ (Q10):** trên UI, email và tài liệu chỉ có hai chữ: **"Dọn"** (bỏ nội dung nặng, giữ dòng gầy) và **"Xoá hẳn"**. Trong code, hành động "Dọn" mang tên `trim` (enum `action: 'trim' | 'delete'`). Đừng dùng chữ "Tỉa" ở bất cứ đâu người dùng đọc được.

| Kiểu | Làm gì | Giải phóng | Giữ lại | Mất |
|---|---|---|---|---|
| **Dọn** | `raw_events.body_raw` → rỗng, `events.payload` → null, cắt các cột body/lỗi dài của `delivery_attempts`. Đặt `trimmed_at` | ~90% | Dòng `events` gầy gồm khoá chống trùng, kiểu, source, thời gian, trạng thái giao. **BB-2 vẫn nguyên**: provider gửi lại thì Postgres vẫn chặn trùng (P2002) | Nội dung. Không replay được, không xem body được |
| **Xoá hẳn** | Xoá dòng `events` + `raw_events` + `deliveries` + `delivery_attempts` | 100% | — | **Mất cả chống trùng**: provider gửi lại khoá cũ thì hub nhận lần nữa |

- **Console và API phải nói thật về event đã dọn:**
  - Hiện "Nội dung đã được dọn ngày X". **Không** hiện nút Replay.
  - Polling (`/v1/p/*`) trả event đã dọn với `trimmed: true`, `data: null`. Thêm trường này vào `docs/EVENT-CATALOG.md`.
- **Migration:** thêm cột `events.trimmed_at`, `raw_events.trimmed_at` (nullable).

### 5.2 User được dọn gì (Q6)

| Nhóm dữ liệu | Dọn | Xoá hẳn |
|---|---|---|
| Nội dung event (`events` + `raw_events` ACCEPTED) | ✅ | ✅ |
| Lịch sử gửi (`deliveries` + `delivery_attempts`) | ✅ (cắt body phản hồi) | ✅ (đi kèm event) |
| Mẫu request bị từ chối (`raw_events` REJECTED, ≤4KB, ADR-045) | — | ✅ |
| `audit_logs` | ❌ | ❌ **không bao giờ** |

**Không bao giờ dọn** (kể cả dọn tự động): event còn delivery `PENDING`/`RETRYING`, và event mới hơn `now - TOTAL_RETRY_WINDOW_MS` (dùng lại hằng số của `assertRetentionSafe`). Tách hàm điều kiện dùng chung với `cleanup.job.ts`, không chép lại.

### 5.3 Mức độ quan trọng do hub gợi ý (Admin cho code trước, Q9)

Hàm thuần `importanceOf(event, deliveries, sourceSettings)` trong `libs/common/src/storage/importance.ts`.
- Chỉ dùng **tín hiệu chung của hub**: trạng thái giao, tuổi, loại bản ghi, cờ user đặt.
- **Không** đọc nội dung payload và không xét provider (BB-1, không `if (provider === …)`).

| Mức | Gồm | Hub gợi ý |
|---|---|---|
| **Rác** | Mẫu request REJECTED | Xoá hẳn, mọi tuổi |
| **Thấp** | Event mà **mọi** delivery đều `DELIVERED` | Dọn sau 3 ngày |
| **Trung bình** | Event không có delivery push nào (có thể đang có client polling: hub không biết cursor của họ) | Dọn sau 5 ngày |
| **Cao** | Event có delivery `DEAD`/`FAILED` chưa ai xử lý, hoặc vừa replay trong 24h | Không gợi ý dọn. User vẫn tự dọn được, nhưng phải qua hộp xác nhận riêng |
| **Giữ** | Source user gắn cờ "giữ lâu" (`sources.keep_longer`) | Không gợi ý, không dọn tự động |

- **Gợi ý = danh sách các dòng** "Dọn N event mức Thấp, cũ hơn 3 ngày → ~X MB". Số MB tính sẵn từ `project_usage.by_bucket` (§7), nên user bấm là biết giải phóng bao nhiêu.
- **Mary (BB-1):** "Thấp" là vì *đã giao xong*, không phải vì hub đoán nghiệp vụ. Hub không biết event nào là thanh toán quan trọng; user tự gắn cờ "Giữ" cho source đó.

### 5.4 Dọn tự động (Q8, Q10)

- **Bảng `hub.storage_policies`:** `tenant_id`, `importance` (rác/thấp/trung bình), `action` (`trim`|`delete`|`off`), `after_days` (≥ sàn retry window), `trigger` (`always` = mỗi lượt cleanup | `above_85` = chỉ khi ≥ 85%), `updated_by`, `updated_at`. Có RLS.
- **Mức "Cao" và "Giữ" không có trong bảng**, nên không thể đặt dọn tự động cho chúng.
- Chạy trong cleanup job của worker, cùng khoá Redis, theo lô. Mỗi lượt dọn tự động ghi `audit_logs` với `actor = system:auto-clean`, kèm số dòng và số MB, rồi đo lại (§7).
- **Mặc định khi tạo project (Admin chốt, Q10):**
  - **Rác:** `delete` sau 1 ngày, `always`. Đây là mẫu tấn công, không phải dữ liệu của user.
  - **Thấp:** `trim` ("Dọn") sau **3 ngày**, `always`. Event đã giao thành công tới mọi đích; dọn thì chống trùng vẫn còn (BB-2).
  - **Trung bình:** `off`.
  - Project đã tồn tại trước migration cũng nhận mặc định này. Migration seed `storage_policies` cho mọi project hiện có, ghi một dòng `audit_logs` `actor = system:migration`.
  - Console hiện rõ **"Đang bật dọn tự động"** ở trang Dung lượng và trong email `WARN_70` (có link tắt). Không có chuyện dọn ngầm mà user không biết.
- Đổi cài đặt: scope `storage:write` (owner + operator), ghi `audit_logs`.

### 5.5 API

- `GET /api/v1/projects/:p/storage`: `{ usedBytes, quotaBytes, level, measuredAt, bySource, byImportance, growthPerDay, suggestions[] }`, scope `storage:read` (owner, developer, operator).
- `POST /api/v1/projects/:p/storage/clean`: `{ action: 'trim'|'delete', importance[], olderThan, sourceId? }`, scope `storage:write`.
  - Tạo **lệnh dọn**, trả `202` + id lệnh. Worker chạy theo lô (ví dụ 1000 dòng/lô). Không giữ connection Neon `connection_limit=1` cho một DELETE lớn.
  - `olderThan` mới hơn sàn thì 400. `importance` chứa `high` thì phải có `confirmHigh: true`.
  - Ghi `audit_logs`. Xong thì **đo lại ngay** để mở khoá không phải chờ chu kỳ.
- `GET` và `PUT /api/v1/projects/:p/storage/policies`: §5.4.
- `PATCH /api/v1/projects/:p/sources/:id` thêm `keepLonger: boolean`.

### 5.6 Gợi ý dọn: hợp đồng, webhook, chỗ cắm LLM (Q9)

**Bộ gợi ý là một interface. Hôm nay có một bản theo luật, mai thêm bản LLM, lõi không đổi.** Cùng tư duy với `ProviderAdapter`.

```ts
// libs/common/src/storage/cleanup-advisor.ts
interface CleanupAdvisor {
  readonly id: string;                        // 'rules@1', sau này 'llm@1'
  suggest(input: StorageSnapshot): Promise<CleanupSuggestion[]>;
}
interface StorageSnapshot {                   // CHỈ số liệu gộp, KHÔNG payload, KHÔNG body (BB-1 + riêng tư)
  usedBytes: number; quotaBytes: number; level: Level; growthPerDay: number;
  buckets: { sourceId: string; importance: Importance; ageDays: number; events: number; bytes: number }[];
  policies: StoragePolicy[]; keepLongerSourceIds: string[];
}
interface CleanupSuggestion {
  id: string;                 // hash xác định từ (advisor, importance, action, olderThan, sourceId) — không ngẫu nhiên
  action: 'trim' | 'delete';
  importance: Importance[]; olderThan: string; sourceId?: string;
  estimatedBytes: number; estimatedEvents: number;
  reasonCode: string;         // 'delivered_old', 'rejected_samples', …
  reason: string;             // câu cho người đọc, có số MB và đánh đổi
  advisor: string;            // ai gợi ý
  expiresAt: string;          // +24h
}
```

- **Hôm nay chỉ có `RuleAdvisor` (`rules@1`):** hàm thuần trên bảng §5.3. Chạy trong job đo (§7), lưu bộ gợi ý mới nhất vào `project_usage.suggestions` (jsonb).
- **Hàng rào an toàn nằm NGOÀI advisor** (`assertSuggestionSafe`). Mọi gợi ý, kể cả của LLM sau này, phải qua lớp này trước khi lưu, phát hay áp dụng:
  - Không chứa mức Cao hay Giữ.
  - `olderThan` không mới hơn sàn retry window.
  - Không đụng `audit_logs`.
  - `estimatedBytes` được tính lại từ `by_bucket`, không tin số advisor đưa ra.
  
  Gợi ý vi phạm thì bị loại, log và tăng `hub_cleanup_suggestions_rejected_total{advisor}`.
- **Advisor chỉ gợi ý, không bao giờ tự thực thi.** Thực thi chỉ có ba đường: user bấm, dọn tự động theo policy user đặt (§5.4), hoặc API `apply` dưới đây.
- Advisor ném lỗi hoặc quá thời gian (sau này là LLM chậm hay sập) thì fail-open về `RuleAdvisor`. Gợi ý lỗi không được làm hỏng lượt đo.

**Webhook `hub.project.cleanup_suggested`:**
- `data: { level, usedBytes, quotaBytes, forecastHours, suggestions: CleanupSuggestion[] }`. Đi qua outbox bình thường, tới destination đã đăng ký kiểu này. Thêm vào `docs/EVENT-CATALOG.md` + test U50.
- **Khi nào phát:**
  - Khi nấc đi lên (cùng lúc với `hub.project.storage`).
  - Khi bộ gợi ý đổi đáng kể (tổng `estimatedBytes` chênh ≥ 10% quota so với lần phát trước).
  - Không phát quá 1 lần/ngày/project, trừ khi nấc đi lên.
  - Mức `OK` và không có gợi ý nào thì không phát.
- Vẫn phát khi `LOCKED`. Đây là event của hub, giống §3.

**Áp dụng gợi ý từ hệ thống của user** (để họ tự động hoá: nhận webhook, quyết định, gọi lại):
- `POST /api/v1/projects/:p/storage/suggestions/:id/apply`, scope `storage:write`. API key có scope này cũng gọi được.
- Hub **tính lại** gợi ý tại thời điểm gọi và kiểm lại hàng rào. Gợi ý hết hạn hoặc không còn trong bộ hiện tại thì 409 `suggestion_stale`, kèm bộ mới.
- Áp dụng thì tạo lệnh dọn giống §5.5 (202 + id lệnh), ghi `audit_logs` với `suggestion.advisor`.
- Idempotent theo `id` gợi ý: gọi hai lần thì trả cùng lệnh dọn.

**Khi tích hợp LLM (sau, ngoài phạm vi đợt này):** thêm class `LlmAdvisor` + chọn bằng env `CLEANUP_ADVISOR=rules|llm`. LLM chỉ nhận `StorageSnapshot` (số gộp), không bao giờ nhận payload. Không sửa job đo, webhook, `apply` hay hàng rào.

## 6. Chốt chặn toàn cục (cho operator)

- Job đo (§7) đọc thêm `pg_database_size(current_database())`.
- Vượt `DB_DISK_BUDGET_MB × 80%` (mặc định `DB_DISK_BUDGET_MB=512`) thì mở cảnh báo operator `hub.storage_near_full`. Đi theo luồng CB, critical, operator-only.
- Lý do: tổng hạn mức được **cấp vượt** (10 project × 50MB = cả ổ), nên chốt toàn cục là lưới an toàn thật sự.

## 7. Đo: job trong `hub-worker` (ADR-020, không tiến trình mới)

- **Bảng `hub.project_usage`:** `tenant_id` (PK), `used_bytes` bigint, `by_source` jsonb, `by_bucket` jsonb (byte theo mức quan trọng × tuổi, để tính sẵn số MB cho gợi ý §5.3), `suggestions` jsonb (bộ gợi ý mới nhất §5.6), `suggested_at`, `suggested_bytes` (để tính "đổi đáng kể"), `level` varchar, `notified_level` varchar, `notified_at` timestamptz, `measured_at` timestamptz. Có `tenant_id`, RLS như các bảng khác.
- **Chu kỳ:** `STORAGE_MEASURE_INTERVAL_MS` mặc định 10 phút.
  - Khoá Redis như cleanup để nhiều worker không chạy trùng.
  - Đo **từng project một**, mỗi project một truy vấn gộp theo `source_id`, không giữ transaction dài.
- Ghi `level` theo §3 (kể cả vùng đệm), rồi gửi email nếu nấc đi lên.
- Cleanup 7 ngày xong lượt nào thì đo lại lượt đó.
- **Metric:** `hub_project_storage_bytes{tenant}` (gauge), `hub_project_storage_locked` (gauge, số project đang khoá), `hub_ingest_storage_rejected_total`.

## 8. Cảnh báo và email: yêu cầu thay đổi spec CB

- Spec CB (`alerts/SPEC-canh-bao-nhan-dinh.md`, Q1) chỉ gửi cho operator. **Cảnh báo dung lượng gửi cho mọi `owner` của project + operator.**
- Đề xuất:
  - Thêm họ luật `project.storage_warn` (warning) và `project.storage_critical` / `project.storage_locked` (critical) vào `rules.ts`.
  - Thêm trường "người nhận" cho từng luật: `operator` (mặc định) hoặc `owners+operator`.
  - Email owner bỏ qua `alert_preferences` của operator. Owner không tắt được email `LOCKED`, chỉ tắt được 70% và 85%.
- **CB đã lên master (2026-10-12).** Email cảnh báo đi qua outbox theo người `hub.alert_emails` (`alerts/DINH-CHINH-2026-10-12.md` D1), có trần 6/giờ/người.
  - QT **dùng lại outbox này**, không tạo đường gửi riêng. Thêm người nhận `owners+operator` cho các luật `project.storage_*`: evaluator tạo dòng `alert_emails` cho từng owner trong cùng transaction đổi nấc.
  - Đọc lại `alerts/DINH-CHINH-2026-10-12.md` trước khi code. File đó thắng SPEC CB khi mâu thuẫn.

## 9. Console (`apps/web`)

- **Trang project → Cài đặt → "Dung lượng":**
  - Thanh mức sử dụng (ghi "ước tính"), dự báo "còn bao lâu thì đầy".
  - Biểu đồ theo **mức quan trọng** và theo source.
  - **Khối "Hub gợi ý":** các dòng ở §5.3, mỗi dòng có số MB và hai nút "Dọn" / "Xoá hẳn".
  - Hộp xác nhận nói rõ đánh đổi ở §5.1. Xoá hẳn thì có câu "mất chống trùng".
  - **Khối "Dọn tự động":** bảng §5.4, mỗi mức chọn hành động + số ngày + điều kiện. Có dòng "Lần chạy gần nhất: … đã giải phóng X MB".
- **Source detail:** công tắc "Giữ lâu".
- **Event detail đã dọn:** "Nội dung đã được dọn ngày X", không có nút Replay.
- **Banner:** theo §3. Ở `LOCKED`: "Project đã ngừng nhận event mới. Provider sẽ gửi lại trong một thời gian rồi bỏ." Kèm hai nút "Dọn theo gợi ý" và "Liên hệ người vận hành".
- **Không có nút "Nâng cấp".** Chưa có gói trả phí, và giao diện phải nói thật.
- **Operator:** ở danh sách project có cột mức sử dụng; ở chi tiết project có ô ghi đè `storage_quota_mb`.

## 10. Trần số source mỗi project (Admin chốt, Q11)

- `SOURCE_LIMIT_PER_PROJECT` mặc định **20**. Đếm source chưa lưu trữ (`archived_at IS NULL`); khoá đếm trong transaction như `lockAndCountOwnedProjects`, để hai request song song không vượt trần. Operator không bị giới hạn. Kiểm khi tạo source, cùng khuôn với `PROJECT_LIMIT_*` ở `projects.controller.ts:41`. Vượt thì 409 `source_limit`.
- Lý do: hạn mức dung lượng chặn **ổ**, nhưng không chặn **tốc độ** N × 100 req/phút đè lên worker và RabbitMQ chung.

## 11. ADR

| ADR | Nội dung 3 dòng |
|---|---|
| ADR-182 | Hạn mức dung lượng theo project: cảnh báo nhiều nấc qua email + console + webhook `hub.project.storage`, rồi khoá chiều ghi (507), vùng đệm 100/90. Đánh đổi: provider gửi lại rồi bỏ, nên mất event nếu owner bỏ mặc. |
| ADR-183 | *(Đã đổi theo E2.)* Đo bằng cộng dồn `bytes` qua bộ gộp EG4 + hiệu chỉnh quét thật mỗi 24h + lệnh dọn trừ số đã giải phóng; trạng thái gắn vào câu nạp source có sẵn. Đánh đổi: số liệu ước tính, trôi tới 24h giữa hai lần hiệu chỉnh. |
| ADR-189 | *(E1, E3, E5.)* "Giữ lâu" nhận tới 110% (`HARD_LOCKED`); `STORAGE_LOCK_ENABLED` / `STORAGE_AUTO_CLEAN_ENABLED` mặc định 0 ở production; owner thấy cảnh báo dung lượng qua `audience`. Đánh đổi: thêm một nấc, production chưa khoá thật tới khi Admin bật, luật có hai loại người nhận. |
| ADR-184 | Dọn hai kiểu: dọn (giữ dòng gầy, BB-2 còn) và xoá hẳn (mất chống trùng). User chọn, chạy lô trong worker, có sàn retry window, `audit_logs` không xoá được. Đánh đổi: dọn không replay được. |
| ADR-185 | Cấp vượt hạn mức + chốt toàn cục 80% cho operator. Đánh đổi: tổng hạn mức có thể vượt ổ thật. |
| ADR-187 | Gợi ý dọn là interface `CleanupAdvisor` (hôm nay `rules@1`, sau `llm`), hàng rào an toàn nằm ngoài advisor, advisor không bao giờ thực thi; webhook `hub.project.cleanup_suggested` + API `apply` tính lại khi gọi. Đánh đổi: thêm một lớp trừu tượng khi mới có một bản cài. |
| ADR-186 | Mức quan trọng là hàm thuần trên tín hiệu chung (trạng thái giao, tuổi, cờ user), không đọc payload. Dọn tự động theo chính sách user đặt, mặc định chỉ rác. Đánh đổi: hub không biết event nào quan trọng về nghiệp vụ; user phải tự gắn "Giữ lâu". |

## 12. Kiểm chứng

| Mã | Kiểm |
|---|---|
| QT:T1 | Hàm thuần `levelFor(used, quota, prevLevel)`: đủ các nấc, vùng đệm 100→90, cảnh báo hạ khi thấp hơn ngưỡng 5 điểm |
| QT:T2 | `LOCKED`: `/hooks` trả 507 đúng khuôn lỗi, **không** ghi `events`/`raw_events`, **không** tốn lệnh Redis |
| QT:T3 | `LOCKED`: `/v1/p/:project/publish` trả 507 |
| QT:T4 | `LOCKED`: delivery đã có vẫn được giao và retry |
| QT:T5 | Project A `LOCKED` thì project B cùng DB vẫn nhận 200 |
| QT:T6 | `redis-budget.spec.ts` xanh, không đổi số lệnh |
| QT:T7 | Số truy vấn DB của đường ingest không tăng (đếm như test p95/ADR-108) |
| QT:T8 | Đọc `project_usage` lỗi thì fail-open và ghi log |
| QT:T9 | Dọn không đụng event còn delivery PENDING/RETRYING; `olderThan` mới hơn sàn thì 400 |
| QT:T10 | Dọn chạy theo lô, ghi `audit_logs`, đo lại xong thì mở khoá nếu < 90% |
| QT:T11 | Email: mỗi nấc đi lên gửi một lần; 95% và LOCKED nhắc theo ngày; gửi owner + operator, không gửi developer/viewer. Driver `capture` |
| QT:T12 | Hai worker đo song song chỉ một lượt chạy (khoá) |
| QT:T13 | RLS: `project_usage`, `storage_policies` của A không đọc được khi đặt `app.project_id` = B |
| QT:T14 | Chốt toàn cục: `pg_database_size` giả lập > 80% thì mở cảnh báo operator |
| QT:T15 | **Dọn giữ BB-2:** dọn event rồi gửi lại cùng khoá chống trùng thì vẫn 200 duplicate, không tạo event mới |
| QT:T16 | **Xoá hẳn mất chống trùng:** xoá rồi gửi lại cùng khoá thì được nhận lần nữa (test ghi nhận đánh đổi, không phải lỗi) |
| QT:T17 | `importanceOf`: bảng §5.3 đủ 5 mức; source `keep_longer` luôn là "Giữ"; hàm không đọc payload (truyền payload null vẫn ra cùng kết quả) |
| QT:T18 | Dọn tự động: chỉ chạy mức có policy, không bao giờ chạm "Cao"/"Giữ"/`audit_logs`; `trigger=above_85` không chạy khi < 85% |
| QT:T19 | Webhook `hub.project.storage`: mỗi lần đổi nấc đúng một event qua outbox; vẫn phát khi `LOCKED`; khớp catalog (U50) |
| QT:T20 | Event đã dọn: polling trả `trimmed: true, data: null`; API replay trả 409 `event_trimmed` |
| QT:T21 | `RuleAdvisor`: snapshot mẫu ra đúng gợi ý theo §5.3; `id` gợi ý ổn định giữa hai lần chạy cùng dữ liệu |
| QT:T22 | Hàng rào: advisor giả trả gợi ý chứa mức Cao / `olderThan` mới hơn sàn / số MB bịa thì bị loại hoặc tính lại, metric tăng |
| QT:T23 | Advisor giả ném lỗi hoặc timeout thì fail-open về `rules@1`, lượt đo vẫn xong |
| QT:T24 | Webhook `hub.project.cleanup_suggested`: phát khi nấc lên hoặc đổi ≥10% quota, không quá 1/ngày, không phát khi `OK` + rỗng, vẫn phát khi `LOCKED`; khớp catalog |
| QT:T26 | Project mới có sẵn policy mặc định: Rác `delete` 1 ngày + Thấp `trim` 3 ngày; migration seed cho project cũ kèm `audit_logs` |
| QT:T27 | Trần source: source thứ 21 trả 409 `source_limit`; hai request tạo song song ở mức 19 chỉ một cái qua; source đã lưu trữ không tính |
| QT:T25 | `apply`: gợi ý hết hạn hoặc lạc hậu thì 409 `suggestion_stale` kèm bộ mới; gọi hai lần cùng id thì trả cùng lệnh dọn; ghi `audit_logs` có advisor |

## 13. Story và thứ tự

| Story | Nội dung | Phụ thuộc |
|---|---|---|
| **QT1** | Migration `project_usage` (kèm cột mốc hiệu chỉnh E2), `storage_policies` + RLS, `projects.storage_quota_mb`, `sources.keep_longer`, `*.trimmed_at`, `source_traffic_minutely.bytes`, outcome `STORAGE_FULL`; `levelFor` (có `HARD_LOCKED`) + `isWriteBlocked` + `importanceOf` thuần + test | — |
| **QT2** | Đo theo E2: `traffic.record` cộng `bytes` (cả publish), job cập nhật nấc 60s, job hiệu chỉnh 24h (theo source + mức quan trọng), metric, chốt toàn cục | QT1, **EG4** (đã trên master) |
| **QT3** | Khoá chiều ghi ở ingest + publish (join câu có sẵn), bước 2q theo E4, "Giữ lâu" tới 110%, cờ `STORAGE_LOCK_ENABLED`; sửa `ARCHITECTURE.md` §3.1 cùng PR | QT1 |
| **QT4** | Dọn tay: API `clean`, dọn + xoá hẳn theo lô, lệnh dọn trả số byte giải phóng (E2), `GET storage` + gợi ý | QT1, QT2 |
| **QT4b** | Gợi ý dọn: `CleanupAdvisor` + `RuleAdvisor` + hàng rào + lưu `suggestions` + API `apply` + webhook `hub.project.cleanup_suggested` (+ catalog) | QT2, QT4 |
| **QT5** | Dọn tự động: `storage_policies` API + chạy trong cleanup job, cờ `STORAGE_AUTO_CLEAN_ENABLED`; retention 7 ngày cũng trừ số byte giải phóng | QT4 |
| **QT6** | Cảnh báo: email theo nấc + webhook `hub.project.storage` (+ catalog); **`audience` owners+operator** cho luật `project.storage_*` (API lọc theo quyền, room `project:<id>:owners`, chuông/banner/toast/trang Cảnh báo cho owner theo `asOf` server) | QT2, CB (master), fix toast ADR-188 |
| **QT7** | Console: trang Dung lượng ("ước tính", "hiệu chỉnh lúc …"), gợi ý, dọn tự động, cờ "Giữ lâu", banner (gồm `HARD_LOCKED` và câu khi cờ tắt), event đã dọn, ô ghi đè của operator | QT4, QT5, QT6 |
| **QT8** | ADR-182..187 + ADR-189, `DEPLOYMENT.md` (`PROJECT_STORAGE_QUOTA_MB`, `DB_DISK_BUDGET_MB`, `STORAGE_LEVEL_INTERVAL_MS`, `STORAGE_RECALIBRATE_INTERVAL_MS`, `STORAGE_LOCK_ENABLED`, `STORAGE_AUTO_CLEAN_ENABLED` + checklist bật E5), `ARCHITECTURE.md` thêm mục "Cô lập tài nguyên", `EVENT-CATALOG.md`, spec-sources | tất cả |
| **QT9** | `SOURCE_LIMIT_PER_PROJECT=20`: kiểm khi tạo source (console + API), 409 `source_limit` đúng khuôn lỗi, console hiện "N/20 source" | — |

- **Không được cắt:** QT1–QT4, QT4b và QT6. Có cảnh báo mà không có lối thoát thì vô nghĩa, có khoá mà không có dọn là bẫy, và có khoá mà không cảnh báo là phản bội Q2.
- **Thứ tự:** QT1 → QT2 → QT3 → QT4 → QT4b → QT6 → QT5 → QT7 → QT8.

## 14. Bất biến phải giữ (reviewer kiểm)

- BB-3: không bao giờ 2xx khi đã khoá. 507 trả **trước** mọi ghi.
- BB-5: `project_usage` có `tenant_id`, đi qua `TenantScopedRepository`. Job đo chạy `systemTx` có tên, như cleanup.
- Không có `if (provider === …)`. Khoá áp cho mọi provider như nhau.
- Đường nóng: +0 lệnh Redis, +0 lượt DB.
- Chỉ khoá **chiều ghi**. Mọi đường đọc và dọn luôn mở.
- `audit_logs` không bao giờ bị dọn, tay hay tự động.
- Dọn không bao giờ xoá dòng `events`. Khoá chống trùng phải còn (BB-2).
- Mức quan trọng không đọc payload, không xét provider.
- Advisor chỉ gợi ý. Mọi gợi ý qua `assertSuggestionSafe` trước khi lưu, phát hay áp dụng. Advisor không bao giờ nhận payload.

## Xong khi

- [ ] QT:T1–T34 xanh.
- [ ] Demo: đặt `PROJECT_STORAGE_QUOTA_MB=1`, `STORAGE_LOCK_ENABLED=1`, `STORAGE_AUTO_CLEAN_ENABLED=1` ở local, bắn k6 vào một source, thấy email + webhook ở 70/85/95, thấy 507, bấm gợi ý "Dọn mức Thấp" rồi mở khoá; bật dọn tự động và thấy lượt sau tự chạy. Project khác không bị ảnh hưởng suốt quá trình.
- [ ] Spec CB có ghi chú yêu cầu thay đổi người nhận (§8), hoặc Admin quyết để sau.
