# TEST-MAP — mã spec → test (tự sinh, đừng sửa tay)

> Sinh bởi `npm run verify:map` (VF2, SPEC-verification §3.2). Trạng thái lấy từ lần `verify` cuối (chưa chạy, commit —).
> Chỉ liệt kê mã đã có test, hoặc mã của story đã xong (bắt buộc có test). Mã của story chưa làm được phép mồ côi.
> `L2` = kịch bản e2e qua HTTP vào hubv (`npm run verify:e2e`, VF4). `L2*` = kịch bản tự kiểm của bộ kiểm chứng (`stack-isolation`), chạy bằng tay qua `npm run verify:selftest`.

Tổng: 462 mã khai báo · 374 mã có test · 0 mồ côi · 24 mồ côi có lý do · 0 ma · 0 trùng.

| mã | spec · story | tầng | file:dòng | trạng thái lần chạy cuối |
|---|---|---|---|---|
| `AF:#1` | REVIEW-CHECKLIST.md · S1-6 | — | — | mồ côi có lý do: Kiểm bằng ls libs/*/dist + đổi tên export rồi khởi động container (docker) — chờ VF4/VF5 nhập vào runner L2 |
| `AF:#2` | REVIEW-CHECKLIST.md · S1-6 | — | — | mồ côi có lý do: Kiểm bằng grep docker-entrypoint.sh + thư mục migrations — không phải test jest |
| `AF:#3` | REVIEW-CHECKLIST.md · S1-7 | L0 | libs/crypto/test/ssrf-axios.spec.ts:27 | chưa chạy |
| `AF:#4` | REVIEW-CHECKLIST.md · S1-7 | L0 | libs/database/test/seed-env.spec.ts:14 | chưa chạy |
| `AF:#5` | REVIEW-CHECKLIST.md · S3-1 | L0 | libs/providers/test/signature-s3-1.spec.ts:42 | chưa chạy |
| `AF:#6` | REVIEW-CHECKLIST.md · S3-1 | L0 | libs/providers/test/signature-s3-1.spec.ts:71 | chưa chạy |
| `AF:#7` | REVIEW-CHECKLIST.md · S3-1 | L0 | libs/providers/test/signature-s3-1.spec.ts:79 | chưa chạy |
| `AF:#8` | REVIEW-CHECKLIST.md · S3-1 | L0 | libs/providers/test/signature-s3-1.spec.ts:138 | chưa chạy |
| `AF:#9` | REVIEW-CHECKLIST.md · S3-2 | L0 | libs/providers/test/canonical-same-shape.spec.ts:9 | chưa chạy |
| `AF:#10` | REVIEW-CHECKLIST.md · S3-2 | L0 | libs/providers/test/canonical-payos.spec.ts:37 | chưa chạy |
| `AF:#11` | REVIEW-CHECKLIST.md · S3-2 | L0 | libs/providers/test/canonical-sepay.spec.ts:18 | chưa chạy |
| `AF:#12` | REVIEW-CHECKLIST.md · S3-3 | L1 | libs/database/test/subscription-match-db.spec.ts:48 | chưa chạy |
| `AF:#13` | REVIEW-CHECKLIST.md · S3-3 | — | — | mồ côi có lý do: Kiểm bằng grep seed.ts — không phải test jest |
| `AF:#14` | REVIEW-CHECKLIST.md · S1-7 | L0 | apps/hub-worker/test/telegram-sender.spec.ts:11 | chưa chạy |
| `AF:#15` | REVIEW-CHECKLIST.md · S1-1 | L0 | apps/hub-worker/test/normalize-consumer.spec.ts:128 | chưa chạy |
| `AF:#16` | REVIEW-CHECKLIST.md · S1-2 | L0 | apps/hub-worker/test/normalize-consumer.spec.ts:115 | chưa chạy |
| `AF:#17` | REVIEW-CHECKLIST.md · S1-2 | L1 | apps/hub-worker/test/delivery-lease-sweeper.spec.ts:126 | chưa chạy |
| `AF:#18` | REVIEW-CHECKLIST.md · S1-3 | L0 | apps/hub-worker/test/normalize-consumer.spec.ts:205 | chưa chạy |
| `AF:#19` | REVIEW-CHECKLIST.md · S1-3 | L1 | apps/hub-worker/test/delivery-lease-sweeper.spec.ts:87 | chưa chạy |
| `AF:#20` | REVIEW-CHECKLIST.md · S1-4 | L2 | verify/scenarios/chaos-l3.ts:79 | chưa chạy |
| `AF:#21` | REVIEW-CHECKLIST.md · S1-4 | L0 | apps/hub-worker/test/cleanup-job.spec.ts:45 | chưa chạy |
| `AF:#22` | REVIEW-CHECKLIST.md · S1-5 | L0 | apps/hub-worker/test/normalize-consumer.spec.ts:197 | chưa chạy |
| `AF:#23` | REVIEW-CHECKLIST.md · S2-1 | L1 | apps/hub-worker/test/circuit-breaker.spec.ts:254 | chưa chạy |
| `AF:#24` | REVIEW-CHECKLIST.md · S2-1 | L1 | apps/hub-worker/test/circuit-breaker.spec.ts:230 | chưa chạy |
| `AF:#25` | REVIEW-CHECKLIST.md · S2-1 | L0 | apps/hub-worker/test/delivery-consumer.spec.ts:169 | chưa chạy |
| `AF:#26` | REVIEW-CHECKLIST.md · S2-1 | L1 | apps/hub-worker/test/circuit-breaker.spec.ts:496 | chưa chạy |
| `AF:#27` | REVIEW-CHECKLIST.md · S3-6 | — | — | mồ côi có lý do: Kiểm tài liệu ARCHITECTURE (fixed window, không jitter) — không phải test |
| `AF:#28` | REVIEW-CHECKLIST.md · S2-3 | L0 | apps/hub-api/test/replay-bulk.spec.ts:84 | chưa chạy |
| `AF:#29` | REVIEW-CHECKLIST.md · S2-3 | L1 | apps/hub-api/test/replay-bulk-db.spec.ts:58 | chưa chạy |
| `AF:#30` | REVIEW-CHECKLIST.md · S2-2 | L0 | apps/hub-api/test/ingest-trace.spec.ts:64 | chưa chạy |
| `AF:#31` | REVIEW-CHECKLIST.md · S2-2 | L0 | apps/hub-api/test/realtime-auth.spec.ts:49 | chưa chạy |
| `AF:#32` | REVIEW-CHECKLIST.md · S2-5 | — | — | mồ côi có lý do: Badge dashboard đổi đỏ live (GIF) — kiểm tay trên trình duyệt |
| `AF:#34` | REVIEW-CHECKLIST.md · S1-5 | L0 | apps/hub-api/test/subscription-tenant.spec.ts:46 | chưa chạy |
| `AF:#35` | REVIEW-CHECKLIST.md · S1-5 | L2 | verify/scenarios/ingest-e2e.ts:164 | chưa chạy |
| `AF:#37` | REVIEW-CHECKLIST.md · S2-4 | L0 | libs/providers/test/payos-sign.spec.ts:44 | chưa chạy |
| `AF:#38` | REVIEW-CHECKLIST.md · S3-4 | L0 | apps/hub-api/test/metrics.spec.ts:66 | chưa chạy |
| `AF:#39` | REVIEW-CHECKLIST.md · S1-8 | L2 | verify/scenarios/ingest-e2e.ts:156 | chưa chạy |
| `AF:#40` | REVIEW-CHECKLIST.md · S3-5 | L0 | apps/hub-api/test/redis-budget.spec.ts:308 | chưa chạy |
| `AF:#41` | REVIEW-CHECKLIST.md · S3-6 | — | — | mồ côi có lý do: PHU-LUC-SUA.md có bằng chứng cho mỗi câu — tài liệu, không phải test |
| `AR:D-1` | REVIEW-DEPLOY-2026-10-11.md | L0 | apps/hub-api/test/hub-all-supervisor.spec.ts:37 | chưa chạy |
| `AR:D-4` | REVIEW-DEPLOY-2026-10-11.md | L0 | apps/hub-api/test/hub-all-supervisor.spec.ts:48 | chưa chạy |
| `AR:D-5` | REVIEW-DEPLOY-2026-10-11.md | L0 | apps/hub-api/test/hub-all-supervisor.spec.ts:88 | chưa chạy |
| `AR:G-4` | REVIEW-AUTH-2026-10-11.md | L0 | apps/hub-api/test/auth-review.spec.ts:150 | chưa chạy |
| `AR:GO-1` | REVIEW-AUTH-2026-10-11.md | L1 | apps/hub-api/test/google-oauth-db.spec.ts:168 | chưa chạy |
| `AR:GO-2` | REVIEW-AUTH-2026-10-11.md | L1 | apps/hub-api/test/google-oauth-db.spec.ts:157 | chưa chạy |
| `AR:GO-3` | REVIEW-AUTH-2026-10-11.md | L0 | apps/hub-api/test/google-oauth.spec.ts:86 | chưa chạy |
| `AR:GO-4` | REVIEW-AUTH-2026-10-11.md | L0 | apps/hub-api/test/auth-review.spec.ts:175 | chưa chạy |
| `AR:N-1` | REVIEW-AUTH-2026-10-11.md | L1,L2 | apps/hub-api/test/auth-mail-db.spec.ts:130<br>apps/hub-api/test/auth-mail-db.spec.ts:164<br>verify/scenarios/auth-e2e.ts:176 | chưa chạy |
| `AR:N-2` | REVIEW-AUTH-2026-10-11.md | L0 | apps/web/src/app/(admin)/(auth)/_components/next-path.spec.ts:24 | chưa chạy |
| `AR:N-3` | REVIEW-AUTH-2026-10-11.md | L0 | apps/hub-api/test/auth-review.spec.ts:136 | chưa chạy |
| `AR:N-4` | REVIEW-AUTH-2026-10-11.md | L0 | apps/web/src/proxy.spec.ts:19<br>apps/web/src/proxy.spec.ts:27 | chưa chạy |
| `AR:R-2` | REVIEW-AUTH-2026-10-11.md | L0,L2 | apps/hub-api/test/auth-review.spec.ts:15<br>apps/hub-api/test/auth-review.spec.ts:22<br>verify/scenarios/auth-e2e.ts:527 | chưa chạy |
| `AR:R-3` | REVIEW-AUTH-2026-10-11.md | L0,L2 | apps/hub-api/test/auth-review.spec.ts:48<br>apps/hub-api/test/auth-review.spec.ts:81<br>apps/hub-api/test/auth-review.spec.ts:89<br>verify/scenarios/auth-e2e.ts:419 | chưa chạy |
| `AR:R-4` | REVIEW-AUTH-2026-10-11.md | L0 | libs/database/test/repo-batch.spec.ts:29 | chưa chạy |
| `AR:R-5` | REVIEW-AUTH-2026-10-11.md | L2 | verify/scenarios/auth-e2e.ts:517 | chưa chạy |
| `AR:R-6` | REVIEW-AUTH-2026-10-11.md | L1,L2 | apps/hub-api/test/auth-mail-db.spec.ts:112<br>verify/scenarios/auth-e2e.ts:151 | chưa chạy |
| `AR:R-7` | REVIEW-AUTH-2026-10-11.md | L0 | verify/test/gates.spec.ts:160 | chưa chạy |
| `AR:R-8` | REVIEW-AUTH-2026-10-11.md | L0 | apps/hub-api/test/api-key.guard.spec.ts:111<br>apps/hub-api/test/auth-scope.spec.ts:125 | chưa chạy |
| `AR:R-10` | REVIEW-AUTH-2026-10-11.md | L0 | apps/hub-api/test/auth-review.spec.ts:114 | chưa chạy |
| `AR:R-12` | REVIEW-AUTH-2026-10-11.md | L1 | apps/hub-api/test/github-oauth-db.spec.ts:163<br>apps/hub-api/test/github-oauth-db.spec.ts:172 | chưa chạy |
| `AR:R-13` | REVIEW-AUTH-2026-10-11.md | L0,L1 | apps/hub-api/test/auth-review.spec.ts:127<br>apps/hub-api/test/members-db.spec.ts:127<br>apps/hub-api/test/realtime-project.spec.ts:89 | chưa chạy |
| `AR:R-14` | REVIEW-AUTH-2026-10-11.md | L1 | apps/hub-api/test/console-projects-db.spec.ts:89 | chưa chạy |
| `AU:GM1` | spec-sources.json | L0 | libs/common/test/mail-gmail.spec.ts:31 | chưa chạy |
| `AU:GM2` | spec-sources.json | L0 | libs/common/test/mail-gmail.spec.ts:50<br>libs/common/test/mail-gmail.spec.ts:117 | chưa chạy |
| `AU:GM3` | spec-sources.json | L0 | libs/common/test/mail-gmail.spec.ts:60 | chưa chạy |
| `AU:GM4` | spec-sources.json | L0 | libs/common/test/mail-gmail.spec.ts:74<br>libs/common/test/mail-gmail.spec.ts:127 | chưa chạy |
| `AU:GM5` | spec-sources.json | L0 | libs/common/test/mail-gmail.spec.ts:103<br>libs/common/test/mail-gmail.spec.ts:141 | chưa chạy |
| `AU:GM6` | spec-sources.json | L0 | libs/common/test/mail-gmail.spec.ts:156 | chưa chạy |
| `AU:GO1` | spec-sources.json | L0 | apps/hub-api/test/google-oauth.spec.ts:51 | chưa chạy |
| `AU:GO2` | spec-sources.json | L0 | apps/hub-api/test/google-oauth.spec.ts:69 | chưa chạy |
| `AU:GO3` | spec-sources.json | L0 | apps/hub-api/test/google-oauth.spec.ts:120 | chưa chạy |
| `AU:GO4` | spec-sources.json | L0 | apps/hub-api/test/google-oauth.spec.ts:144 | chưa chạy |
| `AU:GO5` | spec-sources.json | L1 | apps/hub-api/test/google-oauth-db.spec.ts:79 | chưa chạy |
| `AU:GO6` | spec-sources.json | L1 | apps/hub-api/test/google-oauth-db.spec.ts:106 | chưa chạy |
| `AU:GO7` | spec-sources.json | L1 | apps/hub-api/test/google-oauth-db.spec.ts:126 | chưa chạy |
| `AU:GO8` | spec-sources.json | L1,L0 | apps/hub-api/test/google-oauth-db.spec.ts:143<br>apps/hub-api/test/google-oauth.spec.ts:175 | chưa chạy |
| `AU:GO9` | spec-sources.json | L2 | verify/scenarios/auth-e2e.ts:469 | chưa chạy |
| `AU:HA1` | spec-sources.json | L0 | apps/hub-api/test/hub-all-supervisor.spec.ts:110 | chưa chạy |
| `AU:HA2` | spec-sources.json | L0 | apps/hub-api/test/hub-all-supervisor.spec.ts:122 | chưa chạy |
| `AU:HA3` | spec-sources.json | L0 | apps/hub-api/test/hub-all-supervisor.spec.ts:135 | chưa chạy |
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
| `AU:TA12` | SPEC-auth.md · AU6 | L1 | libs/database/test/rls-db.spec.ts:42 | chưa chạy |
| `AU:TA13` | SPEC-auth.md · AU6 | L2 | verify/scenarios/auth-e2e.ts:406 | chưa chạy |
| `AU:TA14` | SPEC-auth.md · AU3 | — | — | mồ côi có lý do: Trình duyệt thật (Chrome + Firefox ở http://localhost:3000): F5 vẫn đăng nhập, document.cookie không thấy __Host-hub_at/rt — phiên TEST làm tay (SPEC-auth §10.2); phía server đã có TA1/TA5/TA6 tự động |
| `AU:TA15` | SPEC-auth.md · AU3 | L2 | verify/scenarios/auth-e2e.ts:367 | chưa chạy |
| `AU:UA1` | SPEC-auth.md · AU1 | L0 | apps/hub-api/test/auth-unit.spec.ts:40 | chưa chạy |
| `AU:UA2` | SPEC-auth.md · AU1 | L0 | apps/hub-api/test/auth-unit.spec.ts:163 | chưa chạy |
| `AU:UA3` | SPEC-auth.md · AU1 | L0 | apps/hub-api/test/auth-unit.spec.ts:168 | chưa chạy |
| `AU:UA4` | SPEC-auth.md · AU1 | L0 | apps/hub-api/test/auth-unit.spec.ts:192 | chưa chạy |
| `AU:UA5` | SPEC-auth.md · AU2 | L1 | apps/hub-api/test/auth-mail-db.spec.ts:93 | chưa chạy |
| `AU:UA6` | SPEC-auth.md · AU1 | L0 | apps/hub-api/test/auth-unit.spec.ts:118 | chưa chạy |
| `AU:UA7` | SPEC-auth.md · AU1 | L1 | apps/hub-api/test/auth-session-db.spec.ts:68 | chưa chạy |
| `AU:UA8` | SPEC-auth.md · AU1 | L1 | apps/hub-api/test/auth-session-db.spec.ts:82 | chưa chạy |
| `AU:UA9` | SPEC-auth.md · AU1 | L1 | apps/hub-api/test/auth-session-db.spec.ts:95 | chưa chạy |
| `AU:UA10` | SPEC-auth.md · AU1 | L1 | apps/hub-api/test/auth-session-db.spec.ts:105 | chưa chạy |
| `AU:UA11` | SPEC-auth.md · AU1 | L0 | apps/hub-api/test/auth-unit.spec.ts:132 | chưa chạy |
| `AU:UA12` | SPEC-auth.md · AU1 | L0 | apps/hub-api/test/auth-unit.spec.ts:70<br>apps/hub-api/test/auth-unit.spec.ts:175 | chưa chạy |
| `AU:UA13` | SPEC-auth.md · AU1 | L0 | apps/hub-api/test/auth-unit.spec.ts:86 | chưa chạy |
| `AU:UA14` | SPEC-auth.md · AU2 | L1 | apps/hub-api/test/auth-mail-db.spec.ts:187 | chưa chạy |
| `AU:UA15` | SPEC-auth.md · AU2 | L1 | apps/hub-api/test/auth-mail-db.spec.ts:209 | chưa chạy |
| `AU:UA16` | SPEC-auth.md · AU3 | L0 | apps/hub-api/test/auth-scope.spec.ts:51 | chưa chạy |
| `AU:UA17` | SPEC-auth.md · AU3 | L0 | apps/hub-api/test/auth-scope.spec.ts:60 | chưa chạy |
| `AU:UA18` | SPEC-auth.md · AU4 | L1 | apps/hub-api/test/members-db.spec.ts:101 | chưa chạy |
| `AU:UA19` | SPEC-auth.md · AU4 | L1 | apps/hub-api/test/members-db.spec.ts:143 | chưa chạy |
| `AU:UA20` | SPEC-auth.md · AU3 | L0 | apps/hub-api/test/auth-scope.spec.ts:89 | chưa chạy |
| `AU:UA21` | SPEC-auth.md · AU3 | L0 | apps/hub-api/test/auth-scope.spec.ts:77 | chưa chạy |
| `AU:UA22` | SPEC-auth.md · AU1 | L0 | libs/common/test/auth-common.spec.ts:73 | chưa chạy |
| `AU:UA23` | SPEC-auth.md · AU5 | L1 | apps/hub-api/test/github-oauth-db.spec.ts:92 | chưa chạy |
| `AU:UA24` | SPEC-auth.md · AU5 | L1 | apps/hub-api/test/github-oauth-db.spec.ts:142 | chưa chạy |
| `AU:UA25` | SPEC-auth.md · AU5 | L1 | apps/hub-api/test/github-oauth-db.spec.ts:151 | chưa chạy |
| `AU:UA26` | SPEC-auth.md · AU4 | L1 | apps/hub-api/test/members-db.spec.ts:71 | chưa chạy |
| `AU:UA27` | SPEC-auth.md · AU4 | L1 | apps/hub-api/test/members-db.spec.ts:81 | chưa chạy |
| `AU:UA28` | SPEC-auth.md · AU3 | L1 | apps/hub-api/test/console-projects-db.spec.ts:101 | chưa chạy |
| `AU:UA29` | SPEC-auth.md · AU3 | L0 | apps/hub-api/test/realtime-project.spec.ts:62 | chưa chạy |
| `AU:UA30` | SPEC-auth.md · AU6 | L0 | libs/database/test/rls-guard.spec.ts:20 | chưa chạy |
| `AU:UA31` | SPEC-auth.md · AU6 | L0 | libs/database/test/rls-guard.spec.ts:36 | chưa chạy |
| `BB:1` | spec-sources.json | L0 | verify/test/bb-invariants.spec.ts:20 | chưa chạy |
| `BB:2` | spec-sources.json | L0,L2 | apps/hub-api/test/ingest-invariants.spec.ts:80<br>verify/scenarios/chaos-l3.ts:97<br>verify/scenarios/chaos-l3.ts:113<br>verify/scenarios/ingest-e2e.ts:105 | chưa chạy |
| `BB:3` | spec-sources.json | L0,L2 | apps/hub-api/test/ingest-invariants.spec.ts:63<br>apps/hub-api/test/ingest-invariants.spec.ts:72<br>apps/hub-worker/test/delivery-consumer.spec.ts:129<br>verify/scenarios/chaos-l3.ts:44 | chưa chạy |
| `BB:4` | spec-sources.json | L0 | verify/test/bb-invariants.spec.ts:25 | chưa chạy |
| `BB:5` | spec-sources.json | L1 | libs/database/test/alerts-db.spec.ts:92<br>libs/database/test/project-schema-db.spec.ts:41<br>libs/database/test/rls-db.spec.ts:42<br>libs/database/test/rls-db.spec.ts:72 | chưa chạy |
| `BP:T1` | SPEC-ap-luc-nguoc.md · BP1 | L0 | apps/hub-worker/test/delivery-infra-errors.spec.ts:92<br>apps/hub-worker/test/delivery-infra-errors.spec.ts:125<br>apps/hub-worker/test/delivery-infra-errors.spec.ts:297 | chưa chạy |
| `BP:T2` | SPEC-ap-luc-nguoc.md · BP1 | L0 | apps/hub-worker/test/delivery-infra-errors.spec.ts:159<br>apps/hub-worker/test/delivery-infra-errors.spec.ts:206 | chưa chạy |
| `BP:T3` | SPEC-ap-luc-nguoc.md · BP1 | L0 | apps/hub-worker/test/delivery-infra-errors.spec.ts:221 | chưa chạy |
| `BP:T4` | SPEC-ap-luc-nguoc.md · BP5 | L0,L2 | apps/hub-worker/test/backpressure.spec.ts:432<br>verify/scenarios/chaos-bp.ts:144 | chưa chạy |
| `BP:T5` | SPEC-ap-luc-nguoc.md · BP2 | L0,L1 | apps/hub-api/test/replay-bulk.spec.ts:84<br>apps/hub-api/test/replay-message.spec.ts:11<br>apps/hub-worker/test/cleanup-suggested.spec.ts:108<br>apps/hub-worker/test/delivery-hints.spec.ts:19<br>apps/hub-worker/test/delivery-hints.spec.ts:27<br>apps/hub-worker/test/delivery-lease-sweeper.spec.ts:126<br>apps/hub-worker/test/normalize-consumer.spec.ts:128 | chưa chạy |
| `BP:T6` | SPEC-ap-luc-nguoc.md · BP2 | L0,L1 | apps/hub-api/test/redis-budget.spec.ts:320<br>apps/hub-worker/test/delivery-gate.spec.ts:60<br>apps/hub-worker/test/delivery-gate.spec.ts:74<br>apps/hub-worker/test/delivery-gate.spec.ts:278 | chưa chạy |
| `BP:T7` | SPEC-ap-luc-nguoc.md · BP2 | L0 | apps/hub-worker/test/delivery-defer.spec.ts:41<br>apps/hub-worker/test/delivery-defer.spec.ts:65 | chưa chạy |
| `BP:T8` | SPEC-ap-luc-nguoc.md · BP2 | L1 | apps/hub-worker/test/delivery-lease-sweeper.spec.ts:218 | chưa chạy |
| `BP:T9` | SPEC-ap-luc-nguoc.md · BP2 | L0 | apps/hub-worker/test/delivery-consumer.spec.ts:501<br>apps/hub-worker/test/delivery-consumer.spec.ts:544 | chưa chạy |
| `BP:T10` | SPEC-ap-luc-nguoc.md · BP2 | L0,L1 | apps/hub-worker/test/delivery-defer.spec.ts:77<br>apps/hub-worker/test/delivery-gate.spec.ts:206 | chưa chạy |
| `BP:T11` | SPEC-ap-luc-nguoc.md · BP2 | L1 | apps/hub-worker/test/delivery-gate.spec.ts:93<br>apps/hub-worker/test/delivery-gate.spec.ts:103<br>apps/hub-worker/test/delivery-gate.spec.ts:113<br>apps/hub-worker/test/delivery-gate.spec.ts:135 | chưa chạy |
| `BP:T12` | SPEC-ap-luc-nguoc.md · BP3 | L1 | apps/hub-worker/test/circuit-breaker.spec.ts:302<br>apps/hub-worker/test/circuit-breaker.spec.ts:328<br>apps/hub-worker/test/circuit-breaker.spec.ts:705 | chưa chạy |
| `BP:T13` | SPEC-ap-luc-nguoc.md · BP3 | L0,L1 | apps/hub-worker/test/alert-evaluator.spec.ts:323<br>apps/hub-worker/test/delivery-gate.spec.ts:156<br>apps/hub-worker/test/delivery-gate.spec.ts:169<br>apps/hub-worker/test/delivery-gate.spec.ts:259 | chưa chạy |
| `BP:T14` | SPEC-ap-luc-nguoc.md · BP4 | L1 | apps/hub-worker/test/circuit-breaker.spec.ts:280<br>apps/hub-worker/test/circuit-breaker.spec.ts:352 | chưa chạy |
| `BP:T15` | SPEC-ap-luc-nguoc.md · BP4 | L1 | apps/hub-worker/test/circuit-breaker.spec.ts:378<br>apps/hub-worker/test/circuit-breaker.spec.ts:403<br>apps/hub-worker/test/circuit-breaker.spec.ts:444<br>apps/hub-worker/test/circuit-breaker.spec.ts:740<br>apps/hub-worker/test/delivery-gate.spec.ts:186 | chưa chạy |
| `BP:T16` | SPEC-ap-luc-nguoc.md · BP4 | L1,L2 | apps/hub-worker/test/circuit-breaker.spec.ts:771<br>apps/hub-worker/test/circuit-breaker.spec.ts:869<br>verify/scenarios/chaos-bp.ts:343 | chưa chạy |
| `BP:T17` | SPEC-ap-luc-nguoc.md · BP5 | L0 | apps/hub-worker/test/backpressure.spec.ts:39<br>apps/hub-worker/test/backpressure.spec.ts:68 | chưa chạy |
| `BP:T18` | SPEC-ap-luc-nguoc.md · BP5 | L0 | apps/hub-worker/test/backpressure.spec.ts:97 | chưa chạy |
| `BP:T19` | SPEC-ap-luc-nguoc.md · BP5 | L0 | apps/hub-worker/test/backpressure.spec.ts:130 | chưa chạy |
| `BP:T20` | SPEC-ap-luc-nguoc.md · BP5 | L0 | apps/hub-worker/test/backpressure.spec.ts:160 | chưa chạy |
| `BP:T21` | SPEC-ap-luc-nguoc.md · BP5 | L0,L2 | apps/hub-worker/test/backpressure.spec.ts:510<br>verify/scenarios/chaos-bp.ts:252 | chưa chạy |
| `BP:T22` | SPEC-ap-luc-nguoc.md | L0 | apps/hub-api/test/redis-budget.spec.ts:337<br>apps/hub-api/test/redis-budget.spec.ts:352<br>apps/hub-api/test/redis-budget.spec.ts:363<br>apps/hub-api/test/redis-budget.spec.ts:374<br>apps/hub-api/test/redis-budget.spec.ts:385<br>apps/hub-api/test/redis-budget.spec.ts:419 | chưa chạy |
| `BP:T23` | SPEC-ap-luc-nguoc.md · BP6 | L0 | verify/test/bp-docs-sync.spec.ts:14 | chưa chạy |
| `BP:T24` | spec-sources.json | L0 | apps/hub-worker/test/backpressure.spec.ts:203<br>apps/hub-worker/test/backpressure.spec.ts:295 | chưa chạy |
| `CB:T1` | SPEC-canh-bao-nhan-dinh.md · CB1 | L0 | libs/common/test/alert-rules.spec.ts:65<br>libs/common/test/alert-rules.spec.ts:105<br>libs/common/test/alert-rules.spec.ts:113<br>libs/common/test/alert-rules.spec.ts:150<br>libs/common/test/alert-rules.spec.ts:159<br>libs/common/test/alert-rules.spec.ts:173<br>libs/common/test/alert-rules.spec.ts:185<br>libs/common/test/alert-rules.spec.ts:208<br>libs/common/test/alert-rules.spec.ts:230<br>libs/common/test/alert-rules.spec.ts:237 | chưa chạy |
| `CB:T2` | SPEC-canh-bao-nhan-dinh.md · CB1 | L1 | apps/hub-worker/test/alert-evaluator-db.spec.ts:117<br>libs/database/test/alerts-db.spec.ts:42 | chưa chạy |
| `CB:T3` | SPEC-canh-bao-nhan-dinh.md · CB2 | L0 | apps/hub-worker/test/alert-evaluator.spec.ts:174 | chưa chạy |
| `CB:T4` | SPEC-canh-bao-nhan-dinh.md · CB2 | L1 | apps/hub-worker/test/alert-evaluator-db.spec.ts:76 | chưa chạy |
| `CB:T5` | SPEC-canh-bao-nhan-dinh.md · CB2 | L1 | apps/hub-worker/test/alert-evaluator-db.spec.ts:179 | chưa chạy |
| `CB:T6` | SPEC-canh-bao-nhan-dinh.md · CB2 | L0 | apps/hub-worker/test/alert-evaluator.spec.ts:195 | chưa chạy |
| `CB:T7` | SPEC-canh-bao-nhan-dinh.md · CB2 | L1,L0 | apps/hub-worker/test/alert-evaluator-db.spec.ts:76<br>apps/hub-worker/test/alert-evaluator.spec.ts:223 | chưa chạy |
| `CB:T8` | SPEC-canh-bao-nhan-dinh.md · CB5 | L1,L0 | apps/hub-worker/test/alert-email-sender-db.spec.ts:118<br>apps/hub-worker/test/alert-email-sender-db.spec.ts:167<br>verify/test/gates.spec.ts:87 | chưa chạy |
| `CB:T9` | SPEC-canh-bao-nhan-dinh.md · CB5 | L1,L0 | apps/hub-worker/test/alert-email-sender-db.spec.ts:207<br>libs/common/test/alert-email.spec.ts:62 | chưa chạy |
| `CB:T10` | SPEC-canh-bao-nhan-dinh.md · CB3 | L1,L0 | apps/hub-api/test/alerts-api-db.spec.ts:99<br>apps/hub-api/test/alerts-api.spec.ts:44<br>apps/hub-api/test/alerts-api.spec.ts:267 | chưa chạy |
| `CB:T11` | SPEC-canh-bao-nhan-dinh.md | L0 | apps/hub-worker/test/alert-evaluator.spec.ts:137 | chưa chạy |
| `CB:T12` | SPEC-canh-bao-nhan-dinh.md · CB3 | L1 | apps/hub-api/test/alerts-api-db.spec.ts:49 | chưa chạy |
| `CB:T13` | SPEC-canh-bao-nhan-dinh.md · CB5 | L1 | apps/hub-worker/test/alert-email-sender-db.spec.ts:302 | chưa chạy |
| `CB:T14` | SPEC-canh-bao-nhan-dinh.md · CB7 | L0 | apps/hub-api/test/destination-view.spec.ts:47 | chưa chạy |
| `CB:T15` | SPEC-canh-bao-nhan-dinh.md · CB4 | L0 | apps/web/src/lib/alerts/notify-logic.spec.ts:106 | chưa chạy |
| `CB:T16` | SPEC-canh-bao-nhan-dinh.md · CB6 | L0 | libs/common/test/insights.spec.ts:25 | chưa chạy |
| `CB:T17` | DINH-CHINH-2026-10-12.md · CB2 | L1 | apps/hub-worker/test/alert-evaluator-db.spec.ts:135 | chưa chạy |
| `DX:TX1` | SPEC-dev-experience.md | — | — | mồ côi có lý do: E2E làm tay bằng curl trên stack dev (SPEC-dev-experience §6.2, PASS 2026-10-11 ở §9). Logic phủ tự động ở L0 [DX:UX1]-[DX:UX5] (error-filter.spec, error-catalog.spec) + [DX:UX11] after=abc/after=latest. |
| `DX:TX2` | SPEC-dev-experience.md | — | — | mồ côi có lý do: Đo bằng đồng hồ với người test chưa đọc code (thời gian từ connection string tới event đầu tiên) — bản chất là phép đo thủ công, không tự động hoá được; chưa có kết quả ở §9. |
| `DX:TX3` | SPEC-dev-experience.md | — | — | mồ côi có lý do: E2E làm tay: hub listen + examples/quickstart-node + SePay mock trên stack dev (PASS 2026-10-11 ở §9). Phần lõi phủ tự động ở L0 [DX:UX9], [DX:UX10], [DX:UX12]-[DX:UX14] (webhook-body.spec, listen.spec). |
| `DX:TX4` | SPEC-dev-experience.md | — | — | mồ côi có lý do: E2E làm tay: đếm hub.deliveries trước/sau TX3 trên stack dev (PASS 2026-10-11 ở §9). listen chỉ đọc vì đi qua polling A (GET), không tạo delivery. |
| `DX:TX5` | SPEC-dev-experience.md | — | — | mồ côi có lý do: E2E làm tay: npx hub trigger + listen trên stack (SPEC-dev-experience §6.2), chưa ghi kết quả ở §9. Phần lõi phủ tự động ở L0 [DX:UX16] (libs/hub-sdk/test/trigger.spec.ts: body qua validateCanonical). |
| `DX:UX1` | SPEC-dev-experience.md | L0 | apps/hub-api/test/error-filter.spec.ts:101<br>apps/hub-api/test/error-filter.spec.ts:117 | chưa chạy |
| `DX:UX2` | SPEC-dev-experience.md | L0 | apps/hub-api/test/error-filter.spec.ts:131 | chưa chạy |
| `DX:UX3` | SPEC-dev-experience.md | L0 | apps/hub-api/test/error-filter.spec.ts:142 | chưa chạy |
| `DX:UX4` | SPEC-dev-experience.md | L0 | libs/common/test/error-catalog.spec.ts:20<br>libs/common/test/error-catalog.spec.ts:31<br>libs/common/test/error-catalog.spec.ts:57 | chưa chạy |
| `DX:UX5` | SPEC-dev-experience.md | L0 | apps/hub-api/test/error-filter.spec.ts:159 | chưa chạy |
| `DX:UX6` | SPEC-dev-experience.md | L0 | apps/hub-api/test/ingest-reject-ack.spec.ts:11<br>apps/hub-api/test/service-resources.spec.ts:349<br>libs/common/test/error-catalog.spec.ts:71<br>libs/providers/test/generic.adapter.spec.ts:173 | chưa chạy |
| `DX:UX7` | SPEC-dev-experience.md | — | — | mồ côi có lý do: Không có code để test: DX2 cắt theo phương án A (SPEC-dev-experience §8 mục 1) — không có buildQuickstart trong libs/hub-sdk; chỉ examples/quickstart-node + docs/QUICKSTART.md. Làm phương án B thì viết libs/hub-sdk/test/quickstart.spec.ts. |
| `DX:UX8` | SPEC-dev-experience.md | — | — | mồ côi có lý do: Không có code để test: route GET …/keys/:id/quickstart thuộc phần DX2 bị cắt (phương án A, SPEC-dev-experience §8 mục 1) — route không tồn tại. Làm phương án B thì viết apps/hub-api/test/quickstart.spec.ts. |
| `DX:UX9` | SPEC-dev-experience.md | L0 | libs/common/test/webhook-body.spec.ts:16 | chưa chạy |
| `DX:UX10` | SPEC-dev-experience.md | L0 | libs/hub-sdk/test/listen.spec.ts:113 | chưa chạy |
| `DX:UX11` | SPEC-dev-experience.md | L1,L0 | apps/hub-api/test/polling-db.spec.ts:61<br>apps/hub-api/test/polling-db.spec.ts:72<br>apps/hub-api/test/polling-db.spec.ts:85<br>apps/hub-api/test/polling-params.spec.ts:43<br>apps/hub-api/test/polling-params.spec.ts:54<br>libs/database/test/orchestrated-methods.spec.ts:69 | chưa chạy |
| `DX:UX12` | SPEC-dev-experience.md | L0 | libs/hub-sdk/test/listen.spec.ts:141 | chưa chạy |
| `DX:UX13` | SPEC-dev-experience.md | L0 | libs/hub-sdk/test/listen.spec.ts:161 | chưa chạy |
| `DX:UX14` | SPEC-dev-experience.md | L0 | libs/hub-sdk/test/listen.spec.ts:174 | chưa chạy |
| `DX:UX15` | SPEC-dev-experience.md | L0 | libs/hub-sdk/test/listen.spec.ts:191 | chưa chạy |
| `DX:UX16` | SPEC-dev-experience.md | L0 | libs/hub-sdk/test/trigger.spec.ts:45 | chưa chạy |
| `EG:T1` | SPEC-chong-qua-tai.md · EG2 | L0 | apps/hub-api/test/penalty-box.spec.ts:54<br>apps/hub-api/test/penalty-gate.spec.ts:268 | chưa chạy |
| `EG:T2` | SPEC-chong-qua-tai.md · EG1 | L2 | verify/scenarios/edge-e2e.ts:62 | chưa chạy |
| `EG:T3` | SPEC-chong-qua-tai.md · EG1 | L0 | apps/hub-api/test/edge-nginx.spec.ts:73<br>apps/hub-api/test/edge-nginx.spec.ts:99<br>apps/hub-api/test/edge-nginx.spec.ts:117<br>apps/hub-api/test/source-connections.spec.ts:31 | chưa chạy |
| `EG:T4` | SPEC-chong-qua-tai.md · EG2 | L0 | apps/hub-api/test/penalty-box.spec.ts:74 | chưa chạy |
| `EG:T5` | SPEC-chong-qua-tai.md · EG2 | L0 | apps/hub-api/test/penalty-box.spec.ts:86 | chưa chạy |
| `EG:T6` | SPEC-chong-qua-tai.md · EG2 | L0 | apps/hub-api/test/penalty-box.spec.ts:101 | chưa chạy |
| `EG:T7` | SPEC-chong-qua-tai.md · EG2 | L0 | apps/hub-api/test/penalty-box.spec.ts:123 | chưa chạy |
| `EG:T8` | SPEC-chong-qua-tai.md · EG3 | L0 | apps/hub-api/test/redis-budget.spec.ts:474 | chưa chạy |
| `EG:T9` | SPEC-chong-qua-tai.md · EG1 | L0 | apps/hub-api/test/edge-nginx.spec.ts:327<br>apps/hub-api/test/edge-nginx.spec.ts:434<br>apps/hub-api/test/edge-nginx.spec.ts:447 | chưa chạy |
| `EG:T10` | SPEC-chong-qua-tai.md · EG1 | L0,L2 | apps/hub-api/test/body-limit.spec.ts:126<br>apps/hub-api/test/edge-nginx.spec.ts:65<br>apps/hub-api/test/edge-nginx.spec.ts:127<br>apps/hub-api/test/edge-nginx.spec.ts:186<br>apps/hub-api/test/edge-nginx.spec.ts:217<br>apps/hub-api/test/edge-nginx.spec.ts:531<br>verify/scenarios/edge-e2e.ts:151 | chưa chạy |
| `EG:T11` | SPEC-chong-qua-tai.md · EG1 | L0,L2 | apps/hub-api/test/edge-nginx.spec.ts:256<br>apps/hub-api/test/edge-nginx.spec.ts:287<br>apps/hub-api/test/edge-nginx.spec.ts:508<br>apps/hub-api/test/edge-nginx.spec.ts:564<br>verify/scenarios/edge-e2e.ts:89 | chưa chạy |
| `EG:T12` | SPEC-chong-qua-tai.md · EG3 | L1 | apps/hub-api/test/ingest-ratelimit-after-verify-db.spec.ts:43 | chưa chạy |
| `EG:T13` | SPEC-chong-qua-tai.md · EG4 | L1 | apps/hub-api/test/source-traffic-db.spec.ts:31 | chưa chạy |
| `EG:T14` | SPEC-chong-qua-tai.md · EG5 | L1 | apps/hub-api/test/source-traffic-api-db.spec.ts:47 | chưa chạy |
| `EG:T15` | SPEC-chong-qua-tai.md · EG5 | L0 | libs/common/test/traffic-insight.spec.ts:8 | chưa chạy |
| `EG:T16` | SPEC-chong-qua-tai.md · EG1 | L0 | apps/hub-api/test/edge-nginx.spec.ts:309 | chưa chạy |
| `EG:T17` | SPEC-chong-qua-tai.md · EG2 | L0 | apps/hub-api/test/penalty-box.spec.ts:159 | chưa chạy |
| `EG:T18` | SPEC-chong-qua-tai.md · EG2 | L0 | apps/hub-api/test/penalty-box.spec.ts:182 | chưa chạy |
| `EG:T19` | SPEC-chong-qua-tai.md · EG2 | L0 | apps/hub-api/test/penalty-gate.spec.ts:113<br>apps/hub-api/test/penalty-gate.spec.ts:247<br>apps/hub-api/test/penalty-gate.spec.ts:260 | chưa chạy |
| `KN:T1` | SPEC-ket-noi.md · KN1 | — | — | mồ côi có lý do: L2 trên hubv chưa chạy: image hub-api của hubv chưa rebuild với code KN (phiên dev không được restart/rebuild hubv — VF đang chạy chaos). Logic phủ ở L1 [KN:U1]-[KN:U4] (console-endpoints-db.spec.ts). |
| `KN:T2` | SPEC-ket-noi.md · KN3 | — | — | mồ côi có lý do: L2 trên hubv chưa chạy (cần rebuild image + PAYOS_FAKE_BASE_URL/CONNECTOR_INGEST_BASE_URL trong .env.verify). Luồng tương đương chạy ở L1 với fake PayOS của sink trong tiến trình: payos-connect-db.spec.ts [KN:U8] (phần b). |
| `KN:T3` | SPEC-ket-noi.md · KN4 | — | — | mồ côi có lý do: L2 trên hubv chưa chạy (cần rebuild image + STRIPE_FAKE_BASE_URL trong .env.verify). Tương đương ở L1 với fake Stripe của sink trong tiến trình: stripe-connect-db.spec.ts [KN:U14][KN:U15] + [KN4] status/ngắt (DELETE tới đúng we_). |
| `KN:T4` | SPEC-ket-noi.md · KN2 | — | — | mồ côi có lý do: L2 trên hubv chưa chạy: image hub-api của hubv chưa rebuild với code KN (phiên dev không được restart/rebuild hubv). Cô lập project phủ ở L1 [KN2] project khác → 404 giống hệt + RLS (source-connections-db.spec.ts). |
| `KN:U1` | SPEC-ket-noi.md · KN1 | L1 | apps/hub-api/test/console-endpoints-db.spec.ts:58 | chưa chạy |
| `KN:U2` | SPEC-ket-noi.md · KN1 | L1 | apps/hub-api/test/console-endpoints-db.spec.ts:80 | chưa chạy |
| `KN:U3` | SPEC-ket-noi.md · KN1 | L1 | apps/hub-api/test/console-endpoints-db.spec.ts:89 | chưa chạy |
| `KN:U4` | SPEC-ket-noi.md · KN1 | L1 | apps/hub-api/test/console-endpoints-db.spec.ts:104 | chưa chạy |
| `KN:U5` | SPEC-ket-noi.md · KN1 | L0 | apps/hub-api/test/console-endpoints.spec.ts:9 | chưa chạy |
| `KN:U6` | SPEC-ket-noi.md · KN2 | L0 | apps/hub-api/test/source-connections.spec.ts:22 | chưa chạy |
| `KN:U7` | SPEC-ket-noi.md · KN2 | L0 | apps/hub-api/test/source-connections.spec.ts:41 | chưa chạy |
| `KN:U8` | SPEC-ket-noi.md · KN2 | L1 | apps/hub-api/test/payos-connect-db.spec.ts:63<br>apps/hub-api/test/source-connections-db.spec.ts:74 | chưa chạy |
| `KN:U9` | SPEC-ket-noi.md · KN2 | L1 | apps/hub-api/test/source-connections-db.spec.ts:86 | chưa chạy |
| `KN:U10` | SPEC-ket-noi.md · KN2 | L1 | apps/hub-api/test/source-connections-db.spec.ts:99 | chưa chạy |
| `KN:U11` | SPEC-ket-noi.md · KN2 | L1 | apps/hub-api/test/source-connections-db.spec.ts:127 | chưa chạy |
| `KN:U12` | SPEC-ket-noi.md · KN2 | L0 | apps/hub-api/test/payos-connector.spec.ts:25<br>apps/hub-api/test/source-connections.spec.ts:52 | chưa chạy |
| `KN:U13` | SPEC-ket-noi.md · KN3 | L0 | apps/hub-api/test/payos-connector.spec.ts:12 | chưa chạy |
| `KN:U14` | SPEC-ket-noi.md · KN4 | L1 | apps/hub-api/test/stripe-connect-db.spec.ts:60 | chưa chạy |
| `KN:U15` | SPEC-ket-noi.md · KN4 | L1 | apps/hub-api/test/stripe-connect-db.spec.ts:81 | chưa chạy |
| `KN:U16` | SPEC-ket-noi.md · KN3 | L0,L1,L2 | apps/hub-api/test/flow-probe-trace.spec.ts:43<br>apps/hub-api/test/ingest-payos-probe.spec.ts:61<br>apps/hub-api/test/ingest-payos-probe.spec.ts:72<br>apps/hub-api/test/ingest-payos-probe.spec.ts:91<br>apps/hub-api/test/polling-db.spec.ts:172<br>apps/hub-worker/test/normalize-consumer.spec.ts:169<br>apps/hub-worker/test/normalize-consumer.spec.ts:189<br>libs/common/test/flow/build-event-flow.spec.ts:135<br>libs/common/test/flow/build-event-flow.spec.ts:146<br>libs/providers/test/payos-confirm-probe.spec.ts:42<br>libs/providers/test/payos-confirm-probe.spec.ts:61<br>libs/providers/test/payos-confirm-probe.spec.ts:71<br>libs/providers/test/payos-confirm-probe.spec.ts:76<br>tools/hub-sim/test/hub-sim.spec.ts:100<br>verify/scenarios/ingest-e2e.ts:188 | chưa chạy |
| `KN:U17` | SPEC-ket-noi.md · KN2 | L1 | apps/hub-api/test/source-connections-db.spec.ts:152 | chưa chạy |
| `KN:U18` | SPEC-ket-noi.md · KN2 | L0 | apps/hub-api/test/source-connections.spec.ts:63 | chưa chạy |
| `KN:U19` | SPEC-ket-noi.md · KN2 | L1 | apps/hub-api/test/payos-connect-db.spec.ts:110 | chưa chạy |
| `KN:U20` | SPEC-ket-noi.md · KN2 | L1 | apps/hub-api/test/payos-connect-db.spec.ts:130 | chưa chạy |
| `KN:U21` | SPEC-ket-noi.md · KN2 | L1 | apps/hub-api/test/payos-connect-db.spec.ts:180 | chưa chạy |
| `KN:U22` | SPEC-ket-noi.md · KN2 | L1 | apps/hub-api/test/payos-connect-db.spec.ts:194 | chưa chạy |
| `KN:U23` | SPEC-ket-noi.md · KN2 | L1 | apps/hub-api/test/payos-connect-db.spec.ts:206 | chưa chạy |
| `KN:U24` | SPEC-ket-noi.md · KN2 | L1 | apps/hub-api/test/stripe-connect-db.spec.ts:97 | chưa chạy |
| `KN:U25` | SPEC-ket-noi.md · KN2 | L1 | apps/hub-api/test/payos-connect-db.spec.ts:149 | chưa chạy |
| `KN:U26` | SPEC-ket-noi.md · KN2 | L1 | apps/hub-api/test/payos-connect-db.spec.ts:172 | chưa chạy |
| `KN:U27` | SPEC-ket-noi.md · KN2 | L1 | apps/hub-api/test/payos-connect-db.spec.ts:227 | chưa chạy |
| `KN:U28` | SPEC-ket-noi.md · KN2 | L1 | apps/hub-api/test/payos-connect-db.spec.ts:243 | chưa chạy |
| `KN:U29` | SPEC-ket-noi.md · KN2 | L1 | apps/hub-api/test/payos-connect-db.spec.ts:278 | chưa chạy |
| `LH:T11` | SPEC-hub-sap.md · LH3 | L0 | apps/hub-api/test/redis-budget.spec.ts:570 | chưa chạy |
| `LH:T12` | SPEC-hub-sap.md · LH3 | L0 | apps/hub-api/test/ingest-catchnet.spec.ts:192 | chưa chạy |
| `LH:T13` | SPEC-hub-sap.md · LH3 | L0 | apps/hub-api/test/ingest-catchnet.spec.ts:358 | chưa chạy |
| `LH:T17` | SPEC-hub-sap.md · LH-URL | L0 | apps/hub-api/test/ingest-public-url.spec.ts:72<br>apps/hub-api/test/ingest-public-url.spec.ts:90<br>apps/hub-api/test/ingest-public-url.spec.ts:113 | chưa chạy |
| `LH:T18` | SPEC-hub-sap.md · LH3 | L0 | apps/hub-api/test/ingest-catchnet.spec.ts:418 | chưa chạy |
| `LH:T19` | SPEC-hub-sap.md · LH3 | L0 | apps/hub-api/test/ingest-catchnet.spec.ts:429 | chưa chạy |
| `LH:T20` | SPEC-hub-sap.md · LH3 | L0 | apps/hub-api/test/ingest-catchnet.spec.ts:456 | chưa chạy |
| `LH:T21` | SPEC-hub-sap.md · LH3 | L0 | apps/hub-api/test/ingest-catchnet.spec.ts:502 | chưa chạy |
| `LH:T22` | SPEC-hub-sap.md · LH3 | L0 | apps/hub-api/test/edge-nginx.spec.ts:147 | chưa chạy |
| `MS:T2` | SPEC-hub-multi-service.md · S3 | L0 | apps/hub-api/test/service-resources.spec.ts:184 | chưa chạy |
| `MS:T4` | SPEC-hub-multi-service.md · S6 | L0 | apps/hub-api/test/endpoint-verifier.spec.ts:44<br>apps/hub-api/test/endpoint-verifier.spec.ts:53<br>apps/hub-api/test/service-resources.spec.ts:157<br>apps/hub-api/test/service-resources.spec.ts:174<br>libs/crypto/test/ssrf-metadata.spec.ts:11 | chưa chạy |
| `MS:T5` | SPEC-hub-multi-service.md · S5 | L0 | apps/hub-api/test/service-resources.spec.ts:124<br>apps/hub-api/test/service-resources.spec.ts:131<br>apps/hub-api/test/service-resources.spec.ts:149 | chưa chạy |
| `MS:T9` | SPEC-hub-multi-service.md · S8 | L0 | apps/hub-api/test/ingest-generic.spec.ts:36<br>apps/hub-api/test/ingest-generic.spec.ts:43<br>apps/hub-api/test/service-sources.spec.ts:50<br>apps/hub-api/test/service-sources.spec.ts:64<br>apps/hub-api/test/service-sources.spec.ts:143 | chưa chạy |
| `MS:T10` | SPEC-hub-multi-service.md · S10 | L0 | apps/hub-worker/test/delivery-timeout.spec.ts:29 | chưa chạy |
| `MS:T13` | SPEC-hub-multi-service.md · S7 | L0,L1 | apps/hub-worker/test/cleanup-job.spec.ts:94<br>libs/database/test/retention-db.spec.ts:52 | chưa chạy |
| `MS:T14` | SPEC-hub-multi-service.md · S12 | L1 | libs/database/test/seed-demo-db.spec.ts:16 | chưa chạy |
| `MS:U1` | SPEC-hub-multi-service.md · S6 | L0 | libs/crypto/test/standard-webhooks.spec.ts:16 | chưa chạy |
| `MS:U2` | SPEC-hub-multi-service.md · S6 | L0 | libs/crypto/test/standard-webhooks.spec.ts:20 | chưa chạy |
| `MS:U3` | SPEC-hub-multi-service.md · S6 | L0 | libs/crypto/test/standard-webhooks.spec.ts:25 | chưa chạy |
| `MS:U4` | SPEC-hub-multi-service.md · S6 | L0 | libs/crypto/test/standard-webhooks.spec.ts:61 | chưa chạy |
| `MS:U5` | SPEC-hub-multi-service.md · S6 | L0 | libs/crypto/test/standard-webhooks.spec.ts:67 | chưa chạy |
| `MS:U6` | SPEC-hub-multi-service.md · S6 | L0 | libs/crypto/test/standard-webhooks.spec.ts:12 | chưa chạy |
| `MS:U7` | SPEC-hub-multi-service.md · S8 | L0 | libs/providers/test/generic.adapter.spec.ts:32 | chưa chạy |
| `MS:U8` | SPEC-hub-multi-service.md · S8 | L0 | libs/providers/test/generic.adapter.spec.ts:36 | chưa chạy |
| `MS:U9` | SPEC-hub-multi-service.md · S8 | L0 | libs/providers/test/generic.adapter.spec.ts:42 | chưa chạy |
| `MS:U10` | SPEC-hub-multi-service.md · S8 | L0 | libs/providers/test/generic.adapter.spec.ts:49 | chưa chạy |
| `MS:U11` | SPEC-hub-multi-service.md · S8 | L0 | libs/providers/test/generic.adapter.spec.ts:56 | chưa chạy |
| `MS:U12` | SPEC-hub-multi-service.md · S8 | L0 | libs/providers/test/generic.adapter.spec.ts:88 | chưa chạy |
| `MS:U13` | SPEC-hub-multi-service.md · S8 | L0 | libs/providers/test/generic.adapter.spec.ts:96 | chưa chạy |
| `MS:U14` | SPEC-hub-multi-service.md · S8 | L0 | libs/providers/test/generic.adapter.spec.ts:125 | chưa chạy |
| `MS:U15` | SPEC-hub-multi-service.md · S9 | L0 | libs/providers/test/generic.adapter.spec.ts:186 | chưa chạy |
| `MS:U16` | SPEC-hub-multi-service.md · S4 | L0 | libs/providers/test/api.adapter.spec.ts:8 | chưa chạy |
| `MS:U17` | SPEC-hub-multi-service.md · S5 | L0 | libs/common/test/event-pattern.spec.ts:11 | chưa chạy |
| `MS:U18` | SPEC-hub-multi-service.md · S5 | L0,L1 | apps/hub-worker/test/normalize-consumer.spec.ts:138<br>libs/database/test/repository-scope.spec.ts:28<br>libs/database/test/subscription-match-db.spec.ts:95 | chưa chạy |
| `MS:U19` | SPEC-hub-multi-service.md · S5 | L0 | apps/hub-api/test/service-resources.spec.ts:138<br>libs/common/test/event-pattern.spec.ts:24 | chưa chạy |
| `MS:U20` | SPEC-hub-multi-service.md · S3 | L0 | apps/hub-api/test/api-key.guard.spec.ts:59 | chưa chạy |
| `MS:U21` | SPEC-hub-multi-service.md · S3 | L0 | apps/hub-api/test/api-key.guard.spec.ts:68 | chưa chạy |
| `MS:U22` | SPEC-hub-multi-service.md · S3 | L0 | apps/hub-api/test/api-key.guard.spec.ts:77 | chưa chạy |
| `MS:U23` | SPEC-hub-multi-service.md · S3 | L0 | apps/hub-api/test/api-key.guard.spec.ts:87 | chưa chạy |
| `MS:U24` | SPEC-hub-multi-service.md · S7 | L1 | apps/hub-api/test/polling-db.spec.ts:42 | chưa chạy |
| `MS:U25` | SPEC-hub-multi-service.md · S7 | L1,L0 | apps/hub-api/test/polling-db.spec.ts:48<br>apps/hub-api/test/polling-params.spec.ts:27 | chưa chạy |
| `MS:U26` | SPEC-hub-multi-service.md · S7 | L1 | apps/hub-api/test/polling-db.spec.ts:146 | chưa chạy |
| `MS:U27` | SPEC-hub-multi-service.md · S7 | L1 | apps/hub-api/test/polling-db.spec.ts:159 | chưa chạy |
| `MS:U28` | SPEC-hub-multi-service.md · S10 | L0 | apps/hub-worker/test/delivery-consumer.spec.ts:444 | chưa chạy |
| `MS:U29` | SPEC-hub-multi-service.md · S0 | L0 | apps/hub-worker/test/normalize-consumer.spec.ts:115 | chưa chạy |
| `MS:U30` | SPEC-hub-multi-service.md · S6 | L0 | apps/hub-worker/test/normalize-consumer.spec.ts:146 | chưa chạy |
| `MS:U31` | SPEC-hub-multi-service.md · S11 | L0 | libs/hub-sdk/test/sdk.spec.ts:23 | chưa chạy |
| `MS:U32` | SPEC-hub-multi-service.md · S11 | L0 | libs/hub-sdk/test/sdk.spec.ts:30 | chưa chạy |
| `MS:U33` | SPEC-hub-multi-service.md · S11 | L0 | libs/hub-sdk/test/sdk.spec.ts:48 | chưa chạy |
| `MS:U34` | SPEC-hub-multi-service.md · S14 | L0 | libs/providers/test/canonical-payos.spec.ts:9<br>libs/providers/test/canonical-payos.spec.ts:29 | chưa chạy |
| `MS:U35` | SPEC-hub-multi-service.md · S14 | L0 | libs/providers/test/canonical-payos.spec.ts:37 | chưa chạy |
| `MS:U36` | SPEC-hub-multi-service.md · S14 | L0 | libs/providers/test/canonical-sepay.spec.ts:10 | chưa chạy |
| `MS:U37` | SPEC-hub-multi-service.md · S14 | L0 | libs/providers/test/canonical-same-shape.spec.ts:9 | chưa chạy |
| `MS:U38` | SPEC-hub-multi-service.md · S14 | L0 | libs/providers/test/canonical-stripe.spec.ts:9 | chưa chạy |
| `MS:U39` | SPEC-hub-multi-service.md · S14 | L0 | libs/providers/test/canonical-stripe.spec.ts:40 | chưa chạy |
| `MS:U40` | SPEC-hub-multi-service.md · S14 | L0 | libs/providers/test/canonical-github.spec.ts:11<br>libs/providers/test/canonical-github.spec.ts:28 | chưa chạy |
| `MS:U41` | SPEC-hub-multi-service.md · S14 | L0 | libs/providers/test/canonical-github.spec.ts:35 | chưa chạy |
| `MS:U42` | SPEC-hub-multi-service.md · S14 | L0 | libs/providers/test/canonical-github.spec.ts:58 | chưa chạy |
| `MS:U43` | SPEC-hub-multi-service.md · S14 | L0 | libs/common/test/canonical-time.spec.ts:4 | chưa chạy |
| `MS:U44` | SPEC-hub-multi-service.md · S14 | L0 | libs/common/test/canonical-validate.spec.ts:17 | chưa chạy |
| `MS:U45` | SPEC-hub-multi-service.md · S14 | L0 | apps/hub-worker/test/normalize-canonical.spec.ts:33 | chưa chạy |
| `MS:U46` | SPEC-hub-multi-service.md · S8 | L0 | libs/providers/test/generic.adapter.spec.ts:138 | chưa chạy |
| `MS:U47` | SPEC-hub-multi-service.md · S8 | L0 | libs/providers/test/generic.adapter.spec.ts:146 | chưa chạy |
| `MS:U48` | SPEC-hub-multi-service.md · S8 | L0 | libs/providers/test/generic.adapter.spec.ts:158<br>libs/providers/test/generic.adapter.spec.ts:218 | chưa chạy |
| `MS:U49` | SPEC-hub-multi-service.md · S4 | L0 | apps/hub-api/test/publish-canonical.spec.ts:31 | chưa chạy |
| `MS:U50` | SPEC-hub-multi-service.md · S14 | L0 | libs/providers/test/canonical-contract.spec.ts:9 | chưa chạy |
| `PK:T1` | SPEC-provider-khac.md · PK0 | L0 | apps/hub-api/test/ingest-segment.spec.ts:13 | chưa chạy |
| `PK:T2` | SPEC-provider-khac.md · PK0 | L0 | apps/hub-api/test/penalty-gate.spec.ts:154<br>apps/hub-api/test/penalty-gate.spec.ts:287 | chưa chạy |
| `PK:T3` | SPEC-provider-khac.md · PK1 | L0 | libs/crypto/test/standard-webhooks.spec.ts:36<br>libs/crypto/test/standard-webhooks.spec.ts:48<br>libs/providers/test/generic.adapter.spec.ts:69<br>libs/providers/test/generic.adapter.spec.ts:207 | chưa chạy |
| `PK:T4` | SPEC-provider-khac.md · PK1 | L0 | apps/hub-api/test/console-source-inspect.spec.ts:11 | chưa chạy |
| `PK:T5` | SPEC-provider-khac.md · PK1 | L0 | apps/web/src/lib/hub/listen-logic.spec.ts:75 | chưa chạy |
| `PK:T6` | SPEC-provider-khac.md · PK2 | L0 | libs/providers/test/generic-hmac-matrix.spec.ts:36 | chưa chạy |
| `PK:T7` | SPEC-provider-khac.md · PK2 | L0 | apps/hub-api/test/ingest-generic.spec.ts:89 | chưa chạy |
| `PK:T8` | SPEC-provider-khac.md · PK3 | L0 | apps/hub-api/test/service-sources.spec.ts:98<br>libs/providers/test/generic-signed-template.spec.ts:325<br>libs/providers/test/generic-signed-template.spec.ts:388<br>libs/providers/test/generic-signed-template.spec.ts:397 | chưa chạy |
| `PK:T9` | SPEC-provider-khac.md · PK3 | L0 | libs/providers/test/generic-signed-template.spec.ts:176<br>libs/providers/test/generic-signed-template.spec.ts:448<br>libs/providers/test/generic-signed-template.spec.ts:470 | chưa chạy |
| `PK:T10` | SPEC-provider-khac.md · PK4 | L0 | apps/hub-api/test/ingest-handshake.spec.ts:124<br>apps/hub-api/test/ingest-handshake.spec.ts:433<br>apps/hub-api/test/ingest-handshake.spec.ts:452<br>apps/hub-api/test/ingest-handshake.spec.ts:570<br>apps/hub-api/test/ingest-handshake.spec.ts:624<br>apps/hub-api/test/ingest-handshake.spec.ts:750<br>apps/hub-api/test/redis-budget.spec.ts:496<br>apps/hub-api/test/source-response-redact.spec.ts:72<br>apps/web/src/lib/hub/listen-logic.spec.ts:138 | chưa chạy |
| `PK:T11` | SPEC-provider-khac.md · PK4 | L0 | apps/hub-api/test/ingest-handshake-http.spec.ts:40<br>apps/hub-api/test/ingest-handshake.spec.ts:276<br>apps/hub-api/test/ingest-handshake.spec.ts:662<br>apps/hub-api/test/ingest-handshake.spec.ts:731<br>libs/providers/test/generic-handshake.spec.ts:64 | chưa chạy |
| `PK:T12` | SPEC-provider-khac.md · PK4 | L0 | apps/hub-api/test/ingest-handshake.spec.ts:332<br>libs/providers/test/generic-handshake.spec.ts:13 | chưa chạy |
| `PK:T13` | SPEC-provider-khac.md · PK4 | L0 | apps/hub-api/test/ingest-handshake.spec.ts:381 | chưa chạy |
| `PK:T14` | SPEC-provider-khac.md · PK5 | L0,L1 | apps/hub-api/test/ingest-unverified.spec.ts:71<br>apps/hub-api/test/ingest-unverified.spec.ts:91<br>apps/hub-api/test/ingest-unverified.spec.ts:240<br>apps/hub-api/test/ingest-unverified.spec.ts:256<br>apps/hub-api/test/redis-budget.spec.ts:526<br>apps/hub-api/test/unverified-access.spec.ts:119<br>apps/hub-api/test/unverified-db.spec.ts:46<br>apps/web/src/lib/hub/unverified.spec.ts:113<br>libs/providers/test/generic-unverified.spec.ts:84<br>libs/providers/test/generic-unverified.spec.ts:192 | chưa chạy |
| `PK:T15` | SPEC-provider-khac.md · PK5 | L0 | apps/hub-api/test/ingest-unverified.spec.ts:171<br>apps/hub-worker/test/normalize-unverified.spec.ts:102<br>libs/providers/test/generic-unverified.spec.ts:31 | chưa chạy |
| `PK:T16` | SPEC-provider-khac.md · PK5 | L0 | apps/hub-api/test/flow-unverified.spec.ts:63<br>apps/hub-api/test/flow-unverified.spec.ts:74<br>apps/hub-api/test/flow-unverified.spec.ts:81<br>apps/hub-worker/test/delivery-unverified.spec.ts:78<br>apps/hub-worker/test/delivery-unverified.spec.ts:86<br>apps/hub-worker/test/normalize-unverified.spec.ts:72<br>apps/hub-worker/test/normalize-unverified.spec.ts:82<br>apps/hub-worker/test/normalize-unverified.spec.ts:129<br>apps/web/src/components/flow/event-notes.spec.ts:267<br>apps/web/src/lib/hub/unverified.spec.ts:17<br>apps/web/src/lib/hub/unverified.spec.ts:25<br>apps/web/src/lib/hub/unverified.spec.ts:40<br>apps/web/src/lib/hub/unverified.spec.ts:65<br>apps/web/src/lib/hub/unverified.spec.ts:82<br>libs/common/test/flow/build-event-flow.spec.ts:363<br>libs/common/test/flow/build-event-flow.spec.ts:379<br>libs/common/test/flow/build-event-flow.spec.ts:384<br>libs/providers/test/generic-unverified.spec.ts:231 | chưa chạy |
| `PK:T17` | SPEC-provider-khac.md · PK5 | L0 | apps/hub-api/test/ingest-unverified.spec.ts:139<br>libs/hub-sdk/test/unverified.spec.ts:12<br>libs/providers/test/generic-unverified.spec.ts:154<br>libs/providers/test/generic-unverified.spec.ts:167 | chưa chạy |
| `PK:T18` | SPEC-provider-khac.md · PK5 | L0 | apps/hub-api/test/ingest-unverified.spec.ts:197 | chưa chạy |
| `PK:T19` | SPEC-provider-khac.md · PK9 | L0 | libs/providers/test/catalog-identify.spec.ts:25 | chưa chạy |
| `PK:T20` | SPEC-provider-khac.md · PK9 | L0 | libs/providers/test/catalog-identify.spec.ts:83 | chưa chạy |
| `PK:T21` | SPEC-provider-khac.md · PK9 | L0 | libs/providers/test/catalog-identify.spec.ts:113 | chưa chạy |
| `PK:T22` | SPEC-provider-khac.md · PK9 | L0 | libs/providers/test/catalog-identify.spec.ts:175 | chưa chạy |
| `PK:T23` | SPEC-provider-khac.md · PK9 | L0 | libs/providers/test/catalog-identify.spec.ts:204 | chưa chạy |
| `PK:T33` | SPEC-provider-khac.md · PK0 | L0 | apps/hub-api/test/body-limit.spec.ts:161<br>apps/hub-api/test/ingest-controller.spec.ts:10 | chưa chạy |
| `PK:T35` | SPEC-provider-khac.md · PK4 | L0 | apps/hub-api/test/ingest-handshake.spec.ts:232<br>apps/hub-api/test/ingest-handshake.spec.ts:502 | chưa chạy |
| `PK:T36` | SPEC-provider-khac.md · PK5 | L0,L1 | apps/hub-api/test/unverified-access.spec.ts:33<br>apps/hub-api/test/unverified-access.spec.ts:43<br>apps/hub-api/test/unverified-access.spec.ts:79<br>apps/hub-api/test/unverified-access.spec.ts:143<br>apps/hub-api/test/unverified-db.spec.ts:57<br>apps/hub-api/test/unverified-db.spec.ts:71<br>apps/web/src/lib/hub/unverified.spec.ts:127<br>libs/hub-sdk/test/unverified.spec.ts:57 | chưa chạy |
| `PK:T37` | SPEC-provider-khac.md · PK5 | L0,L1 | apps/hub-api/test/ingest-unverified.spec.ts:105<br>apps/hub-api/test/unverified-db.spec.ts:83<br>apps/hub-worker/test/normalize-unverified.spec.ts:94 | chưa chạy |
| `PK:T38` | SPEC-provider-khac.md · PK5 | L0 | apps/hub-api/test/ingest-unverified.spec.ts:114<br>apps/hub-api/test/ingest-unverified.spec.ts:126<br>apps/hub-api/test/ingest-unverified.spec.ts:264<br>libs/providers/test/generic-unverified.spec.ts:97<br>libs/providers/test/generic-unverified.spec.ts:121<br>libs/providers/test/generic-unverified.spec.ts:200<br>libs/providers/test/generic-unverified.spec.ts:216 | chưa chạy |
| `PK:T40` | SPEC-provider-khac.md · PK10 | L0 | apps/hub-api/test/ingest-idempotency-pk10.spec.ts:11<br>apps/web/src/lib/hub/listen-logic.spec.ts:544<br>libs/providers/test/generic-idempotency.spec.ts:39<br>libs/providers/test/generic-idempotency.spec.ts:119 | chưa chạy |
| `PK:T41` | SPEC-provider-khac.md · PK10 | L0 | libs/providers/test/generic-idempotency.spec.ts:259<br>libs/providers/test/generic-idempotency.spec.ts:288 | chưa chạy |
| `QT:T1` | SPEC-han-muc-dung-luong.md · QT1 | L0 | libs/common/test/storage-level.spec.ts:18 | chưa chạy |
| `QT:T2` | SPEC-han-muc-dung-luong.md · QT3 | L0 | apps/hub-api/test/storage-lock.spec.ts:84 | chưa chạy |
| `QT:T3` | SPEC-han-muc-dung-luong.md · QT3 | L0 | apps/hub-api/test/storage-lock.spec.ts:102<br>apps/hub-api/test/storage-lock.spec.ts:117 | chưa chạy |
| `QT:T4` | SPEC-han-muc-dung-luong.md | L0 | verify/test/gates.spec.ts:63 | chưa chạy |
| `QT:T5` | SPEC-han-muc-dung-luong.md · QT3 | L0 | apps/hub-api/test/storage-lock.spec.ts:138 | chưa chạy |
| `QT:T6` | SPEC-han-muc-dung-luong.md · QT3 | L0 | apps/hub-api/test/storage-lock.spec.ts:204 | chưa chạy |
| `QT:T7` | SPEC-han-muc-dung-luong.md · QT3 | L0,L1 | apps/hub-api/test/storage-lock.spec.ts:213<br>libs/database/test/storage-quota-db.spec.ts:53 | chưa chạy |
| `QT:T8` | SPEC-han-muc-dung-luong.md · QT3 | L0 | apps/hub-api/test/storage-lock.spec.ts:179 | chưa chạy |
| `QT:T9` | SPEC-han-muc-dung-luong.md · QT4 | L0,L1 | apps/hub-api/test/storage-api.spec.ts:79<br>libs/common/test/storage-clean.spec.ts:20<br>libs/database/test/storage-clean-db.spec.ts:108 | chưa chạy |
| `QT:T10` | SPEC-han-muc-dung-luong.md · QT4 | L0,L1 | apps/hub-api/test/storage-api.spec.ts:93<br>apps/hub-worker/test/storage-clean-runner.spec.ts:66<br>libs/database/test/storage-clean-db.spec.ts:178 | chưa chạy |
| `QT:T11` | SPEC-han-muc-dung-luong.md · QT6 | L0 | apps/hub-worker/test/storage-alerts.spec.ts:164<br>libs/common/test/storage-alerts.spec.ts:50 | chưa chạy |
| `QT:T12` | SPEC-han-muc-dung-luong.md · QT2 | L0 | apps/hub-worker/test/storage-job.spec.ts:75<br>apps/hub-worker/test/storage-job.spec.ts:262 | chưa chạy |
| `QT:T13` | SPEC-han-muc-dung-luong.md · QT1 | L1 | libs/database/test/storage-quota-db.spec.ts:34 | chưa chạy |
| `QT:T14` | SPEC-han-muc-dung-luong.md · QT2 | L0 | apps/hub-worker/test/storage-alerts.spec.ts:221<br>apps/hub-worker/test/storage-job.spec.ts:162<br>libs/common/test/storage-usage.spec.ts:47 | chưa chạy |
| `QT:T15` | SPEC-han-muc-dung-luong.md · QT4 | L1 | libs/database/test/storage-clean-db.spec.ts:66 | chưa chạy |
| `QT:T16` | SPEC-han-muc-dung-luong.md · QT4 | L1 | libs/database/test/storage-clean-db.spec.ts:95 | chưa chạy |
| `QT:T17` | SPEC-han-muc-dung-luong.md · QT1 | L0,L1 | libs/common/test/storage-level.spec.ts:92<br>libs/database/test/storage-clean-db.spec.ts:150 | chưa chạy |
| `QT:T18` | SPEC-han-muc-dung-luong.md · QT5 | L0,L1 | apps/hub-api/test/storage-policies.spec.ts:57<br>apps/hub-worker/test/auto-clean.spec.ts:47<br>apps/hub-worker/test/auto-clean.spec.ts:130<br>libs/database/test/storage-auto-clean-db.spec.ts:33 | chưa chạy |
| `QT:T19` | SPEC-han-muc-dung-luong.md · QT6 | L1,L0 | apps/hub-worker/test/storage-alerts-db.spec.ts:84<br>apps/hub-worker/test/storage-alerts.spec.ts:119<br>libs/providers/test/canonical-contract.spec.ts:83 | chưa chạy |
| `QT:T20` | SPEC-han-muc-dung-luong.md · QT4 | L0,L1 | apps/hub-api/test/replay-message.spec.ts:54<br>apps/hub-api/test/storage-console.spec.ts:25<br>libs/database/test/storage-clean-db.spec.ts:167 | chưa chạy |
| `QT:T21` | SPEC-han-muc-dung-luong.md · QT4b | L0 | libs/common/test/cleanup-advisor.spec.ts:43 | chưa chạy |
| `QT:T22` | SPEC-han-muc-dung-luong.md · QT4b | L0 | apps/hub-worker/test/cleanup-suggested.spec.ts:56<br>libs/common/test/cleanup-advisor.spec.ts:64 | chưa chạy |
| `QT:T23` | SPEC-han-muc-dung-luong.md · QT4b | L0 | apps/hub-worker/test/cleanup-suggested.spec.ts:74<br>libs/common/test/cleanup-advisor.spec.ts:98 | chưa chạy |
| `QT:T24` | SPEC-han-muc-dung-luong.md · QT4b | L0 | apps/hub-api/test/publish-canonical.spec.ts:42<br>apps/hub-worker/test/cleanup-suggested.spec.ts:84<br>apps/hub-worker/test/cleanup-suggested.spec.ts:124<br>apps/hub-worker/test/normalize-canonical.spec.ts:124<br>libs/common/test/cleanup-advisor.spec.ts:113<br>libs/common/test/cleanup-advisor.spec.ts:124<br>libs/providers/test/canonical-contract.spec.ts:62 | chưa chạy |
| `QT:T25` | SPEC-han-muc-dung-luong.md · QT4b | L0 | apps/hub-api/test/storage-apply.spec.ts:53<br>apps/hub-api/test/storage-apply.spec.ts:63<br>apps/hub-api/test/storage-apply.spec.ts:73<br>apps/hub-api/test/storage-apply.spec.ts:86 | chưa chạy |
| `QT:T26` | SPEC-han-muc-dung-luong.md · QT1 | L0,L1 | libs/common/test/storage-level.spec.ts:119<br>libs/database/test/storage-quota-db.spec.ts:70<br>libs/database/test/storage-quota-db.spec.ts:80 | chưa chạy |
| `QT:T27` | SPEC-han-muc-dung-luong.md · QT9 | L1,L0 | apps/hub-api/test/source-limit-db.spec.ts:35<br>apps/hub-api/test/source-limit.spec.ts:11<br>apps/hub-api/test/source-limit.spec.ts:32 | chưa chạy |
| `QT:T28` | SPEC-han-muc-dung-luong.md · QT1 | L0 | libs/common/test/storage-level.spec.ts:50 | chưa chạy |
| `QT:T29` | SPEC-han-muc-dung-luong.md · QT3 | L0 | apps/hub-api/test/storage-lock.spec.ts:147 | chưa chạy |
| `QT:T30` | SPEC-han-muc-dung-luong.md · QT3 | L0 | apps/hub-api/test/storage-lock.spec.ts:164<br>apps/hub-api/test/storage-policies.spec.ts:42<br>apps/hub-worker/test/auto-clean.spec.ts:95<br>apps/web/src/lib/storage/storage-logic.spec.ts:17<br>libs/common/test/storage-alerts.spec.ts:92<br>libs/common/test/storage-clean.spec.ts:79<br>libs/common/test/storage-level.spec.ts:77 | chưa chạy |
| `QT:T31` | SPEC-han-muc-dung-luong.md · QT2 | L0,L1 | apps/hub-api/test/storage-bytes.spec.ts:26<br>apps/hub-api/test/storage-bytes.spec.ts:74<br>libs/database/test/storage-measure-db.spec.ts:36 | chưa chạy |
| `QT:T32` | SPEC-han-muc-dung-luong.md · QT2 | L0,L1 | apps/hub-worker/test/storage-job.spec.ts:95<br>apps/hub-worker/test/storage-job.spec.ts:127<br>apps/hub-worker/test/storage-job.spec.ts:181<br>apps/hub-worker/test/storage-job.spec.ts:223<br>libs/common/test/storage-usage.spec.ts:19<br>libs/database/test/storage-measure-db.spec.ts:45<br>libs/database/test/storage-measure-db.spec.ts:73 | chưa chạy |
| `QT:T33` | SPEC-han-muc-dung-luong.md · QT4 | L0,L1 | apps/hub-worker/test/auto-clean.spec.ts:141<br>apps/hub-worker/test/storage-clean-runner.spec.ts:92<br>apps/hub-worker/test/storage-job.spec.ts:248<br>libs/database/test/storage-auto-clean-db.spec.ts:47<br>libs/database/test/storage-clean-db.spec.ts:124<br>libs/database/test/storage-orphan-db.spec.ts:46<br>libs/database/test/storage-orphan-db.spec.ts:103 | chưa chạy |
| `QT:T34` | SPEC-han-muc-dung-luong.md · QT6 | L1,L0 | apps/hub-api/test/storage-alerts-owner-db.spec.ts:45<br>apps/hub-api/test/storage-alerts-owner.spec.ts:59<br>apps/hub-api/test/storage-alerts-owner.spec.ts:114<br>libs/common/test/storage-alerts.spec.ts:24 | chưa chạy |
| `SK:T1` | SPEC-shop-ket-noi-project.md | — | — | mồ côi có lý do: L2 trên hubv chưa chạy: cần rebuild image hub-api/shop/web của hubv với code SK (phiên dev không được rebuild/restart container). Phủ ở L0 settings.spec [SK:U1]-[SK:U5], L1 settings-db.spec [SK:U4] + GRANT shop_user, console-projects-db.spec [SK:U6]. Kịch bản tay: HUONG-DAN-TEST-TINH-HUONG Kịch bản 10. |
| `SK:U1` | SPEC-shop-ket-noi-project.md · SK2 | L0 | apps/shop/test/settings.spec.ts:134<br>apps/shop/test/settings.spec.ts:252 | chưa chạy |
| `SK:U2` | SPEC-shop-ket-noi-project.md · SK2 | L0 | apps/shop/test/settings.spec.ts:98<br>apps/shop/test/settings.spec.ts:112<br>apps/shop/test/settings.spec.ts:298<br>apps/shop/test/settings.spec.ts:316 | chưa chạy |
| `SK:U3` | SPEC-shop-ket-noi-project.md · SK2 | L1,L0 | apps/shop/test/settings-db.spec.ts:41<br>apps/shop/test/settings.spec.ts:162<br>apps/shop/test/settings.spec.ts:184<br>apps/shop/test/settings.spec.ts:213<br>apps/shop/test/settings.spec.ts:225<br>apps/shop/test/settings.spec.ts:389<br>apps/shop/test/settings.spec.ts:407 | chưa chạy |
| `SK:U4` | SPEC-shop-ket-noi-project.md · SK2 | L1,L0 | apps/shop/test/settings-db.spec.ts:27<br>apps/shop/test/settings.spec.ts:123 | chưa chạy |
| `SK:U5` | SPEC-shop-ket-noi-project.md · SK2 | L0 | apps/shop/test/settings.spec.ts:266<br>apps/shop/test/settings.spec.ts:375<br>apps/shop/test/settings.spec.ts:429 | chưa chạy |
| `SK:U6` | SPEC-shop-ket-noi-project.md · SK1 | L1,L0 | apps/hub-api/test/console-projects-db.spec.ts:130<br>apps/web/src/lib/hub/keys-logic.spec.ts:28 | chưa chạy |
| `SK:U7` | SPEC-shop-ket-noi-project.md · SK4 | L0 | apps/web/src/lib/shop/order-status.spec.ts:66<br>apps/web/src/lib/shop/order-status.spec.ts:71 | chưa chạy |
| `VF:VT1` | SPEC-verification.md · VF2 | L0 | verify/test/results.spec.ts:19 | chưa chạy |
| `VF:VT2` | SPEC-verification.md · VF2 | L0 | verify/test/results.spec.ts:32 | chưa chạy |
| `VF:VT3` | SPEC-verification.md · VF2 | L0 | verify/test/map.spec.ts:38 | chưa chạy |
| `VF:VT4` | SPEC-verification.md · VF2 | L0 | verify/test/map.spec.ts:46 | chưa chạy |
| `VF:VT5` | SPEC-verification.md · VF3 | L0 | tools/hub-sim/test/hub-sim.spec.ts:18<br>tools/hub-sim/test/hub-sim.spec.ts:29<br>tools/hub-sim/test/hub-sim.spec.ts:40<br>tools/hub-sim/test/hub-sim.spec.ts:47 | chưa chạy |
| `VF:VT6` | SPEC-verification.md · VF3 | L0,L2 | verify/test/hub-sim-adapters.spec.ts:39<br>verify/scenarios/ingest-e2e.ts:94 | chưa chạy |
| `VF:VT7` | SPEC-verification.md · VF7 | L0 | verify/test/gates.spec.ts:12 | chưa chạy |
| `VF:VT8` | SPEC-verification.md · VF1 | L2* | verify/scenarios/stack-isolation.ts:32 | chưa chạy |
| `VF:VT9` | SPEC-verification.md · VF1 | L2* | verify/scenarios/stack-isolation.ts:42 | chưa chạy |
| `VF:VT10` | SPEC-verification.md · VF6 | L0 | verify/test/probe.spec.ts:8 | chưa chạy |
| `VF:VT11` | SPEC-verification.md · VF6 | — | — | mồ côi có lý do: Chứng minh bằng chính lệnh `npm run verify:probe -- --all` (bảng probe + kiểm VT11: đột biến không rò ra cây thật, không worktree sót) — job CI `probe` chạy đêm (riêng, không phụ thuộc chaos); con số --all theo luật phán mới (đối chứng + đỏ đúng lý do, H-1/L-R2-1) chờ lượt `--all` đầu tiên, chưa có |
| `VF:VT12` | SPEC-verification.md · VF6 | — | — | mồ côi có lý do: Probe P-VT12-01 (ownerAsApp): chạy rls-db.spec bằng DATABASE_URL owner → [AU:TA12][BB:5] (phần a) đỏ ở assert tiền đề; kiểm bằng verify:probe, không phải tên test |
| `VF:VT13` | SPEC-verification.md · VF1 | L0 | libs/common/test/test-only-config.spec.ts:8 | chưa chạy |
| `VF:VT14` | SPEC-verification.md · VF8 | — | — | mồ côi có lý do: demo:reset --env deployed CHƯA có (cần API operator xoá dữ liệu production — CAN-ADMIN-QUYET-VF Q4); lệnh hiện từ chối, không xoá gì |
| `VF:VT15` | SPEC-verification.md · VF7 | — | — | mồ côi có lý do: Cần push + GitHub Actions thật + branch protection trên main; phiên này không push (chạy tay từng bước job ở local) |

## File test (258 file, 1826 khai báo it/test)

Test không ứng với dòng spec nào thì không mang mã (§3.1) — vẫn chạy ở L0/L1 và được bánh cóc đếm.
