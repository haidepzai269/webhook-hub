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

| VF5 L3 chaos | (xem git log) | ADR-137. `npm run verify:chaos [-- --tag chaos-pg]`, `verify/scenarios/chaos-l3.ts`. 6/0/0 ~5 phút. docker gọi bằng `spawn` (không spawnSync) để luồng request vẫn bay lúc phá |

## Đang làm / tiếp theo

- VF6 `verify:probe` (git worktree tạm, áp `find/replace`, chạy tầng, kiểm `expectRed` đỏ) + 12 probe §6.3 + `verify:bb`. Đã có sẵn 27 file `verify/probes/*.json` (P-AU-*, P-BB5-01/02, P-MS-*) nhưng CHƯA có runner — kiểm định dạng của chúng trước.
