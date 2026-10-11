# RESUME — phiên DEV "C rồi A" (C-1 + VF3→VF4→VF5→VF6→VF8)

Người kế nhiệm: đọc file này trước. Luật: CLAUDE.md, SPEC-verification §6. Một story một commit, stage theo đường dẫn, không push.
Song song: một dev agent khác làm DX trên CÙNG cây (libs/common toWebhookBody/error catalog, WebhookSender, libs/hub-sdk bin/hub.js,
polling `after=latest` trong service-resources.controller.ts, docs/ERRORS.md, docs/QUICKSTART.md, examples/) — KHÔNG sửa các file đó.
`verify/baseline.json` và `docs/TEST-MAP.md` là file sinh ra, bị cả hai phiên chạm — KHÔNG stage (số gồm cả test chưa commit của phiên kia).

## Đã xong

| Bước | Commit | Ghi chú |
|---|---|---|
| C-1 verify endpoint thất bại im lặng | `72ee8a7` | ADR-131. Audit mọi đường FAILED (create/verify/rotate/adopt), chống spam = audit verify mới nhất trong 1h cùng mã+attempt thì bỏ. Repo: `findLatestAuditForEntity`. 7 test mới trong `apps/hub-api/test/service-resources.spec.ts` |
| VF3 hub-sim | `df4e65e` | ADR-132. `tools/hub-sim/{cli.ts,src/,fixtures/,test/}`, `verify/test/hub-sim-adapters.spec.ts`, script `hub-sim`, `.env.verify` thêm SIM_STRIPE_SECRET/SIM_GENERIC_SECRET. Fixture sinh một lần bằng script nháp (không commit) — fixture JSON là nguồn sự thật |

| VF4 runner L2 | `e4566db` | ADR-135. `npm run verify:e2e [-- --tag smoke]`, `verify/lib/{scenario,e2e-world,e2e-runner}.ts`, `verify/scenarios/ingest-e2e.ts`; auth-e2e chạy như tiến trình con; e2e-smoke.sh = vỏ. Full L2 25/0/0 |

| VF5 L3 chaos | `9a3ce40` | ADR-137. `npm run verify:chaos [-- --tag chaos-pg]`, `verify/scenarios/chaos-l3.ts`. 6/0/0 ~5 phút. docker gọi bằng `spawn` (không spawnSync) để luồng request vẫn bay lúc phá |

| VF6 probe + bb | `d0b84b7` | ADR-147. `verify:probe`, `verify:bb`, 8 probe mới, 35/35 đúng kỳ vọng. ~2,5 phút/probe → `--all` ~1,5 giờ (chạy nền) |

| VF8 demo + CI | `9000a53` | ADR-148. steps.yaml, demo.ts, seed-demo.ts, PREFLIGHT, RUNBOOK, FOR-EXAMINERS, CI e2e+chaos |

## Đang làm / tiếp theo

- HẾT danh sách C-1 + VF3→VF8. ADR-147 + ADR-148 đã commit riêng (docs(adr)) sau khi phiên KN commit ADR-146.
- `verify/baseline.json` không commit phần L0/L2 tăng (gồm test chưa commit của phiên khác); HEAD có L2=25, L3=6.
- Luật commit (coordinator): CHỈ `git commit -m … -- <paths>`; file mới phải `git add` trước. Không amend/reset/rebase.
- Câu hỏi Admin: `CAN-ADMIN-QUYET-VF.md` Q1–Q4.

## Vòng sửa review REVIEW-VF-2026-10-11 (GO-with-fixes)

