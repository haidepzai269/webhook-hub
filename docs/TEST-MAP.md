# TEST-MAP — mã spec → test (tự sinh, đừng sửa tay)

> Sinh bởi `npm run verify:map` (VF2, SPEC-verification §3.2). Trạng thái lấy từ lần `verify` cuối (2026-10-12T08:46:41.337Z, commit d9edad8).
> Chỉ liệt kê mã đã có test, hoặc mã của story đã xong (bắt buộc có test). Mã của story chưa làm được phép mồ côi.
> `L2` = kịch bản e2e qua HTTP vào hubv (`npm run verify:e2e`, VF4). `L2*` = kịch bản tự kiểm của bộ kiểm chứng (`stack-isolation`), chạy bằng tay qua `npm run verify:selftest`.

Tổng: 339 mã khai báo · 263 mã có test · 0 mồ côi · 24 mồ côi có lý do · 0 ma · 0 trùng.

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
| `AF:#12` | REVIEW-CHECKLIST.md · S3-3 | L1 | libs/database/test/subscription-match-db.spec.ts:48 | ✅ pass |
| `AF:#13` | REVIEW-CHECKLIST.md · S3-3 | — | — | mồ côi có lý do: Kiểm bằng grep seed.ts — không phải test jest |
| `AF:#14` | REVIEW-CHECKLIST.md · S1-7 | L0 | apps/hub-worker/test/telegram-sender.spec.ts:11 | ✅ pass |
| `AF:#15` | REVIEW-CHECKLIST.md · S1-1 | L0 | apps/hub-worker/test/normalize-consumer.spec.ts:128 | ✅ pass |
| `AF:#16` | REVIEW-CHECKLIST.md · S1-2 | L0 | apps/hub-worker/test/normalize-consumer.spec.ts:115 | ✅ pass |
| `AF:#17` | REVIEW-CHECKLIST.md · S1-2 | L1 | apps/hub-worker/test/delivery-lease-sweeper.spec.ts:126 | ✅ pass |
| `AF:#18` | REVIEW-CHECKLIST.md · S1-3 | L0 | apps/hub-worker/test/normalize-consumer.spec.ts:204 | ✅ pass |
| `AF:#19` | REVIEW-CHECKLIST.md · S1-3 | L1 | apps/hub-worker/test/delivery-lease-sweeper.spec.ts:87 | ✅ pass |
| `AF:#20` | REVIEW-CHECKLIST.md · S1-4 | L2 | verify/scenarios/chaos-l3.ts:217 | chưa chạy |
| `AF:#21` | REVIEW-CHECKLIST.md · S1-4 | L0 | apps/hub-worker/test/cleanup-job.spec.ts:44 | ✅ pass |
| `AF:#22` | REVIEW-CHECKLIST.md · S1-5 | L0 | apps/hub-worker/test/normalize-consumer.spec.ts:196 | ✅ pass |
| `AF:#23` | REVIEW-CHECKLIST.md · S2-1 | L1 | apps/hub-worker/test/circuit-breaker.spec.ts:175 | ✅ pass |
| `AF:#24` | REVIEW-CHECKLIST.md · S2-1 | L1 | apps/hub-worker/test/circuit-breaker.spec.ts:151 | ✅ pass |
| `AF:#25` | REVIEW-CHECKLIST.md · S2-1 | L0 | apps/hub-worker/test/delivery-consumer.spec.ts:155 | ✅ pass |
| `AF:#26` | REVIEW-CHECKLIST.md · S2-1 | L1 | apps/hub-worker/test/circuit-breaker.spec.ts:240 | ✅ pass |
| `AF:#27` | REVIEW-CHECKLIST.md · S3-6 | — | — | mồ côi có lý do: Kiểm tài liệu ARCHITECTURE (fixed window, không jitter) — không phải test |
| `AF:#28` | REVIEW-CHECKLIST.md · S2-3 | L0 | apps/hub-api/test/replay-bulk.spec.ts:83 | ✅ pass |
| `AF:#29` | REVIEW-CHECKLIST.md · S2-3 | L1 | apps/hub-api/test/replay-bulk-db.spec.ts:58 | ✅ pass |
| `AF:#30` | REVIEW-CHECKLIST.md · S2-2 | L0 | apps/hub-api/test/ingest-trace.spec.ts:63 | ✅ pass |
| `AF:#31` | REVIEW-CHECKLIST.md · S2-2 | L0 | apps/hub-api/test/realtime-auth.spec.ts:49 | ✅ pass |
| `AF:#32` | REVIEW-CHECKLIST.md · S2-5 | — | — | mồ côi có lý do: Badge dashboard đổi đỏ live (GIF) — kiểm tay trên trình duyệt |
| `AF:#34` | REVIEW-CHECKLIST.md · S1-5 | L0 | apps/hub-api/test/subscription-tenant.spec.ts:46 | ✅ pass |
| `AF:#35` | REVIEW-CHECKLIST.md · S1-5 | L2 | verify/scenarios/ingest-e2e.ts:164 | chưa chạy |
| `AF:#37` | REVIEW-CHECKLIST.md · S2-4 | L0 | libs/providers/test/payos-sign.spec.ts:44 | ✅ pass |
| `AF:#38` | REVIEW-CHECKLIST.md · S3-4 | L0 | apps/hub-api/test/metrics.spec.ts:66 | ✅ pass |
| `AF:#39` | REVIEW-CHECKLIST.md · S1-8 | L2 | verify/scenarios/ingest-e2e.ts:156 | chưa chạy |
| `AF:#40` | REVIEW-CHECKLIST.md · S3-5 | L0 | apps/hub-api/test/redis-budget.spec.ts:222 | ✅ pass |
| `AF:#41` | REVIEW-CHECKLIST.md · S3-6 | — | — | mồ côi có lý do: PHU-LUC-SUA.md có bằng chứng cho mỗi câu — tài liệu, không phải test |
| `AR:D-1` | REVIEW-DEPLOY-2026-10-11.md | L0 | apps/hub-api/test/hub-all-supervisor.spec.ts:37 | ✅ pass |
| `AR:D-4` | REVIEW-DEPLOY-2026-10-11.md | L0 | apps/hub-api/test/hub-all-supervisor.spec.ts:48 | ✅ pass |
| `AR:D-5` | REVIEW-DEPLOY-2026-10-11.md | L0 | apps/hub-api/test/hub-all-supervisor.spec.ts:88 | ✅ pass |
| `AR:G-4` | REVIEW-AUTH-2026-10-11.md | L0 | apps/hub-api/test/auth-review.spec.ts:150 | ✅ pass |
| `AR:GO-1` | REVIEW-AUTH-2026-10-11.md | L1 | apps/hub-api/test/google-oauth-db.spec.ts:168 | ✅ pass |
| `AR:GO-2` | REVIEW-AUTH-2026-10-11.md | L1 | apps/hub-api/test/google-oauth-db.spec.ts:157 | ✅ pass |
| `AR:GO-3` | REVIEW-AUTH-2026-10-11.md | L0 | apps/hub-api/test/google-oauth.spec.ts:86 | ✅ pass |
| `AR:GO-4` | REVIEW-AUTH-2026-10-11.md | L0 | apps/hub-api/test/auth-review.spec.ts:175 | ✅ pass |
| `AR:N-1` | REVIEW-AUTH-2026-10-11.md | L1,L2 | apps/hub-api/test/auth-mail-db.spec.ts:130<br>apps/hub-api/test/auth-mail-db.spec.ts:164<br>verify/scenarios/auth-e2e.ts:176 | ✅ pass |
| `AR:N-2` | REVIEW-AUTH-2026-10-11.md | L0 | apps/web/src/app/(admin)/(auth)/_components/next-path.spec.ts:24 | ✅ pass |
| `AR:N-3` | REVIEW-AUTH-2026-10-11.md | L0 | apps/hub-api/test/auth-review.spec.ts:136 | ✅ pass |
| `AR:N-4` | REVIEW-AUTH-2026-10-11.md | L0 | apps/web/src/proxy.spec.ts:19<br>apps/web/src/proxy.spec.ts:27 | ✅ pass |
| `AR:R-2` | REVIEW-AUTH-2026-10-11.md | L0,L2 | apps/hub-api/test/auth-review.spec.ts:15<br>apps/hub-api/test/auth-review.spec.ts:22<br>verify/scenarios/auth-e2e.ts:527 | ✅ pass |
| `AR:R-3` | REVIEW-AUTH-2026-10-11.md | L0,L2 | apps/hub-api/test/auth-review.spec.ts:48<br>apps/hub-api/test/auth-review.spec.ts:81<br>apps/hub-api/test/auth-review.spec.ts:89<br>verify/scenarios/auth-e2e.ts:419 | ✅ pass |
| `AR:R-4` | REVIEW-AUTH-2026-10-11.md | L0 | libs/database/test/repo-batch.spec.ts:29 | ✅ pass |
| `AR:R-5` | REVIEW-AUTH-2026-10-11.md | L2 | verify/scenarios/auth-e2e.ts:517 | chưa chạy |
| `AR:R-6` | REVIEW-AUTH-2026-10-11.md | L1,L2 | apps/hub-api/test/auth-mail-db.spec.ts:112<br>verify/scenarios/auth-e2e.ts:151 | ✅ pass |
| `AR:R-7` | REVIEW-AUTH-2026-10-11.md | L0 | verify/test/gates.spec.ts:103 | ✅ pass |
| `AR:R-8` | REVIEW-AUTH-2026-10-11.md | L0 | apps/hub-api/test/api-key.guard.spec.ts:111<br>apps/hub-api/test/auth-scope.spec.ts:123 | ✅ pass |
| `AR:R-10` | REVIEW-AUTH-2026-10-11.md | L0 | apps/hub-api/test/auth-review.spec.ts:114 | ✅ pass |
| `AR:R-12` | REVIEW-AUTH-2026-10-11.md | L1 | apps/hub-api/test/github-oauth-db.spec.ts:163<br>apps/hub-api/test/github-oauth-db.spec.ts:172 | ✅ pass |
| `AR:R-13` | REVIEW-AUTH-2026-10-11.md | L0,L1 | apps/hub-api/test/auth-review.spec.ts:127<br>apps/hub-api/test/members-db.spec.ts:127<br>apps/hub-api/test/realtime-project.spec.ts:89 | ✅ pass |
| `AR:R-14` | REVIEW-AUTH-2026-10-11.md | L1 | apps/hub-api/test/console-projects-db.spec.ts:89 | ✅ pass |
| `AU:GM1` | spec-sources.json | L0 | libs/common/test/mail-gmail.spec.ts:31 | ✅ pass |
| `AU:GM2` | spec-sources.json | L0 | libs/common/test/mail-gmail.spec.ts:50<br>libs/common/test/mail-gmail.spec.ts:117 | ✅ pass |
| `AU:GM3` | spec-sources.json | L0 | libs/common/test/mail-gmail.spec.ts:60 | ✅ pass |
| `AU:GM4` | spec-sources.json | L0 | libs/common/test/mail-gmail.spec.ts:74<br>libs/common/test/mail-gmail.spec.ts:127 | ✅ pass |
| `AU:GM5` | spec-sources.json | L0 | libs/common/test/mail-gmail.spec.ts:103<br>libs/common/test/mail-gmail.spec.ts:141 | ✅ pass |
| `AU:GM6` | spec-sources.json | L0 | libs/common/test/mail-gmail.spec.ts:156 | ✅ pass |
| `AU:GO1` | spec-sources.json | L0 | apps/hub-api/test/google-oauth.spec.ts:51 | ✅ pass |
| `AU:GO2` | spec-sources.json | L0 | apps/hub-api/test/google-oauth.spec.ts:69 | ✅ pass |
| `AU:GO3` | spec-sources.json | L0 | apps/hub-api/test/google-oauth.spec.ts:120 | ✅ pass |
| `AU:GO4` | spec-sources.json | L0 | apps/hub-api/test/google-oauth.spec.ts:144 | ✅ pass |
| `AU:GO5` | spec-sources.json | L1 | apps/hub-api/test/google-oauth-db.spec.ts:79 | ✅ pass |
| `AU:GO6` | spec-sources.json | L1 | apps/hub-api/test/google-oauth-db.spec.ts:106 | ✅ pass |
| `AU:GO7` | spec-sources.json | L1 | apps/hub-api/test/google-oauth-db.spec.ts:126 | ✅ pass |
| `AU:GO8` | spec-sources.json | L1,L0 | apps/hub-api/test/google-oauth-db.spec.ts:143<br>apps/hub-api/test/google-oauth.spec.ts:175 | ✅ pass |
| `AU:GO9` | spec-sources.json | L2 | verify/scenarios/auth-e2e.ts:469 | chưa chạy |
| `AU:HA1` | spec-sources.json | L0 | apps/hub-api/test/hub-all-supervisor.spec.ts:110 | ✅ pass |
| `AU:HA2` | spec-sources.json | L0 | apps/hub-api/test/hub-all-supervisor.spec.ts:122 | ✅ pass |
| `AU:HA3` | spec-sources.json | L0 | apps/hub-api/test/hub-all-supervisor.spec.ts:135 | ✅ pass |
| `AU:TA1` | SPEC-auth.md · AU1 | L2 | verify/scenarios/auth-e2e.ts:91 | chưa chạy |
| `AU:TA2` | SPEC-auth.md · AU2 | L2 | verify/scenarios/auth-e2e.ts:266 | chưa chạy |
| `AU:TA3` | SPEC-auth.md · AU1 | L2 | verify/scenarios/auth-e2e.ts:120 | chưa chạy |
| `AU:TA4` | SPEC-auth.md · AU1 | L2 | verify/scenarios/auth-e2e.ts:209 | chưa chạy |
| `AU:TA5` | SPEC-auth.md · AU1 | L2 | verify/scenarios/auth-e2e.ts:225 | chưa chạy |
| `AU:TA6` | SPEC-auth.md · AU1 | L2 | verify/scenarios/auth-e2e.ts:244 | chưa chạy |
| `AU:TA7` | SPEC-auth.md · AU1 | L2 | verify/scenarios/auth-e2e.ts:257 | chưa chạy |
| `AU:TA8` | SPEC-auth.md · AU3 | L2 | verify/scenarios/auth-e2e.ts:311 | chưa chạy |
| `AU:TA9` | SPEC-auth.md · AU4 | L2 | verify/scenarios/auth-e2e.ts:380 | chưa chạy |
| `AU:TA10` | SPEC-auth.md · AU2 | L2 | verify/scenarios/auth-e2e.ts:290 | chưa chạy |
| `AU:TA11` | SPEC-auth.md · AU5 | — | — | mồ côi có lý do: Thủ công, cần GitHub OAuth App thật (DINH-CHINH-AUTH §4 #9: TA11 để sau); fake-github là VF4. Logic phủ bằng github-oauth-db.spec (UA23-UA25, PKCE, operator, unlink) với fetch giả |
| `AU:TA12` | SPEC-auth.md · AU6 | L1 | libs/database/test/rls-db.spec.ts:42 | ✅ pass |
| `AU:TA13` | SPEC-auth.md · AU6 | L2 | verify/scenarios/auth-e2e.ts:406 | chưa chạy |
| `AU:TA14` | SPEC-auth.md · AU3 | — | — | mồ côi có lý do: Trình duyệt thật (Chrome + Firefox ở http://localhost:3000): F5 vẫn đăng nhập, document.cookie không thấy __Host-hub_at/rt — phiên TEST làm tay (SPEC-auth §10.2); phía server đã có TA1/TA5/TA6 tự động |
| `AU:TA15` | SPEC-auth.md · AU3 | L2 | verify/scenarios/auth-e2e.ts:367 | chưa chạy |
| `AU:UA1` | SPEC-auth.md · AU1 | L0 | apps/hub-api/test/auth-unit.spec.ts:40 | ✅ pass |
| `AU:UA2` | SPEC-auth.md · AU1 | L0 | apps/hub-api/test/auth-unit.spec.ts:163 | ✅ pass |
| `AU:UA3` | SPEC-auth.md · AU1 | L0 | apps/hub-api/test/auth-unit.spec.ts:168 | ✅ pass |
| `AU:UA4` | SPEC-auth.md · AU1 | L0 | apps/hub-api/test/auth-unit.spec.ts:192 | ✅ pass |
| `AU:UA5` | SPEC-auth.md · AU2 | L1 | apps/hub-api/test/auth-mail-db.spec.ts:93 | ✅ pass |
| `AU:UA6` | SPEC-auth.md · AU1 | L0 | apps/hub-api/test/auth-unit.spec.ts:118 | ✅ pass |
| `AU:UA7` | SPEC-auth.md · AU1 | L1 | apps/hub-api/test/auth-session-db.spec.ts:68 | ✅ pass |
| `AU:UA8` | SPEC-auth.md · AU1 | L1 | apps/hub-api/test/auth-session-db.spec.ts:82 | ✅ pass |
| `AU:UA9` | SPEC-auth.md · AU1 | L1 | apps/hub-api/test/auth-session-db.spec.ts:95 | ✅ pass |
| `AU:UA10` | SPEC-auth.md · AU1 | L1 | apps/hub-api/test/auth-session-db.spec.ts:105 | ✅ pass |
| `AU:UA11` | SPEC-auth.md · AU1 | L0 | apps/hub-api/test/auth-unit.spec.ts:132 | ✅ pass |
| `AU:UA12` | SPEC-auth.md · AU1 | L0 | apps/hub-api/test/auth-unit.spec.ts:70<br>apps/hub-api/test/auth-unit.spec.ts:175 | ✅ pass |
| `AU:UA13` | SPEC-auth.md · AU1 | L0 | apps/hub-api/test/auth-unit.spec.ts:86 | ✅ pass |
| `AU:UA14` | SPEC-auth.md · AU2 | L1 | apps/hub-api/test/auth-mail-db.spec.ts:187 | ✅ pass |
| `AU:UA15` | SPEC-auth.md · AU2 | L1 | apps/hub-api/test/auth-mail-db.spec.ts:209 | ✅ pass |
| `AU:UA16` | SPEC-auth.md · AU3 | L0 | apps/hub-api/test/auth-scope.spec.ts:49 | ✅ pass |
| `AU:UA17` | SPEC-auth.md · AU3 | L0 | apps/hub-api/test/auth-scope.spec.ts:58 | ✅ pass |
| `AU:UA18` | SPEC-auth.md · AU4 | L1 | apps/hub-api/test/members-db.spec.ts:101 | ✅ pass |
| `AU:UA19` | SPEC-auth.md · AU4 | L1 | apps/hub-api/test/members-db.spec.ts:143 | ✅ pass |
| `AU:UA20` | SPEC-auth.md · AU3 | L0 | apps/hub-api/test/auth-scope.spec.ts:87 | ✅ pass |
| `AU:UA21` | SPEC-auth.md · AU3 | L0 | apps/hub-api/test/auth-scope.spec.ts:75 | ✅ pass |
| `AU:UA22` | SPEC-auth.md · AU1 | L0 | libs/common/test/auth-common.spec.ts:73 | ✅ pass |
| `AU:UA23` | SPEC-auth.md · AU5 | L1 | apps/hub-api/test/github-oauth-db.spec.ts:92 | ✅ pass |
| `AU:UA24` | SPEC-auth.md · AU5 | L1 | apps/hub-api/test/github-oauth-db.spec.ts:142 | ✅ pass |
| `AU:UA25` | SPEC-auth.md · AU5 | L1 | apps/hub-api/test/github-oauth-db.spec.ts:151 | ✅ pass |
| `AU:UA26` | SPEC-auth.md · AU4 | L1 | apps/hub-api/test/members-db.spec.ts:71 | ✅ pass |
| `AU:UA27` | SPEC-auth.md · AU4 | L1 | apps/hub-api/test/members-db.spec.ts:81 | ✅ pass |
| `AU:UA28` | SPEC-auth.md · AU3 | L1 | apps/hub-api/test/console-projects-db.spec.ts:101 | ✅ pass |
| `AU:UA29` | SPEC-auth.md · AU3 | L0 | apps/hub-api/test/realtime-project.spec.ts:62 | ✅ pass |
| `AU:UA30` | SPEC-auth.md · AU6 | L0 | libs/database/test/rls-guard.spec.ts:20 | ✅ pass |
| `AU:UA31` | SPEC-auth.md · AU6 | L0 | libs/database/test/rls-guard.spec.ts:36 | ✅ pass |
| `BB:1` | spec-sources.json | L0 | verify/test/bb-invariants.spec.ts:20 | ✅ pass |
| `BB:2` | spec-sources.json | L0,L2 | apps/hub-api/test/ingest-invariants.spec.ts:80<br>verify/scenarios/chaos-l3.ts:235<br>verify/scenarios/chaos-l3.ts:251<br>verify/scenarios/ingest-e2e.ts:105 | ✅ pass |
| `BB:3` | spec-sources.json | L0,L2 | apps/hub-api/test/ingest-invariants.spec.ts:63<br>apps/hub-api/test/ingest-invariants.spec.ts:72<br>apps/hub-worker/test/delivery-consumer.spec.ts:125<br>verify/scenarios/chaos-l3.ts:182 | ✅ pass |
| `BB:4` | spec-sources.json | L0 | verify/test/bb-invariants.spec.ts:25 | ✅ pass |
| `BB:5` | spec-sources.json | L1 | libs/database/test/alerts-db.spec.ts:92<br>libs/database/test/project-schema-db.spec.ts:41<br>libs/database/test/rls-db.spec.ts:42<br>libs/database/test/rls-db.spec.ts:72 | ✅ pass |
| `CB:T1` | SPEC-canh-bao-nhan-dinh.md · CB1 | L0 | libs/common/test/alert-rules.spec.ts:57<br>libs/common/test/alert-rules.spec.ts:97<br>libs/common/test/alert-rules.spec.ts:105<br>libs/common/test/alert-rules.spec.ts:142<br>libs/common/test/alert-rules.spec.ts:151<br>libs/common/test/alert-rules.spec.ts:165<br>libs/common/test/alert-rules.spec.ts:177<br>libs/common/test/alert-rules.spec.ts:200<br>libs/common/test/alert-rules.spec.ts:222<br>libs/common/test/alert-rules.spec.ts:229 | ✅ pass |
| `CB:T2` | SPEC-canh-bao-nhan-dinh.md · CB1 | L1 | apps/hub-worker/test/alert-evaluator-db.spec.ts:117<br>libs/database/test/alerts-db.spec.ts:42 | ✅ pass |
| `CB:T3` | SPEC-canh-bao-nhan-dinh.md · CB2 | L0 | apps/hub-worker/test/alert-evaluator.spec.ts:174 | ✅ pass |
| `CB:T4` | SPEC-canh-bao-nhan-dinh.md · CB2 | L1 | apps/hub-worker/test/alert-evaluator-db.spec.ts:76 | ✅ pass |
| `CB:T5` | SPEC-canh-bao-nhan-dinh.md · CB2 | L1 | apps/hub-worker/test/alert-evaluator-db.spec.ts:179 | ✅ pass |
| `CB:T6` | SPEC-canh-bao-nhan-dinh.md · CB2 | L0 | apps/hub-worker/test/alert-evaluator.spec.ts:195 | ✅ pass |
| `CB:T7` | SPEC-canh-bao-nhan-dinh.md · CB2 | L1,L0 | apps/hub-worker/test/alert-evaluator-db.spec.ts:76<br>apps/hub-worker/test/alert-evaluator.spec.ts:223 | ✅ pass |
| `CB:T8` | SPEC-canh-bao-nhan-dinh.md · CB5 | L1,L0 | apps/hub-worker/test/alert-email-sender-db.spec.ts:118<br>apps/hub-worker/test/alert-email-sender-db.spec.ts:167<br>verify/test/gates.spec.ts:49 | ✅ pass |
| `CB:T9` | SPEC-canh-bao-nhan-dinh.md · CB5 | L1,L0 | apps/hub-worker/test/alert-email-sender-db.spec.ts:207<br>libs/common/test/alert-email.spec.ts:62 | ✅ pass |
| `CB:T10` | SPEC-canh-bao-nhan-dinh.md · CB3 | L1,L0 | apps/hub-api/test/alerts-api-db.spec.ts:99<br>apps/hub-api/test/alerts-api.spec.ts:44<br>apps/hub-api/test/alerts-api.spec.ts:259 | ✅ pass |
| `CB:T11` | SPEC-canh-bao-nhan-dinh.md | L0 | apps/hub-worker/test/alert-evaluator.spec.ts:137 | ✅ pass |
| `CB:T12` | SPEC-canh-bao-nhan-dinh.md · CB3 | L1 | apps/hub-api/test/alerts-api-db.spec.ts:49 | ✅ pass |
| `CB:T13` | SPEC-canh-bao-nhan-dinh.md · CB5 | L1 | apps/hub-worker/test/alert-email-sender-db.spec.ts:302 | ✅ pass |
| `CB:T14` | SPEC-canh-bao-nhan-dinh.md · CB7 | L0 | apps/hub-api/test/destination-view.spec.ts:47 | ✅ pass |
| `CB:T15` | SPEC-canh-bao-nhan-dinh.md · CB4 | L0 | apps/web/src/lib/alerts/notify-logic.spec.ts:106 | ✅ pass |
| `CB:T16` | SPEC-canh-bao-nhan-dinh.md · CB6 | L0 | libs/common/test/insights.spec.ts:25 | ✅ pass |
| `CB:T17` | DINH-CHINH-2026-10-12.md · CB2 | L1 | apps/hub-worker/test/alert-evaluator-db.spec.ts:135 | ✅ pass |
| `DX:TX1` | SPEC-dev-experience.md | — | — | mồ côi có lý do: E2E làm tay bằng curl trên stack dev (SPEC-dev-experience §6.2, PASS 2026-10-11 ở §9). Logic phủ tự động ở L0 [DX:UX1]-[DX:UX5] (error-filter.spec, error-catalog.spec) + [DX:UX11] after=abc/after=latest. |
| `DX:TX2` | SPEC-dev-experience.md | — | — | mồ côi có lý do: Đo bằng đồng hồ với người test chưa đọc code (thời gian từ connection string tới event đầu tiên) — bản chất là phép đo thủ công, không tự động hoá được; chưa có kết quả ở §9. |
| `DX:TX3` | SPEC-dev-experience.md | — | — | mồ côi có lý do: E2E làm tay: hub listen + examples/quickstart-node + SePay mock trên stack dev (PASS 2026-10-11 ở §9). Phần lõi phủ tự động ở L0 [DX:UX9], [DX:UX10], [DX:UX12]-[DX:UX14] (webhook-body.spec, listen.spec). |
| `DX:TX4` | SPEC-dev-experience.md | — | — | mồ côi có lý do: E2E làm tay: đếm hub.deliveries trước/sau TX3 trên stack dev (PASS 2026-10-11 ở §9). listen chỉ đọc vì đi qua polling A (GET), không tạo delivery. |
| `DX:TX5` | SPEC-dev-experience.md | — | — | mồ côi có lý do: E2E làm tay: npx hub trigger + listen trên stack (SPEC-dev-experience §6.2), chưa ghi kết quả ở §9. Phần lõi phủ tự động ở L0 [DX:UX16] (libs/hub-sdk/test/trigger.spec.ts: body qua validateCanonical). |
| `DX:UX1` | SPEC-dev-experience.md | L0 | apps/hub-api/test/error-filter.spec.ts:101<br>apps/hub-api/test/error-filter.spec.ts:117 | ✅ pass |
| `DX:UX2` | SPEC-dev-experience.md | L0 | apps/hub-api/test/error-filter.spec.ts:131 | ✅ pass |
| `DX:UX3` | SPEC-dev-experience.md | L0 | apps/hub-api/test/error-filter.spec.ts:142 | ✅ pass |
| `DX:UX4` | SPEC-dev-experience.md | L0 | libs/common/test/error-catalog.spec.ts:20<br>libs/common/test/error-catalog.spec.ts:31<br>libs/common/test/error-catalog.spec.ts:45 | ✅ pass |
| `DX:UX5` | SPEC-dev-experience.md | L0 | apps/hub-api/test/error-filter.spec.ts:159 | ✅ pass |
| `DX:UX6` | SPEC-dev-experience.md | L0 | apps/hub-api/test/ingest-reject-ack.spec.ts:11<br>apps/hub-api/test/service-resources.spec.ts:349<br>libs/common/test/error-catalog.spec.ts:59<br>libs/providers/test/generic.adapter.spec.ts:160 | ✅ pass |
| `DX:UX7` | SPEC-dev-experience.md | — | — | mồ côi có lý do: Không có code để test: DX2 cắt theo phương án A (SPEC-dev-experience §8 mục 1) — không có buildQuickstart trong libs/hub-sdk; chỉ examples/quickstart-node + docs/QUICKSTART.md. Làm phương án B thì viết libs/hub-sdk/test/quickstart.spec.ts. |
| `DX:UX8` | SPEC-dev-experience.md | — | — | mồ côi có lý do: Không có code để test: route GET …/keys/:id/quickstart thuộc phần DX2 bị cắt (phương án A, SPEC-dev-experience §8 mục 1) — route không tồn tại. Làm phương án B thì viết apps/hub-api/test/quickstart.spec.ts. |
| `DX:UX9` | SPEC-dev-experience.md | L0 | libs/common/test/webhook-body.spec.ts:16 | ✅ pass |
| `DX:UX10` | SPEC-dev-experience.md | L0 | libs/hub-sdk/test/listen.spec.ts:113 | ✅ pass |
| `DX:UX11` | SPEC-dev-experience.md | L1,L0 | apps/hub-api/test/polling-db.spec.ts:61<br>apps/hub-api/test/polling-db.spec.ts:72<br>apps/hub-api/test/polling-db.spec.ts:85<br>apps/hub-api/test/polling-params.spec.ts:43<br>apps/hub-api/test/polling-params.spec.ts:54<br>libs/database/test/orchestrated-methods.spec.ts:69 | ✅ pass |
| `DX:UX12` | SPEC-dev-experience.md | L0 | libs/hub-sdk/test/listen.spec.ts:141 | ✅ pass |
| `DX:UX13` | SPEC-dev-experience.md | L0 | libs/hub-sdk/test/listen.spec.ts:161 | ✅ pass |
| `DX:UX14` | SPEC-dev-experience.md | L0 | libs/hub-sdk/test/listen.spec.ts:174 | ✅ pass |
| `DX:UX15` | SPEC-dev-experience.md | L0 | libs/hub-sdk/test/listen.spec.ts:191 | ✅ pass |
| `DX:UX16` | SPEC-dev-experience.md | L0 | libs/hub-sdk/test/trigger.spec.ts:45 | ✅ pass |
| `EG:T1` | SPEC-chong-qua-tai.md · EG2 | L0 | apps/hub-api/test/penalty-box.spec.ts:54 | ✅ pass |
| `EG:T4` | SPEC-chong-qua-tai.md · EG2 | L0 | apps/hub-api/test/penalty-box.spec.ts:74 | ✅ pass |
| `EG:T5` | SPEC-chong-qua-tai.md · EG2 | L0 | apps/hub-api/test/penalty-box.spec.ts:86 | ✅ pass |
| `EG:T6` | SPEC-chong-qua-tai.md · EG2 | L0 | apps/hub-api/test/penalty-box.spec.ts:101 | ✅ pass |
| `EG:T7` | SPEC-chong-qua-tai.md · EG2 | L0 | apps/hub-api/test/penalty-box.spec.ts:123 | ✅ pass |
| `KN:T1` | SPEC-ket-noi.md · KN1 | — | — | mồ côi có lý do: L2 trên hubv chưa chạy: image hub-api của hubv chưa rebuild với code KN (phiên dev không được restart/rebuild hubv — VF đang chạy chaos). Logic phủ ở L1 [KN:U1]-[KN:U4] (console-endpoints-db.spec.ts). |
| `KN:T2` | SPEC-ket-noi.md · KN3 | — | — | mồ côi có lý do: L2 trên hubv chưa chạy (cần rebuild image + PAYOS_FAKE_BASE_URL/CONNECTOR_INGEST_BASE_URL trong .env.verify). Luồng tương đương chạy ở L1 với fake PayOS của sink trong tiến trình: payos-connect-db.spec.ts [KN:U8] (phần b). |
| `KN:T3` | SPEC-ket-noi.md · KN4 | — | — | mồ côi có lý do: L2 trên hubv chưa chạy (cần rebuild image + STRIPE_FAKE_BASE_URL trong .env.verify). Tương đương ở L1 với fake Stripe của sink trong tiến trình: stripe-connect-db.spec.ts [KN:U14][KN:U15] + [KN4] status/ngắt (DELETE tới đúng we_). |
| `KN:T4` | SPEC-ket-noi.md · KN2 | — | — | mồ côi có lý do: L2 trên hubv chưa chạy: image hub-api của hubv chưa rebuild với code KN (phiên dev không được restart/rebuild hubv). Cô lập project phủ ở L1 [KN2] project khác → 404 giống hệt + RLS (source-connections-db.spec.ts). |
| `KN:U1` | SPEC-ket-noi.md · KN1 | L1 | apps/hub-api/test/console-endpoints-db.spec.ts:58 | ✅ pass |
| `KN:U2` | SPEC-ket-noi.md · KN1 | L1 | apps/hub-api/test/console-endpoints-db.spec.ts:80 | ✅ pass |
| `KN:U3` | SPEC-ket-noi.md · KN1 | L1 | apps/hub-api/test/console-endpoints-db.spec.ts:89 | ✅ pass |
| `KN:U4` | SPEC-ket-noi.md · KN1 | L1 | apps/hub-api/test/console-endpoints-db.spec.ts:104 | ✅ pass |
| `KN:U5` | SPEC-ket-noi.md · KN1 | L0 | apps/hub-api/test/console-endpoints.spec.ts:9 | ✅ pass |
| `KN:U6` | SPEC-ket-noi.md · KN2 | L0 | apps/hub-api/test/source-connections.spec.ts:22 | ✅ pass |
| `KN:U7` | SPEC-ket-noi.md · KN2 | L0 | apps/hub-api/test/source-connections.spec.ts:31 | ✅ pass |
| `KN:U8` | SPEC-ket-noi.md · KN2 | L1 | apps/hub-api/test/payos-connect-db.spec.ts:63<br>apps/hub-api/test/source-connections-db.spec.ts:74 | ✅ pass |
| `KN:U9` | SPEC-ket-noi.md · KN2 | L1 | apps/hub-api/test/source-connections-db.spec.ts:86 | ✅ pass |
| `KN:U10` | SPEC-ket-noi.md · KN2 | L1 | apps/hub-api/test/source-connections-db.spec.ts:99 | ✅ pass |
| `KN:U11` | SPEC-ket-noi.md · KN2 | L1 | apps/hub-api/test/source-connections-db.spec.ts:127 | ✅ pass |
| `KN:U12` | SPEC-ket-noi.md · KN2 | L0 | apps/hub-api/test/payos-connector.spec.ts:25<br>apps/hub-api/test/source-connections.spec.ts:42 | ✅ pass |
| `KN:U13` | SPEC-ket-noi.md · KN3 | L0 | apps/hub-api/test/payos-connector.spec.ts:12 | ✅ pass |
| `KN:U14` | SPEC-ket-noi.md · KN4 | L1 | apps/hub-api/test/stripe-connect-db.spec.ts:60 | ✅ pass |
| `KN:U15` | SPEC-ket-noi.md · KN4 | L1 | apps/hub-api/test/stripe-connect-db.spec.ts:81 | ✅ pass |
| `KN:U16` | SPEC-ket-noi.md · KN3 | L0,L1,L2 | apps/hub-api/test/flow-probe-trace.spec.ts:43<br>apps/hub-api/test/ingest-payos-probe.spec.ts:61<br>apps/hub-api/test/ingest-payos-probe.spec.ts:72<br>apps/hub-api/test/ingest-payos-probe.spec.ts:91<br>apps/hub-api/test/polling-db.spec.ts:172<br>apps/hub-worker/test/normalize-consumer.spec.ts:168<br>apps/hub-worker/test/normalize-consumer.spec.ts:188<br>libs/common/test/flow/build-event-flow.spec.ts:135<br>libs/common/test/flow/build-event-flow.spec.ts:146<br>libs/providers/test/payos-confirm-probe.spec.ts:42<br>libs/providers/test/payos-confirm-probe.spec.ts:61<br>libs/providers/test/payos-confirm-probe.spec.ts:71<br>libs/providers/test/payos-confirm-probe.spec.ts:76<br>tools/hub-sim/test/hub-sim.spec.ts:100<br>verify/scenarios/ingest-e2e.ts:188 | ✅ pass |
| `KN:U17` | SPEC-ket-noi.md · KN2 | L1 | apps/hub-api/test/source-connections-db.spec.ts:152 | ✅ pass |
| `KN:U18` | SPEC-ket-noi.md · KN2 | L0 | apps/hub-api/test/source-connections.spec.ts:53 | ✅ pass |
| `KN:U19` | SPEC-ket-noi.md · KN2 | L1 | apps/hub-api/test/payos-connect-db.spec.ts:110 | ✅ pass |
| `KN:U20` | SPEC-ket-noi.md · KN2 | L1 | apps/hub-api/test/payos-connect-db.spec.ts:130 | ✅ pass |
| `KN:U21` | SPEC-ket-noi.md · KN2 | L1 | apps/hub-api/test/payos-connect-db.spec.ts:180 | ✅ pass |
| `KN:U22` | SPEC-ket-noi.md · KN2 | L1 | apps/hub-api/test/payos-connect-db.spec.ts:194 | ✅ pass |
| `KN:U23` | SPEC-ket-noi.md · KN2 | L1 | apps/hub-api/test/payos-connect-db.spec.ts:206 | ✅ pass |
| `KN:U24` | SPEC-ket-noi.md · KN2 | L1 | apps/hub-api/test/stripe-connect-db.spec.ts:97 | ✅ pass |
| `KN:U25` | SPEC-ket-noi.md · KN2 | L1 | apps/hub-api/test/payos-connect-db.spec.ts:149 | ✅ pass |
| `KN:U26` | SPEC-ket-noi.md · KN2 | L1 | apps/hub-api/test/payos-connect-db.spec.ts:172 | ✅ pass |
| `KN:U27` | SPEC-ket-noi.md · KN2 | L1 | apps/hub-api/test/payos-connect-db.spec.ts:227 | ✅ pass |
| `KN:U28` | SPEC-ket-noi.md · KN2 | L1 | apps/hub-api/test/payos-connect-db.spec.ts:243 | ✅ pass |
| `KN:U29` | SPEC-ket-noi.md · KN2 | L1 | apps/hub-api/test/payos-connect-db.spec.ts:278 | ✅ pass |
| `MS:T2` | SPEC-hub-multi-service.md · S3 | L0 | apps/hub-api/test/service-resources.spec.ts:184 | ✅ pass |
| `MS:T4` | SPEC-hub-multi-service.md · S6 | L0 | apps/hub-api/test/endpoint-verifier.spec.ts:44<br>apps/hub-api/test/endpoint-verifier.spec.ts:53<br>apps/hub-api/test/service-resources.spec.ts:157<br>apps/hub-api/test/service-resources.spec.ts:174<br>libs/crypto/test/ssrf-metadata.spec.ts:11 | ✅ pass |
| `MS:T5` | SPEC-hub-multi-service.md · S5 | L0 | apps/hub-api/test/service-resources.spec.ts:124<br>apps/hub-api/test/service-resources.spec.ts:131<br>apps/hub-api/test/service-resources.spec.ts:149 | ✅ pass |
| `MS:T9` | SPEC-hub-multi-service.md · S8 | L0 | apps/hub-api/test/ingest-generic.spec.ts:34<br>apps/hub-api/test/ingest-generic.spec.ts:41<br>apps/hub-api/test/service-sources.spec.ts:48<br>apps/hub-api/test/service-sources.spec.ts:62<br>apps/hub-api/test/service-sources.spec.ts:102 | ✅ pass |
| `MS:T10` | SPEC-hub-multi-service.md · S10 | L0 | apps/hub-worker/test/delivery-timeout.spec.ts:29 | ✅ pass |
| `MS:T13` | SPEC-hub-multi-service.md · S7 | L0,L1 | apps/hub-worker/test/cleanup-job.spec.ts:75<br>libs/database/test/retention-db.spec.ts:52 | ✅ pass |
| `MS:T14` | SPEC-hub-multi-service.md · S12 | L1 | libs/database/test/seed-demo-db.spec.ts:16 | ✅ pass |
| `MS:U1` | SPEC-hub-multi-service.md · S6 | L0 | libs/crypto/test/standard-webhooks.spec.ts:16 | ✅ pass |
| `MS:U2` | SPEC-hub-multi-service.md · S6 | L0 | libs/crypto/test/standard-webhooks.spec.ts:20 | ✅ pass |
| `MS:U3` | SPEC-hub-multi-service.md · S6 | L0 | libs/crypto/test/standard-webhooks.spec.ts:25 | ✅ pass |
| `MS:U4` | SPEC-hub-multi-service.md · S6 | L0 | libs/crypto/test/standard-webhooks.spec.ts:33 | ✅ pass |
| `MS:U5` | SPEC-hub-multi-service.md · S6 | L0 | libs/crypto/test/standard-webhooks.spec.ts:39 | ✅ pass |
| `MS:U6` | SPEC-hub-multi-service.md · S6 | L0 | libs/crypto/test/standard-webhooks.spec.ts:12 | ✅ pass |
| `MS:U7` | SPEC-hub-multi-service.md · S8 | L0 | libs/providers/test/generic.adapter.spec.ts:32 | ✅ pass |
| `MS:U8` | SPEC-hub-multi-service.md · S8 | L0 | libs/providers/test/generic.adapter.spec.ts:36 | ✅ pass |
| `MS:U9` | SPEC-hub-multi-service.md · S8 | L0 | libs/providers/test/generic.adapter.spec.ts:42 | ✅ pass |
| `MS:U10` | SPEC-hub-multi-service.md · S8 | L0 | libs/providers/test/generic.adapter.spec.ts:49 | ✅ pass |
| `MS:U11` | SPEC-hub-multi-service.md · S8 | L0 | libs/providers/test/generic.adapter.spec.ts:56 | ✅ pass |
| `MS:U12` | SPEC-hub-multi-service.md · S8 | L0 | libs/providers/test/generic.adapter.spec.ts:75 | ✅ pass |
| `MS:U13` | SPEC-hub-multi-service.md · S8 | L0 | libs/providers/test/generic.adapter.spec.ts:83 | ✅ pass |
| `MS:U14` | SPEC-hub-multi-service.md · S8 | L0 | libs/providers/test/generic.adapter.spec.ts:112 | ✅ pass |
| `MS:U15` | SPEC-hub-multi-service.md · S9 | L0 | libs/providers/test/generic.adapter.spec.ts:173 | ✅ pass |
| `MS:U16` | SPEC-hub-multi-service.md · S4 | L0 | libs/providers/test/api.adapter.spec.ts:8 | ✅ pass |
| `MS:U17` | SPEC-hub-multi-service.md · S5 | L0 | libs/common/test/event-pattern.spec.ts:11 | ✅ pass |
| `MS:U18` | SPEC-hub-multi-service.md · S5 | L0,L1 | apps/hub-worker/test/normalize-consumer.spec.ts:137<br>libs/database/test/repository-scope.spec.ts:28<br>libs/database/test/subscription-match-db.spec.ts:95 | ✅ pass |
| `MS:U19` | SPEC-hub-multi-service.md · S5 | L0 | apps/hub-api/test/service-resources.spec.ts:138<br>libs/common/test/event-pattern.spec.ts:24 | ✅ pass |
| `MS:U20` | SPEC-hub-multi-service.md · S3 | L0 | apps/hub-api/test/api-key.guard.spec.ts:59 | ✅ pass |
| `MS:U21` | SPEC-hub-multi-service.md · S3 | L0 | apps/hub-api/test/api-key.guard.spec.ts:68 | ✅ pass |
| `MS:U22` | SPEC-hub-multi-service.md · S3 | L0 | apps/hub-api/test/api-key.guard.spec.ts:77 | ✅ pass |
| `MS:U23` | SPEC-hub-multi-service.md · S3 | L0 | apps/hub-api/test/api-key.guard.spec.ts:87 | ✅ pass |
| `MS:U24` | SPEC-hub-multi-service.md · S7 | L1 | apps/hub-api/test/polling-db.spec.ts:42 | ✅ pass |
| `MS:U25` | SPEC-hub-multi-service.md · S7 | L1,L0 | apps/hub-api/test/polling-db.spec.ts:48<br>apps/hub-api/test/polling-params.spec.ts:27 | ✅ pass |
| `MS:U26` | SPEC-hub-multi-service.md · S7 | L1 | apps/hub-api/test/polling-db.spec.ts:146 | ✅ pass |
| `MS:U27` | SPEC-hub-multi-service.md · S7 | L1 | apps/hub-api/test/polling-db.spec.ts:159 | ✅ pass |
| `MS:U28` | SPEC-hub-multi-service.md · S10 | L0 | apps/hub-worker/test/delivery-consumer.spec.ts:429 | ✅ pass |
| `MS:U29` | SPEC-hub-multi-service.md · S0 | L0 | apps/hub-worker/test/normalize-consumer.spec.ts:115 | ✅ pass |
| `MS:U30` | SPEC-hub-multi-service.md · S6 | L0 | apps/hub-worker/test/normalize-consumer.spec.ts:145 | ✅ pass |
| `MS:U31` | SPEC-hub-multi-service.md · S11 | L0 | libs/hub-sdk/test/sdk.spec.ts:23 | ✅ pass |
| `MS:U32` | SPEC-hub-multi-service.md · S11 | L0 | libs/hub-sdk/test/sdk.spec.ts:30 | ✅ pass |
| `MS:U33` | SPEC-hub-multi-service.md · S11 | L0 | libs/hub-sdk/test/sdk.spec.ts:48 | ✅ pass |
| `MS:U34` | SPEC-hub-multi-service.md · S14 | L0 | libs/providers/test/canonical-payos.spec.ts:9<br>libs/providers/test/canonical-payos.spec.ts:29 | ✅ pass |
| `MS:U35` | SPEC-hub-multi-service.md · S14 | L0 | libs/providers/test/canonical-payos.spec.ts:37 | ✅ pass |
| `MS:U36` | SPEC-hub-multi-service.md · S14 | L0 | libs/providers/test/canonical-sepay.spec.ts:10 | ✅ pass |
| `MS:U37` | SPEC-hub-multi-service.md · S14 | L0 | libs/providers/test/canonical-same-shape.spec.ts:9 | ✅ pass |
| `MS:U38` | SPEC-hub-multi-service.md · S14 | L0 | libs/providers/test/canonical-stripe.spec.ts:9 | ✅ pass |
| `MS:U39` | SPEC-hub-multi-service.md · S14 | L0 | libs/providers/test/canonical-stripe.spec.ts:40 | ✅ pass |
| `MS:U40` | SPEC-hub-multi-service.md · S14 | L0 | libs/providers/test/canonical-github.spec.ts:11<br>libs/providers/test/canonical-github.spec.ts:28 | ✅ pass |
| `MS:U41` | SPEC-hub-multi-service.md · S14 | L0 | libs/providers/test/canonical-github.spec.ts:35 | ✅ pass |
| `MS:U42` | SPEC-hub-multi-service.md · S14 | L0 | libs/providers/test/canonical-github.spec.ts:58 | ✅ pass |
| `MS:U43` | SPEC-hub-multi-service.md · S14 | L0 | libs/common/test/canonical-time.spec.ts:4 | ✅ pass |
| `MS:U44` | SPEC-hub-multi-service.md · S14 | L0 | libs/common/test/canonical-validate.spec.ts:17 | ✅ pass |
| `MS:U45` | SPEC-hub-multi-service.md · S14 | L0 | apps/hub-worker/test/normalize-canonical.spec.ts:33 | ✅ pass |
| `MS:U46` | SPEC-hub-multi-service.md · S8 | L0 | libs/providers/test/generic.adapter.spec.ts:125 | ✅ pass |
| `MS:U47` | SPEC-hub-multi-service.md · S8 | L0 | libs/providers/test/generic.adapter.spec.ts:133 | ✅ pass |
| `MS:U48` | SPEC-hub-multi-service.md · S8 | L0 | libs/providers/test/generic.adapter.spec.ts:145<br>libs/providers/test/generic.adapter.spec.ts:194 | ✅ pass |
| `MS:U49` | SPEC-hub-multi-service.md · S4 | L0 | apps/hub-api/test/publish-canonical.spec.ts:30 | ✅ pass |
| `MS:U50` | SPEC-hub-multi-service.md · S14 | L0 | libs/providers/test/canonical-contract.spec.ts:9 | ✅ pass |
| `SK:T1` | SPEC-shop-ket-noi-project.md | — | — | mồ côi có lý do: L2 trên hubv chưa chạy: cần rebuild image hub-api/shop/web của hubv với code SK (phiên dev không được rebuild/restart container). Phủ ở L0 settings.spec [SK:U1]-[SK:U5], L1 settings-db.spec [SK:U4] + GRANT shop_user, console-projects-db.spec [SK:U6]. Kịch bản tay: HUONG-DAN-TEST-TINH-HUONG Kịch bản 10. |
| `SK:U1` | SPEC-shop-ket-noi-project.md · SK2 | L0 | apps/shop/test/settings.spec.ts:134<br>apps/shop/test/settings.spec.ts:252 | ✅ pass |
| `SK:U2` | SPEC-shop-ket-noi-project.md · SK2 | L0 | apps/shop/test/settings.spec.ts:98<br>apps/shop/test/settings.spec.ts:112<br>apps/shop/test/settings.spec.ts:298<br>apps/shop/test/settings.spec.ts:316 | ✅ pass |
| `SK:U3` | SPEC-shop-ket-noi-project.md · SK2 | L1,L0 | apps/shop/test/settings-db.spec.ts:41<br>apps/shop/test/settings.spec.ts:162<br>apps/shop/test/settings.spec.ts:184<br>apps/shop/test/settings.spec.ts:213<br>apps/shop/test/settings.spec.ts:225<br>apps/shop/test/settings.spec.ts:389<br>apps/shop/test/settings.spec.ts:407 | ✅ pass |
| `SK:U4` | SPEC-shop-ket-noi-project.md · SK2 | L1,L0 | apps/shop/test/settings-db.spec.ts:27<br>apps/shop/test/settings.spec.ts:123 | ✅ pass |
| `SK:U5` | SPEC-shop-ket-noi-project.md · SK2 | L0 | apps/shop/test/settings.spec.ts:266<br>apps/shop/test/settings.spec.ts:375<br>apps/shop/test/settings.spec.ts:429 | ✅ pass |
| `SK:U6` | SPEC-shop-ket-noi-project.md · SK1 | L1,L0 | apps/hub-api/test/console-projects-db.spec.ts:130<br>apps/web/src/lib/hub/keys-logic.spec.ts:28 | ✅ pass |
| `SK:U7` | SPEC-shop-ket-noi-project.md · SK4 | L0 | apps/web/src/lib/shop/order-status.spec.ts:66<br>apps/web/src/lib/shop/order-status.spec.ts:71 | ✅ pass |
| `VF:VT1` | SPEC-verification.md · VF2 | L0 | verify/test/results.spec.ts:19 | ✅ pass |
| `VF:VT2` | SPEC-verification.md · VF2 | L0 | verify/test/results.spec.ts:32 | ✅ pass |
| `VF:VT3` | SPEC-verification.md · VF2 | L0 | verify/test/map.spec.ts:38 | ✅ pass |
| `VF:VT4` | SPEC-verification.md · VF2 | L0 | verify/test/map.spec.ts:46 | ✅ pass |
| `VF:VT5` | SPEC-verification.md · VF3 | L0 | tools/hub-sim/test/hub-sim.spec.ts:18<br>tools/hub-sim/test/hub-sim.spec.ts:29<br>tools/hub-sim/test/hub-sim.spec.ts:40<br>tools/hub-sim/test/hub-sim.spec.ts:47 | ✅ pass |
| `VF:VT6` | SPEC-verification.md · VF3 | L0,L2 | verify/test/hub-sim-adapters.spec.ts:39<br>verify/scenarios/ingest-e2e.ts:94 | ✅ pass |
| `VF:VT7` | SPEC-verification.md · VF7 | L0 | verify/test/gates.spec.ts:9 | ✅ pass |
| `VF:VT8` | SPEC-verification.md · VF1 | L2* | verify/scenarios/stack-isolation.ts:32 | chưa chạy |
| `VF:VT9` | SPEC-verification.md · VF1 | L2* | verify/scenarios/stack-isolation.ts:42 | chưa chạy |
| `VF:VT10` | SPEC-verification.md · VF6 | L0 | verify/test/probe.spec.ts:8 | ✅ pass |
| `VF:VT11` | SPEC-verification.md · VF6 | — | — | mồ côi có lý do: Chứng minh bằng chính lệnh `npm run verify:probe -- --all` (bảng probe + kiểm VT11: đột biến không rò ra cây thật, không worktree sót) — job CI `probe` chạy đêm (riêng, không phụ thuộc chaos); con số --all theo luật phán mới (đối chứng + đỏ đúng lý do, H-1/L-R2-1) chờ lượt `--all` đầu tiên, chưa có |
| `VF:VT12` | SPEC-verification.md · VF6 | — | — | mồ côi có lý do: Probe P-VT12-01 (ownerAsApp): chạy rls-db.spec bằng DATABASE_URL owner → [AU:TA12][BB:5] (phần a) đỏ ở assert tiền đề; kiểm bằng verify:probe, không phải tên test |
| `VF:VT13` | SPEC-verification.md · VF1 | L0 | libs/common/test/test-only-config.spec.ts:8 | ✅ pass |
| `VF:VT14` | SPEC-verification.md · VF8 | — | — | mồ côi có lý do: demo:reset --env deployed CHƯA có (cần API operator xoá dữ liệu production — CAN-ADMIN-QUYET-VF Q4); lệnh hiện từ chối, không xoá gì |
| `VF:VT15` | SPEC-verification.md · VF7 | — | — | mồ côi có lý do: Cần push + GitHub Actions thật + branch protection trên main; phiên này không push (chạy tay từng bước job ở local) |

## File test (188 file, 1228 khai báo it/test)

Test không ứng với dòng spec nào thì không mang mã (§3.1) — vẫn chạy ở L0/L1 và được bánh cóc đếm.
