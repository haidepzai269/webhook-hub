# TEST-MAP — mã spec → test (tự sinh, đừng sửa tay)

> Sinh bởi `npm run verify:map` (VF2, SPEC-verification §3.2). Trạng thái lấy từ lần `verify` cuối (2026-10-10T09:11:24.825Z, commit 3ea2cb5).
> Chỉ liệt kê mã đã có test, hoặc mã của story đã xong (bắt buộc có test). Mã của story chưa làm được phép mồ côi.
> `L2*` = kịch bản tự kiểm của bộ kiểm chứng (`verify/scenarios`), chạy bằng tay qua `npm run verify:selftest`.

Tổng: 198 mã khai báo · 52 mã có test · 0 mồ côi · 9 mồ côi có lý do · 0 ma · 0 trùng.

| mã | spec · story | tầng | file:dòng | trạng thái lần chạy cuối |
|---|---|---|---|---|
| `AF:#1` | REVIEW-CHECKLIST.md · S1-6 | — | — | mồ côi có lý do: Kiểm bằng ls libs/*/dist + đổi tên export rồi khởi động container (docker) — chờ VF4/VF5 nhập vào runner L2 |
| `AF:#2` | REVIEW-CHECKLIST.md · S1-6 | — | — | mồ côi có lý do: Kiểm bằng grep docker-entrypoint.sh + thư mục migrations — không phải test jest |
| `AF:#3` | REVIEW-CHECKLIST.md · S1-7 | L0 | libs/crypto/test/ssrf-axios.spec.ts:27 | ✅ pass |
| `AF:#4` | REVIEW-CHECKLIST.md · S1-7 | L0 | libs/database/test/seed-env.spec.ts:14 | ✅ pass |
| `AF:#5` | REVIEW-CHECKLIST.md · S3-1 | L0 | libs/providers/test/signature-s3-1.spec.ts:42 | ✅ pass |
| `AF:#6` | REVIEW-CHECKLIST.md · S3-1 | L0 | libs/providers/test/signature-s3-1.spec.ts:71 | ✅ pass |
| `AF:#7` | REVIEW-CHECKLIST.md · S3-1 | L0 | libs/providers/test/signature-s3-1.spec.ts:79 | ✅ pass |
| `AF:#8` | REVIEW-CHECKLIST.md · S3-1 | L0 | libs/providers/test/signature-s3-1.spec.ts:138 | ✅ pass |
| `AF:#9` | REVIEW-CHECKLIST.md · S3-2 | L0 | libs/providers/test/canonical-same-shape.spec.ts:9 | ✅ pass |
| `AF:#10` | REVIEW-CHECKLIST.md · S3-2 | L0 | libs/providers/test/canonical-payos.spec.ts:37 | ✅ pass |
| `AF:#11` | REVIEW-CHECKLIST.md · S3-2 | L0 | libs/providers/test/canonical-sepay.spec.ts:18 | ✅ pass |
| `AF:#12` | REVIEW-CHECKLIST.md · S3-3 | L1 | libs/database/test/subscription-match-db.spec.ts:45 | chưa chạy |
| `AF:#13` | REVIEW-CHECKLIST.md · S3-3 | — | — | mồ côi có lý do: Kiểm bằng grep seed.ts — không phải test jest |
| `AF:#14` | REVIEW-CHECKLIST.md · S1-7 | L0 | apps/hub-worker/test/telegram-sender.spec.ts:11 | ✅ pass |
| `AF:#15` | REVIEW-CHECKLIST.md · S1-1 | L0 | apps/hub-worker/test/normalize-consumer.spec.ts:125 | ✅ pass |
| `AF:#16` | REVIEW-CHECKLIST.md · S1-2 | L0 | apps/hub-worker/test/normalize-consumer.spec.ts:112 | ✅ pass |
| `AF:#17` | REVIEW-CHECKLIST.md · S1-2 | L1 | apps/hub-worker/test/delivery-lease-sweeper.spec.ts:123 | chưa chạy |
| `AF:#18` | REVIEW-CHECKLIST.md · S1-3 | L0 | apps/hub-worker/test/normalize-consumer.spec.ts:142 | ✅ pass |
| `AF:#19` | REVIEW-CHECKLIST.md · S1-3 | L1 | apps/hub-worker/test/delivery-lease-sweeper.spec.ts:84 | chưa chạy |
| `AF:#20` | REVIEW-CHECKLIST.md · S1-4 | — | — | mồ côi có lý do: docker compose restart rabbitmq — kịch bản chaos, chờ VF5 (L3) |
| `AF:#21` | REVIEW-CHECKLIST.md · S1-4 | L0 | apps/hub-worker/test/cleanup-job.spec.ts:42 | ✅ pass |
| `AF:#22` | REVIEW-CHECKLIST.md · S1-5 | L0 | apps/hub-worker/test/normalize-consumer.spec.ts:134 | ✅ pass |
| `AF:#23` | REVIEW-CHECKLIST.md · S2-1 | L1 | apps/hub-worker/test/circuit-breaker.spec.ts:175 | chưa chạy |
| `AF:#24` | REVIEW-CHECKLIST.md · S2-1 | L1 | apps/hub-worker/test/circuit-breaker.spec.ts:151 | chưa chạy |
| `AF:#25` | REVIEW-CHECKLIST.md · S2-1 | L0 | apps/hub-worker/test/delivery-consumer.spec.ts:140 | ✅ pass |
| `AF:#26` | REVIEW-CHECKLIST.md · S2-1 | L1 | apps/hub-worker/test/circuit-breaker.spec.ts:240 | chưa chạy |
| `AF:#27` | REVIEW-CHECKLIST.md · S3-6 | — | — | mồ côi có lý do: Kiểm tài liệu ARCHITECTURE (fixed window, không jitter) — không phải test |
| `AF:#28` | REVIEW-CHECKLIST.md · S2-3 | L0 | apps/hub-api/test/replay-bulk.spec.ts:71 | ✅ pass |
| `AF:#29` | REVIEW-CHECKLIST.md · S2-3 | L1 | apps/hub-api/test/replay-bulk-db.spec.ts:58 | chưa chạy |
| `AF:#30` | REVIEW-CHECKLIST.md · S2-2 | L0 | apps/hub-api/test/ingest-trace.spec.ts:60 | ✅ pass |
| `AF:#31` | REVIEW-CHECKLIST.md · S2-2 | L0 | apps/hub-api/test/realtime-auth.spec.ts:87 | ✅ pass |
| `AF:#32` | REVIEW-CHECKLIST.md · S2-5 | — | — | mồ côi có lý do: Badge dashboard đổi đỏ live (GIF) — kiểm tay trên trình duyệt |
| `AF:#34` | REVIEW-CHECKLIST.md · S1-5 | L0 | apps/hub-api/test/subscription-tenant.spec.ts:43 | ✅ pass |
| `AF:#35` | REVIEW-CHECKLIST.md · S1-5 | — | — | mồ côi có lý do: psql -U shop_user … → permission denied (docker) — chờ VF4 nhập vào runner L2 |
| `AF:#37` | REVIEW-CHECKLIST.md · S2-4 | L0 | libs/providers/test/payos-sign.spec.ts:44 | ✅ pass |
| `AF:#38` | REVIEW-CHECKLIST.md · S3-4 | L0 | apps/hub-api/test/metrics.spec.ts:63 | ✅ pass |
| `AF:#39` | REVIEW-CHECKLIST.md · S1-8 | — | — | mồ côi có lý do: bash scripts/e2e-smoke.sh — VF4 thay bằng runner L2 TS có tag |
| `AF:#40` | REVIEW-CHECKLIST.md · S3-5 | L0 | apps/hub-api/test/redis-budget.spec.ts:213 | ✅ pass |
| `AF:#41` | REVIEW-CHECKLIST.md · S3-6 | — | — | mồ côi có lý do: PHU-LUC-SUA.md có bằng chứng cho mỗi câu — tài liệu, không phải test |
| `MS:U17` | SPEC-hub-multi-service.md | L0 | libs/common/test/event-pattern.spec.ts:11 | ✅ pass |
| `MS:U19` | SPEC-hub-multi-service.md | L0 | libs/common/test/event-pattern.spec.ts:24 | ✅ pass |
| `MS:U34` | SPEC-hub-multi-service.md · S14 | L0 | libs/providers/test/canonical-payos.spec.ts:9<br>libs/providers/test/canonical-payos.spec.ts:29 | ✅ pass |
| `MS:U35` | SPEC-hub-multi-service.md · S14 | L0 | libs/providers/test/canonical-payos.spec.ts:37 | ✅ pass |
| `MS:U36` | SPEC-hub-multi-service.md · S14 | L0 | libs/providers/test/canonical-sepay.spec.ts:10 | ✅ pass |
| `MS:U37` | SPEC-hub-multi-service.md · S14 | L0 | libs/providers/test/canonical-same-shape.spec.ts:9 | ✅ pass |
| `MS:U38` | SPEC-hub-multi-service.md · S14 | L0 | libs/providers/test/canonical-stripe.spec.ts:9 | ✅ pass |
| `MS:U39` | SPEC-hub-multi-service.md · S14 | L0 | libs/providers/test/canonical-stripe.spec.ts:40 | ✅ pass |
| `MS:U40` | SPEC-hub-multi-service.md · S14 | L0 | libs/providers/test/canonical-github.spec.ts:10<br>libs/providers/test/canonical-github.spec.ts:27 | ✅ pass |
| `MS:U41` | SPEC-hub-multi-service.md · S14 | L0 | libs/providers/test/canonical-github.spec.ts:34 | ✅ pass |
| `MS:U42` | SPEC-hub-multi-service.md · S14 | L0 | libs/providers/test/canonical-github.spec.ts:57 | ✅ pass |
| `MS:U43` | SPEC-hub-multi-service.md · S14 | L0 | libs/common/test/canonical-time.spec.ts:4 | ✅ pass |
| `MS:U44` | SPEC-hub-multi-service.md · S14 | L0 | libs/common/test/canonical-validate.spec.ts:17 | ✅ pass |
| `MS:U45` | SPEC-hub-multi-service.md · S14 | L0 | apps/hub-worker/test/normalize-canonical.spec.ts:33 | ✅ pass |
| `MS:U50` | SPEC-hub-multi-service.md · S14 | L0 | libs/providers/test/canonical-contract.spec.ts:9 | ✅ pass |
| `VF:VT1` | SPEC-verification.md · VF2 | L0 | verify/test/results.spec.ts:19 | ✅ pass |
| `VF:VT2` | SPEC-verification.md · VF2 | L0 | verify/test/results.spec.ts:32 | ✅ pass |
| `VF:VT3` | SPEC-verification.md · VF2 | L0 | verify/test/map.spec.ts:38 | ✅ pass |
| `VF:VT4` | SPEC-verification.md · VF2 | L0 | verify/test/map.spec.ts:46 | ✅ pass |
| `VF:VT8` | SPEC-verification.md · VF1 | L2* | verify/scenarios/stack-isolation.ts:32 | chưa chạy |
| `VF:VT9` | SPEC-verification.md · VF1 | L2* | verify/scenarios/stack-isolation.ts:42 | chưa chạy |
| `VF:VT13` | SPEC-verification.md · VF1 | L0 | libs/common/test/test-only-config.spec.ts:8 | ✅ pass |

## File test (61 file, 338 khai báo it/test)

Test không ứng với dòng spec nào thì không mang mã (§3.1) — vẫn chạy ở L0/L1 và được bánh cóc đếm.
