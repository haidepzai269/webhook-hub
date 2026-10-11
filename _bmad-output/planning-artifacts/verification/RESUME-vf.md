# RESUME — phiên DEV "C rồi A" (C-1 + VF3→VF4→VF5→VF6→VF8)

Người kế nhiệm: đọc file này trước. Luật: CLAUDE.md, SPEC-verification §6. Một story một commit, stage theo đường dẫn, không push.
Song song: một dev agent khác làm DX trên CÙNG cây (libs/common toWebhookBody/error catalog, WebhookSender, libs/hub-sdk bin/hub.js,
polling `after=latest` trong service-resources.controller.ts, docs/ERRORS.md, docs/QUICKSTART.md, examples/) — KHÔNG sửa các file đó.
`verify/baseline.json` và `docs/TEST-MAP.md` là file sinh ra, bị cả hai phiên chạm — KHÔNG stage (số gồm cả test chưa commit của phiên kia).

## Đã xong

| Bước | Commit | Ghi chú |
|---|---|---|
| C-1 verify endpoint thất bại im lặng | `72ee8a7` | ADR-131. Audit mọi đường FAILED (create/verify/rotate/adopt), chống spam = audit verify mới nhất trong 1h cùng mã+attempt thì bỏ. Repo: `findLatestAuditForEntity`. 7 test mới trong `apps/hub-api/test/service-resources.spec.ts` |
| VF3 hub-sim | (xem git log) | ADR-132. `tools/hub-sim/{cli.ts,src/,fixtures/,test/}`, `verify/test/hub-sim-adapters.spec.ts`, script `hub-sim`, `.env.verify` thêm SIM_STRIPE_SECRET/SIM_GENERIC_SECRET. Fixture sinh một lần bằng script nháp (không commit) — fixture JSON là nguồn sự thật |

## Đang làm / tiếp theo

- VF4 runner L2 TS (thay e2e-smoke.sh), tag smoke/@deployed-safe, [VF:VT6] phần b (Stripe cũ → 401 qua HTTP; cần tạo source stripe + generic với SIM_* secret).