| Mục | Commit | Ghi chú |
|---|---|---|
| H-1 + L-6 | `111e930` | Probe có lượt ĐỐI CHỨNG (code chưa phá phải xanh + test phụ kiểm mọi `@hub/*` phân giải vào worktree) và `expectFailure` (đỏ đúng lý do; không khai thì lỗi môi trường bị loại). Ctrl-C dọn worktree; đầu lượt dọn `probe-P-*` của pid chết. Mẫu: P-SIG-01/02, P-VT12-01, P-BB3-01, P-BB2-01 ✅; P-BB5-02 với mật khẩu DB sai → ⚠ INVALID |
| M-1, M-2, M-3, M-6, L-4 | `c6fa735` | Sửa: dòng RED trong message commit này SAI — `local-url.spec` được viết SAU guard, không chạy đỏ trước. |
| M-5 | `8d872ee` | CI: job `probe` riêng (240'), concurrency đêm riêng |
| L-7, L-3 | `9d8ab7c` | RUNBOOK, PREFLIGHT |
| M-4 | `113db81` | verify:bb cột L2/L3 từ `.last-run.json` |

Phân giải `@hub/*` trong worktree probe: jest `moduleNameMapper` (`<rootDir>/libs/*/src`, rootDir = worktree) → vào worktree, KHÔNG về link workspace `node_modules/@hub` của cây chính. Đã kiểm bằng `require.resolve('@hub/database')` trong worktree và giờ là điều kiện của lượt đối chứng. Không dùng junction/symlink.

Còn mở (Low, chưa làm):
- L-1: probe đột biến HEAD còn `verify:bb` đo cây làm việc — chưa từ chối khi `p.file`/test đích bẩn so với HEAD.
- L-2: đổi tên test "VF3 (§5.4, P-SIG-02)" trong hub-sim-adapters; thêm P-SIG-03/04 (Stripe, generic).
- L-5: chaos đếm số lần sink nhận mỗi `webhook-id` (at-least-once phía nhận).
- L-8: `seed-fresh-db` / `poll-seq-migration-db` chết lúc nạp khi không có env (không thuộc VF).
- Probe AU/MS/KN chưa có `expectFailure` riêng — dựa vào bộ lọc lý do môi trường mặc định (`WRONG_REASON`, có `TypeError`): probe nào mà assert đúng tự nó là TypeError sẽ bị báo "đỏ sai lý do" → khai `expectFailure`. Chưa chạy `--all` sau H-1 (~3 giờ).
- `verify/baseline.json` cây làm việc L0 = số của lượt review (gồm test chưa commit của phiên khác) — KHÔNG commit.

## Vòng sửa REVIEW-VF-R2-2026-10-11 (GO-with-fixes)

| Mục | Commit | Ghi chú |
|---|---|---|
| M-R2-1, L-R2-3, L-R2-1 | `acf6c44` | `verify/lib/last-run.ts`: at+commit TRONG từng tầng; `verify:bb` đọc commit của tầng, cảnh báo KHÁC HEAD; bản ghi cũ không có commit tầng -> "commit không rõ". VT11 chỉ đếm worktree `probe-P-*-<pid>` của chính lượt hoặc pid chết. judgeProbe: khớp `expectFailure` **VÀ** không khớp `WRONG_REASON` (miễn bằng `allowEnvReason`, chưa probe nào khai) — chọn hướng chặt; FOR-EXAMINERS khớp |
| M-R2-2 | `f92173d` | `auth-e2e.ts` gọi `assertLocalOrExit` (thoát 2, không ngoại lệ VERIFY_DEPLOYED); `isLocalUrl` chỉ nhận `hubv-…` một nhãn DNS (`/^hubv-[a-z0-9]+(-[a-z0-9]+)*$/`) |
| L-R2-2, L-R2-4, L-R2-6 | `4c05481` | Lý do VT11 trong `verify/spec-sources.json` (bỏ "35/35", nêu job `probe`); `docs/TEST-MAP.md` đã sinh lại bằng `verify:map` nhưng KHÔNG commit (diff gồm trạng thái phiên khác). demo-redeliver assert xoá ≥ 1 khoá `idem:*` trước lần 2 (lần 3 có thể 0: bản trùng do PG phán không ghi lại khoá). `workflow_dispatch` nhóm concurrency `manual`, không cancel |

RED trước: `last-run.spec` (module chưa có), `probe.spec` (export chưa có, ECONNREFUSED + expectFailure còn được nhận), `local-url.spec` (hubv.evil.com nhận; auth-e2e thoát 1).
Đã chạy: `npx jest verify/test -w 2` 69/69 · `verify:gates` 0 vi phạm · `verify:e2e --tag demo-redeliver` 1/1 · `verify:probe P-SIG-02 P-BB2-01` 2/2 ✅, VT11 sạch.

Còn mở: L-R2-5 (chấp nhận), L-R2-7 (guard host DB/Redis L1), guard host `VERIFY_REDIS_URL` (phần 2 của L-R2-4), `--all` theo luật phán mới chưa chạy, L-1/L-2/L-5/L-8 vòng 1. `.last-run.json` cũ: L0/L1/L3 chưa có commit tầng tới khi chạy lại.
